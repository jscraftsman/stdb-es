# SQL recipes and operations

`es_stream`, `es_event`, and `es_head` are **private**. That is deliberate: private tables never
reach a client, so the only way to read them is as the database owner, with `spacetime sql`.

This page is the operator's toolbox: inspect a stream, time-travel, compare a state cache with the
log, and recover safely. Every query here was run against a live `spacetimedb` 2.15.0 database.
Nothing here is a write path.

> **Rule of thumb: read with SQL, write with reducers.** Hand-editing `es_event`, `es_stream`, or
> `es_head` bypasses dedupe, the version guard, the head counter, and every projection. There is no
> supported repair by editing rows.

## Running queries

```bash
# Owner identity: private tables are visible.
spacetime sql stdb-es-counter -s local "SELECT stream_id, version FROM es_stream"

# Machine-readable: array of statements, each with schema.elements[].name.some and rows[][]
spacetime sql stdb-es-counter -s local --format json "SELECT stream_id, version FROM es_stream"

# Anonymous identity: public views only, never es_* tables.
spacetime sql stdb-es-counter -s local --anonymous "SELECT * FROM counter_summary"
```

`-s` must come before the query. For reducers the same is true, and `-s` must also come before
`--`: `spacetime call stdb-es-counter increment -s local -- '1' 1 'cmd-1'`. The counter example's
command reducer takes `counterId`, `by`, then `commandId` in that order.

## What server-side SQL supports

Verified on 2.15.0. SpacetimeDB's SQL is a subset of Postgres; do not assume the rest.

| Works | Does not work |
| --- | --- |
| `SELECT` explicit columns or `*` | `ORDER BY` |
| `WHERE` with `=`, `<>`, `<`, `<=`, `>`, `>=`, `AND` | `COUNT(*)`, `GROUP BY`, `DISTINCT`, `MAX()`, `MIN()`, `SUM()` |
| Inner `JOIN ... ON` | `LEFT JOIN` (so no anti-join for orphan rows) |
| Column and table aliases (`AS`) | Bare `position` as a selected identifier (it is reserved) |
| `LIMIT` | Subqueries, `IN (SELECT ...)` |
| `DELETE FROM <app cache> WHERE ...` | `BETWEEN` (use two comparisons) |

Two consequences worth internalising:

1. **Rows come back unordered.** Sort by `version` or `position` in your client. `LIMIT` is applied
   before any client sort, so it is only safe when any row will do.
2. **`position` is only selectable via `*` or a table alias.** `SELECT event_id, position FROM
   es_event` fails; `SELECT event_id, e.position FROM es_event e` works.

## The tables

| Table | Key columns | Meaning |
| --- | --- | --- |
| `es_stream` | `stream_id`, `stream_type`, `version`, `created_at`, `updated_at`, `metadata` | Stream catalogue and the concurrency token |
| `es_event` | `event_id`, `position`, `stream_id`, `version`, `event_type`, `data`, `metadata`, `created_at_micros`, `created_by` | Append-only log; `data` is canonical JSON |
| `es_head` | `id` (always `global`), `position` | Single-row gapless position counter |
| app tables | app-defined | State caches and materialized read models, **not** the source of truth |

`version` is 1-based per stream and contiguous. `position` is global, gapless, and commit-ordered.
Neither is a timestamp.

## Recipes

### Stream catalogue

```sql
-- All streams, with their current version.
SELECT stream_id, stream_type, version FROM es_stream;

-- All streams of one aggregate kind.
SELECT stream_id, version FROM es_stream WHERE stream_type = 'Counter';

-- One stream's head, including metadata.
SELECT stream_id, stream_type, version, metadata
FROM es_stream WHERE stream_id = 'counter-1';
```

### Read a stream

```sql
-- Envelope only: cheap, and ordered client-side by version.
SELECT event_id, version, event_type, created_at_micros
FROM es_event WHERE stream_id = 'counter-1';

-- Full rows: the only way to get `position` without an alias.
SELECT * FROM es_event WHERE stream_id = 'counter-1';

-- A version window (inclusive).
SELECT * FROM es_event
WHERE stream_id = 'counter-1' AND version >= 2 AND version <= 5;

-- Everything processed at or before a timestamp (inclusive).
SELECT * FROM es_event
WHERE stream_id = 'counter-1' AND created_at_micros <= 1794895271000000;

-- One event by id: also a cross-stream lookup, because ids are global.
SELECT * FROM es_event WHERE event_id = 'smoke-1';

-- Events of one type, e.g. after a bad deploy. Sort in the client.
SELECT event_id, stream_id, version FROM es_event
WHERE event_type = 'Incremented' LIMIT 50;
```

