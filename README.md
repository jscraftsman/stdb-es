# stdb-es

Event sourcing for [SpacetimeDB](https://spacetimedb.com): a private append-only event log,
optimistic concurrency, stream replay and time travel, aggregates with version-guarded state caches,
and projection tooling — on top of the backend you already deploy.

SpacetimeDB is the whole backend. The module is the application server, reducers are the write path,
and views are the client read path. `stdb-es` adds the event-sourcing half without asking you to run
a second database, a message broker, or a separate read-model store.

> **Status: 0.0.0, pre-release.** The API will change. Requires `spacetimedb >= 2.15 < 3`.
> JSON event payloads are the only implemented mode; typed-enum payloads are designed but not
> shipped yet. TypeScript server modules only.

## Design rules

These are not conventions; the library and its tests are built around them.

1. **The core tables are private.** `es_stream`, `es_event`, and `es_head` never reach a client
   directly. Clients read app-defined views or app-owned read-model tables.
2. **The app owns its schema.** It spreads in `esTables`, declares its state caches and read models,
   and exports its own reducers. The library exports helpers, adapters, and view factories — not a
   module to re-export blindly.
3. **Views are always public, so the library ships none.** It ships factories that *require* an
   `authorize(ctx, streamId)` predicate. An unchecked library view would be a data leak.
4. **A state cache is not a snapshot.** It is a current-state projection written in the same
   transaction as the events it summarizes. Deleting it costs a replay, as long as a missing cache is
   rebuilt from the log rather than treated as empty state.

## Install

```bash
npm install stdb-es spacetimedb
```

`vitest` is an optional peer dependency: only the `stdb-es/testing` entry point needs it.

## Quick start

### 1. Module: tables, append reducer, state cache

```ts
// spacetimedb/src/index.ts
import { schema, t, table } from 'spacetimedb/server';
import {
  applyInline,
  esTables,
  makeAppendReducer,
  readStream,
  type CtxOf,
  type InlineProjection,
  type StateCache,
} from 'stdb-es/server';

export type CounterEvent =
  | { kind: 'Incremented'; by: number }
  | { kind: 'Decremented'; by: number }
  | { kind: 'Reset' };

/** App-owned current-state cache. Private, typed, disposable at the cost of a replay. */
const counterState = table(
  { name: 'counter_state' },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(), // the guard: load only trusts a row at es_stream.version
    value: t.i64(),
  },
);

/** Materialized read model maintained in the append transaction. */
const counterTotals = table(
  { name: 'counter_totals' },
  { id: t.string().primaryKey(), increments: t.u64(), decrements: t.u64() },
);

/** Ownership table used by the view factory's authorize predicate. */
const counterOwner = table(
  { name: 'counter_owner' },
  { streamId: t.string().primaryKey(), owner: t.identity() },
);

export const spacetimedb = schema({ ...esTables, counterState, counterTotals, counterOwner });
export default spacetimedb;

const totals: InlineProjection<CtxOf<typeof spacetimedb>> = {
  name: 'counter_totals',
  handles: ['Incremented', 'Decremented'],
  handle: (ctx, row) => {
    const current = ctx.db.counterTotals.id.find('global');
    const event = JSON.parse(row.data) as CounterEvent;
    const next = {
      id: 'global',
      increments:
        (current?.increments ?? 0n) + (event.kind === 'Incremented' ? BigInt(event.by) : 0n),
      decrements:
        (current?.decrements ?? 0n) + (event.kind === 'Decremented' ? BigInt(event.by) : 0n),
    };
    if (current) ctx.db.counterTotals.id.update(next);
    else ctx.db.counterTotals.id.insert(next);
  },
  reset: (ctx) => {
    ctx.db.counterTotals.id.delete('global');
  },
};

/** Adapter over the app's typed cache table; the library never sees the row shape. */
const counterCache: StateCache<{ value: bigint }, CtxOf<typeof spacetimedb>> = {
  load: (ctx, streamId) => {
    const row = ctx.db.counterState.streamId.find(streamId);
    return row ? { version: row.version, state: { value: row.value } } : null;
  },
  save: (ctx, streamId, version, state) => {
    const row = { streamId, version, value: state.value };
    if (ctx.db.counterState.streamId.find(streamId)) ctx.db.counterState.streamId.update(row);
    else ctx.db.counterState.streamId.insert(row);
  },
  remove: (ctx, streamId) => ctx.db.counterState.streamId.delete(streamId),
};

const applyEvent = (value: bigint, event: CounterEvent): bigint => {
  if (event.kind === 'Incremented') return value + BigInt(event.by);
  if (event.kind === 'Decremented') return value - BigInt(event.by);
  return 0n;
};

/** Full replay, used when the cache row is missing or cannot be trusted. */
function replayCounter(ctx: CtxOf<typeof spacetimedb>, streamId: string): bigint {
  let value = 0n;
  for (const row of readStream(ctx, streamId)) {
    value = applyEvent(value, JSON.parse(row.data) as CounterEvent);
  }
  return value;
}

export const appendEvents = makeAppendReducer(spacetimedb, {
  // Reject unregistered event types at write time instead of storing garbage.
  eventTypes: ['Incremented', 'Decremented', 'Reset'],
  // Runs in the same transaction, only for genuinely new events.
  onAppended: (ctx, result) => {
    const streamId = result.rows[0]?.streamId;
    if (!streamId) return;

    const current = ctx.db.counterState.streamId.find(streamId);
    if (current) {
      const value = result.rows.reduce(
        (state, row) => applyEvent(state, JSON.parse(row.data) as CounterEvent),
        current.value,
      );
      ctx.db.counterState.streamId.update({ streamId, version: result.version, value });
    } else {
      // A missing cache row means "replay", never "state is empty". `onAppended`
      // runs after the write, so this replay already includes the new rows.
      const value = replayCounter(ctx, streamId);
      ctx.db.counterState.insert({ streamId, version: result.version, value });
    }

    applyInline(ctx, [totals], result.rows);
  },
});
```

The reducer is generic: its wire signature is
`append_events(stream_id, stream_type, expected_version, events, metadata)`. Reducers return nothing;
clients observe the new version through their subscription or a view.

### 2. Client: encode, append, retry

```ts
import { createEventRegistry, createEventStoreClient } from 'stdb-es/client';

type CounterEvent =
  | { kind: 'Incremented'; by: number }
  | { kind: 'Decremented'; by: number }
  | { kind: 'Reset' };

const registry = createEventRegistry<CounterEvent>({
  typeOf: (event) => event.kind,
  events: {
    Incremented: {
      encode: (event) => event,
      decode: (payload: any) => ({ kind: 'Incremented', by: payload.by }),
    },
    Decremented: {
      encode: (event) => event,
      decode: (payload: any) => ({ kind: 'Decremented', by: payload.by }),
    },
    Reset: { encode: (event) => event, decode: () => ({ kind: 'Reset' }) },
  },
});

const store = createEventStoreClient({
  // Generated binding, passed in so the client has no generated-code dependency.
  append: (args) => connection.reducers.appendEvents(args),
  registry,
});

// Optimistic concurrency: 0 means "the stream must not exist yet".
await store.append('counter-1', 'Counter', [{ kind: 'Incremented', by: 5 }], {
  expectedVersion: 0,
});

// Encode once, retry verbatim: event ids make the retry idempotent.
const batch = store.encode([{ kind: 'Incremented', by: 2 }]);
await store.retry('counter-1', 'Counter', batch, { expectedVersion: 1 });
```

### 3. Read model: a view the app owns

```ts
import { makeStreamView } from 'stdb-es/server';

export const counterStream = makeStreamView(spacetimedb, {
  name: 'counter_stream', // parameter: { streamId: string }
  // Required. Views are public; this decides who may see the stream.
  authorize: (ctx, streamId) =>
    ctx.db.counterOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});
```

Compare identities with `.equals()`, never `===`: SpacetimeDB identities are objects compared by
value.

`counter_stream` is a parameterized view, so a client subscribes with SQL literals:

```ts
import { viewQuery } from 'stdb-es/client';

connection.subscribe([viewQuery('counter_stream', ['counter-1'])]);
```

## API

Everything below is exported from `stdb-es/server` unless noted.

### Appending

```ts
appendToStream(ctx, {
  streamId,
  streamType,
  expectedVersion,
  events: [{ eventId, eventType, data, metadata }],
  metadata,
}); // -> { status: 'appended' | 'replayed', version, rows }
```

- `expectedVersion` sentinels: `ANY_VERSION` (-1), `NO_STREAM` (0), `STREAM_EXISTS` (-2), or a
  concrete 1-based version.
- **Dedupe runs before the version check.** Retrying an identical batch (same `eventId`s) returns
  `status: 'replayed'` even if `expectedVersion` is now stale. That is the point: a timeout after a
  commit must not become a false concurrency error.
- A batch with *some* known ids throws `ES_PARTIAL_DUPLICATE`. An id used by another stream throws
  `ES_EVENT_ID_CONFLICT`.
- Errors carry stable `ES_*` codes (`ES_EXPECTED_VERSION_MISMATCH`, `ES_INVALID_BATCH`, …) so
  clients can match on the code instead of the message.
- `position` is gapless and commit-ordered, sourced from the single `es_head` row — not `autoInc()`.
  `version` is per stream and is the concurrency token.

`makeAppendReducer(spacetimedb, config)` builds the app's `append_events` reducer. Config:
`eventTypes`, `maxBatchSize` (100), `maxPayloadLength` (64 KiB), `onAppended`. `onAppended` runs only
for new events, never for a replay, and a throw rolls the whole append back.

### Reading and time travel

```ts
readStream(ctx, streamId, { fromVersion?, atVersion?, atTimestampMicros?, limit? }); // EventRow[]
  // sorted by version, never by timestamp

getStreamState(ctx, streamId);   // StreamRow | null
streamVersion(ctx, streamId);    // 0 when missing
listStreams(ctx, streamType?);   // StreamRow[]

aggregateStream(ctx, streamId, {
  streamType, initial: () => TState, decode, evolve,
  ...readStreamOptions,
}); // TState | null

foldEvents(rows, {
  initial: TState,
  decode: (row) => parsePayload<TEvent>(row), // -> { eventType, data }
  evolve: (state, decoded, row) => TState,
});
```

Version and timestamp bounds intersect. Events written in one transaction share `ctx.timestamp`, so
version is the only stable order. `atTimestampMicros` is *processing* time; business time belongs in
the payload.

### Aggregates and repositories

```ts
const counter = makeRepository(
  {
    streamType: 'Counter',
    initial: () => ({ value: 0n }),
    decode: (row) => JSON.parse(row.data) as CounterEvent,
    evolve: (state, event) => {
      if (event.kind === 'Incremented') return { value: state.value + BigInt(event.by) };
      if (event.kind === 'Decremented') return { value: state.value - BigInt(event.by) };
      return { value: 0n };
    },
  },
  { encode: (event) => ({ eventType: event.kind, data: event }), cache: counterCache },
);

const aggregate = counter.loadOrCreate(ctx, streamId);
counter.save(ctx, aggregate, [event], { expectedVersion: aggregate.version });

counter.load(ctx, streamId, { atVersion: 10 }); // time travel; ignores newer caches
counter.invalidate(ctx, streamId);              // delete the cache row, force replay
```

`load` is cache-first but version-guarded. A stale, newer-than-stream, or newer-than-`atVersion`
cache row is ignored and the required tail is replayed. `save` appends, folds the new rows into the
in-memory aggregate, and writes the cache in the same transaction.

Also exported: `Aggregate` (class form) and `defineAggregate` (identity helper for functional
definitions).

### State cache adapter

```ts
type StateCache<TState, C> = {
  load: (ctx: C, streamId: string) => { version: number; state: TState } | null;
  save: (ctx: C, streamId: string, version: number, state: TState) => void;
  remove: (ctx: C, streamId: string) => void;
};
```

Rules that make the cache safe:

- Write it **in the append transaction**; a cache must never describe uncommitted state.
- Compare its `version` to `es_stream.version` before trusting it.
- Deleting it is safe only if a miss replays the stream. A miss must never be read as "state 0":
  the repository replays, and a hand-written `onAppended` must too (see the example above).
- Changing an `evolve`/fold function does **not** change cached state. Rebuild the cache and run the
  doctor after a fold change.
- It is a current-state projection, not a disposable snapshot. Views may read it, so keep it accurate.

### Projections

```ts
type InlineProjection<C> = {
  name: string;
  handles: readonly string[];
  handle: (ctx: C, row: EventRow) => void;
  reset?: (ctx: C) => void;
};

applyInline(ctx, projections, appendedRows);
rebuildBatch(ctx, projections, { fromPosition?, limit?, reset? });
  // -> { processed, lastPosition, projections }
```

Inline handlers run inside the append transaction, so their writes commit atomically with the events.
They must be deterministic: do not read `ctx.random` or `ctx.timestamp` for business values, or a
rebuild will disagree with the original run.

`rebuildBatch` is for an app-gated admin reducer: bounded transactions, resumable via `lastPosition`,
and `reset: true` requires every projection to define `reset`. A throwing handler rolls back its
batch with an error naming the projection and the event position.

### View factories

```ts
makeStreamView(spacetimedb, { name, authorize })
  // params { streamId } -> es_event rows, ordered by version

makeStreamAtView(spacetimedb, { name, authorize })
  // params { streamId, atVersion } -> rows up to and including atVersion

makeStreamHeadView(spacetimedb, { name, authorize })
  // params { streamId } -> es_stream row (option), never event payloads
```

All three are `public` parameterized views. They read only indexed columns (`find`/`filter`), never
`.iter()`, and return an empty result when `authorize` says no. They are best for support, audit, and
low-volume reads; for hot read paths, define an app-owned anonymous view over a materialized table.

`stdb-es/client` provides `viewQuery(name, args)` and `tableQuery(name)` for subscriptions, plus
`sqlString`/`sqlLiteral` for safe literal escaping.

### Doctor

```ts
verifyStreamIntegrity(ctx, streamId);
  // { streamType, eventCount, problems, ok } — gaps, duplicates, type drift, empty stream

verifyStreamState(ctx, streamId, { cache, replay, equal? });
  // { exists, streamVersion, cachedVersion, cachedState, replayedState, ok }

findDrift(ctx, { cache, replay, equal?, streamType? }); // only failing streams
repairStream(ctx, streamId, { cache, replay, equal? }); // 'unchanged' | 'repaired' | 'removed'
```

The doctor catches same-version state drift, which the version guard cannot: a cache row can have the
right version and the wrong state. The default comparison is bigint-safe and key-order-independent;
pass `equal` for Maps, Sets, or other non-plain state.

The library exports **no repair reducer**. Expose one in the app behind your own authorization check:
repair is an operator decision.

### Client SDK

```ts
createEventRegistry({ typeOf, events }); // encode/decode/upgrade per event type
encodeEvents(registry, events, { newEventId?, metadata? });
decodeEvent(registry, row);
createEventStoreClient({ append, registry, newEventId? });
sliceRows(decodedRows, { streamId?, fromVersion?, atVersion?, atTimestampMicros?, limit? });
```

The client owns no state. Event ids default to `crypto.randomUUID()`; the server deduplicates by id,
so retries are safe. `upgrade` in an event definition is the escape hatch for schema evolution: old
payloads are migrated to the current shape before `decode` runs.

### Testing

`stdb-es/testing` runs your real module through SpacetimeDB's module test harness:

```ts
import { runEventStoreContractTests, wireEvents } from 'stdb-es/testing';

runEventStoreContractTests({
  spacetimedb,
  moduleExports: { appendEvents },
  append: (ctx, args) => appendEvents(ctx, args),
  streamId: () => 'counter-1',
  streams: [
    {
      streamType: 'Counter',
      repository: counterRepository,
      stateCache: counterCache,
      replay: replayCounter,
      sample: {
        wire: (streamId) => wireEvents(streamId, [
          ['Incremented', { kind: 'Incremented', by: 5 }],
          ['Decremented', { kind: 'Decremented', by: 2 }],
        ]),
        domain: () => [
          { kind: 'Incremented', by: 5 },
          { kind: 'Decremented', by: 2 },
        ],
        expectedState: { value: 3n },
        corrupt: (state) => ({ value: state.value + 1000n }),
      },
    },
  ],
  projections: { projections, snapshot: (ctx) => [...ctx.db.counterTotals.iter()] },
  views: [
    {
      name: 'counter_stream',
      view: counterStream,
      params: (streamId) => ({ streamId }),
      seed: (ctx, streamId) => ctx.db.counterOwner.insert({ streamId, owner: ctx.sender }),
      check: (rows) => expect(rows).toHaveLength(2),
    },
  ],
});
```

Covered invariants: append/read ordering, gapless positions, optimistic concurrency, idempotent
replay, repository/cache agreement, structural integrity, same-version drift detection and repair,
time travel, projection rebuild parity, and view output. Each case uses a fresh harness.

**Harness workaround.** `spacetimedb@2.15.0`'s module test harness bundles a second `Range` class, so
composite range scans silently return no rows and single-column ranges throw. The real host is not
affected. Wrap every reducer and view context with `withIndexRanges(ctx)` (exported from
`stdb-es/testing`) until the harness is fixed; delete the wrapper when it is.

## Guarantees

| Guarantee | Consequence |
| --- | --- |
| Append is one transaction | Events, stream version, head position, cache, and inline projections commit or roll back together |
| Dedupe before version check | Retrying a committed batch succeeds as `replayed`; it never reports a false conflict |
| Versions are contiguous from 1 | A stream's version is a safe concurrency token |
| Positions are gapless and commit-ordered | A checkpoint cursor can resume from any position |
| Ordering is by version, not timestamp | Batched events share a timestamp |
| A cache is only a cache | A stale or time-travelling row is ignored, not trusted |
| On a fold change, rebuild | The cache cannot detect a logic change at the same version; `verifyStreamState` and the contract test can |
| No library views or reducers | No accidental public exposure, no hidden write path |

## Operations

Private tables are invisible to anonymous SQL clients, which is the point. As the database owner you
can inspect them with `spacetime sql`. See [docs/sql-recipes.md](docs/sql-recipes.md) for verified
queries (stream head, time travel, cache checks, gap hunting) and the safety rules.

Rule of thumb: **read with SQL, write with reducers.** Editing `es_event` by hand bypasses dedupe,
the head counter, and every projection.

## Limits and non-goals (v1)

- **No async projection pump.** Inline projections run in the append transaction, so a slow handler
  slows every write. The pump is additive for v1.1: `es_checkpoint` is a new table, which is a safe
  migration.
- **No library-owned snapshot table.** App-owned typed caches replace it.
- **Typed-enum payloads are not implemented yet.** The schema spike proved additive variants migrate
  automatically; the default (and only current) mode is canonical JSON in `data: t.string()`.
- **No event registry server** and no cross-database distribution.
- **TypeScript modules only.** The data model is language-neutral; the helpers are not.
- **Parameterized views are SQL-literal only**, have no primary-key metadata, and all arguments of
  one view share a single client cache.
- **Module code cannot query a view.** If a reducer needs a read model, it must be a table.

## Package exports

| Import | Contents |
| --- | --- |
| `stdb-es` | Error codes and protocol types (safe from client and server code) |
| `stdb-es/server` | Tables, append/read, repository, projections, view factories, doctor |
| `stdb-es/client` | Event registry, encoding, append client, subscription query helpers |
| `stdb-es/testing` | Contract tests, fixtures, and the `withIndexRanges` harness shim |

## Development

```bash
npm install
npm test              # 79 tests, in-memory harness
npm run build         # tsc -> dist (declarations included)
npm run smoke         # publish the example and run the live smoke test
```

The smoke test needs a local server:

```bash
spacetime start --in-memory --non-interactive   # 127.0.0.1:3000
```

`spacetime build` may print `tsc not found in node_modules` because npm workspaces hoist TypeScript
to the repository root, so the CLI cannot find a per-module `tsc`. The build still succeeds, but the
CLI has skipped its own type check. `npm run example:typecheck` runs that check explicitly and is
part of `example:build`, `example:publish`, and `smoke`.

It republishes `stdb-es-counter`, appends through the generated reducer, and asserts against
`es_stream`, `counter_state`, and the anonymous `counter_summary` view — including a stale-version
rejection, an idempotent retry, and a cache row that is deleted and then rebuilt by replay.

The worked example lives in `examples/counter`. The design record, including the migration spike
results and the rejected alternatives, is in [docs/event-sourcing-plan.md](docs/event-sourcing-plan.md).

## License

MIT