A batch appended in one transaction shares a timestamp, so **sort by `version`, never by time** if
you care about stream order.

### Time travel

Version bounds and time bounds intersect. To see the log as of version 3:

```sql
SELECT * FROM es_event
WHERE stream_id = 'counter-1' AND version <= 3;
```

To see what the state was, fold those rows with the *same* `evolve` the module uses. In a reducer or
test, prefer the helpers rather than re-implementing the fold:

```ts
readStream(ctx, 'counter-1', { atVersion: 3 });       // rows up to v3
aggregateStream(ctx, 'counter-1', definition);        // state at latest
aggregateStream(ctx, 'counter-1', { ...definition, atVersion: 3 });
```

A timestamp bound is *processing* time (`created_at_micros`). Business time (when an order was
placed, say) belongs in the payload and must be filtered by your own fold.

### Compare a state cache with the log

Same-version comparison, as an inner join:

```sql
SELECT s.stream_id, s.version AS stream_version, c.version AS cache_version
FROM es_stream s JOIN counter_state c ON s.stream_id = c.stream_id
WHERE s.version <> c.version;
```

An empty result means every cache row agrees on *version*. It does not prove the values agree: a
cache can carry the right version and the wrong state, which is exactly what `verifyStreamState` and
`findDrift` detect by replaying and comparing.

Orphan cache rows (a cache with no stream) cannot be found with the usual `LEFT JOIN ... IS NULL`,
because `LEFT JOIN` is unsupported. Diff two lists client-side:

```sql
SELECT stream_id, version FROM es_stream;
SELECT stream_id, version FROM counter_state;
```

…or run `findDrift` from an app-gated admin reducer, which does both the structural check and the
same-version state check.

### Recover a cache row

Deleting a cache row is the supported repair; the log is never touched:

```sql
DELETE FROM counter_state WHERE stream_id = 'counter-1';
```

This is safe **only if the append path rebuilds from the log when the row is missing**. If
`onAppended` starts from `0` whenever it cannot find a cache row, deleting the row corrupts the next
write. The library's `Repository` and the documented example both replay the whole stream in that
case, so the next append restores the cache.

Verify after recovery:

```sql
SELECT * FROM counter_state WHERE stream_id = 'counter-1';
SELECT version, value FROM counter_summary WHERE stream_id = 'counter-1'; -- anonymous view
```

If no append follows, the cache stays absent and a cache-first read replays the stream. That is a
performance cost, not a correctness problem — provided the read path has the same replay fallback.

### Gap hunting and head sanity

```sql
-- Inspect the whole stream, then check that versions are 1..n with no holes.
SELECT * FROM es_event WHERE stream_id = 'counter-1';

-- The head row must equal the largest event position.
SELECT * FROM es_head;
```

If versions have a gap or `es_head.position` is behind the log, stop writing and run the doctor
(`verifyStreamIntegrity`) before anything else. Do not patch rows by hand.

### Read a public view as an anonymous client

```bash
spacetime sql stdb-es-counter -s local --anonymous \
  "SELECT * FROM counter_summary WHERE stream_id = 'counter-1'"
```

If this returns data, an app-owned public view is exposing it. That is a product decision, not a
library default: `stdb-es` ships no views, and every view factory requires an `authorize` predicate.

## Safety rules

1. **Never `INSERT`, `UPDATE`, or `DELETE` store tables.** `es_event`, `es_stream`, and `es_head`
   are written only by `appendToStream`, in one transaction, with dedupe and the version check.
2. **`DELETE` from an app cache is the only safe mutation**, and only when the write path replays on
   a miss. Otherwise use an admin reducer that calls the repository, so the cache is rebuilt with
   the same fold the app uses.
3. **Do not make private tables public** to "just inspect them" from a client. Add an app-owned view
   and a stable authorization rule.
4. **SQL validates nothing.** It is an operator tool, not an API. Reducers validate event ids, batch
   sizes, payload shape, and event types.
5. **A rebuild is a reducer, not a script.** Use `rebuildBatch` in a bounded, app-gated admin
   reducer; it is resumable and rolls back a failing batch atomically.
