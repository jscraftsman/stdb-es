# stdb-es

Event sourcing for [SpacetimeDB](https://spacetimedb.com): a private append-only event log,
optimistic concurrency, stream replay and time travel, aggregates with version-guarded state caches,
and projection tooling — on top of the backend you already deploy.

SpacetimeDB is the whole backend. The module is the application server, reducers are the write path,
and views are the client read path. `stdb-es` adds the event-sourcing half without asking you to run
a second database, a message broker, or a separate read-model store.

> **Status: 0.1.1, pre-release.** The API may change. Requires `spacetimedb >= 2.15 < 3`.
> JSON event payloads are the only implemented mode; typed-enum payloads are designed but not
> shipped yet. TypeScript server modules only.

## Documentation

- [Package Usage Guide](docs/usage-guide.md) — a from-scratch full-stack project, module code, client
  code, testing, and a simple React frontend, including domain-separated layouts.
- [API reference](docs/API.md) — every shipped export, its inputs, and its outputs.
- [Unit testing guide](docs/unit%20testing.md) — offline module and client tests, fakes, and assertions.
- [Integration testing guide](docs/integration%20testing.md) — real-server lifecycle, subscriptions,
  anonymous views, and teardown.
- [SQL recipes](docs/sql-recipes.md) — owner-only inspection and repair queries.
- [Counter with frontend](examples/sets/counter-with-frontend/README.md) — runnable full-stack set.
- [Design record](docs/event-sourcing-plan.md) — decisions, rejected alternatives, and milestones.
- [Publishing guide](docs/publishing.md) — manual npm release steps and GitHub Actions setup.

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

## Glossary

These are the terms used by the API and the guides. "Server" means SpacetimeDB module code;
"client" means browser or other SDK code.

| Term | Meaning in `stdb-es` |
| --- | --- |
| **App-owned constants** | Per-domain `constants.ts` exports (`STREAM_TYPES_*`, `STREAM_PREFIXES_*`, `EVENT_TYPES_*`, `TABLES_*`, `VIEWS_*`, `ROWS_*`) for literals the app owns. The core package never exports them. |
| **Stream** | One append-only sequence of events for one business object or process, identified by a stream id. It is the unit of optimistic concurrency. |
| **Stream id** | The caller-supplied primary key of a stream, for example `streamId(STREAM_PREFIXES_ORDER.order, '42')`. The same id must always use the same stream type. Use the shared helper to format and validate it. |
| **Stream id helper** | `streamId(prefix, key)` from `stdb-es`: builds `<prefix>-<key>`, rejects unsafe characters, and enforces the 256-character limit. Formatting only — ownership is still an app decision. |
| **Stream type** | The aggregate/process kind recorded on a stream, such as `STREAM_TYPES_ORDER.Order`. It lets one module host many kinds of streams. |
| **Event** | A fact that has happened. It is stored as an immutable row in the private `es_event` table. |
| **Event envelope** | The stable stored columns around the payload: `eventId`, `position`, `streamId`, `streamType`, `version`, `eventType`, `metadata`, timestamps, and sender. |
| **Event id** | A globally unique id supplied by the caller. The primary key on `es_event.eventId` is what makes retries idempotent. Generate a fresh one for each genuinely new event; reuse the same ones when retrying a batch. |
| **Event type** | The string that selects a codec in the client registry, such as `EVENT_TYPES_COUNTER.Incremented`. It is not the stream type. |
| **Payload / `data`** | The JSON-serializable body of an event, stored as canonical JSON in a string column. The server validates that it is JSON but does not interpret its shape. |
| **Metadata** | Optional JSON-or-text context attached to an append or an individual event. The store carries it without interpreting it. |
| **Version** | The 1-based position of an event inside one stream. The stream's current version is its concurrency token. |
| **Expected version** | The version the caller believes is current. The append fails with `ES_EXPECTED_VERSION_MISMATCH` if the belief is wrong. |
| **Sentinel** | A special `expectedVersion` value: `ANY_VERSION` (-1) skips the check, `NO_STREAM` (0) requires a new stream, and `STREAM_EXISTS` (-2) requires an existing one. |
| **Position** | A gapless, commit-ordered number assigned to every event across the whole database. It is the cursor for rebuilds, not a per-stream version. |
| **Head** | The single counter that assigns positions. It lives in the private `es_head` table and is updated in the append transaction. |
| **Append** | The write operation: validate, deduplicate, check concurrency, insert events, advance the head and stream version, then run hooks. All of it is one transaction. |
| **Replay** | Reading a stream and folding its events into state, either in full or from a given version onward. A missing state cache must be recovered by replay. |
| **Dedupe** | Detecting that an event id was already committed. A whole repeated batch returns `replayed`; a partial repeat is rejected because it is ambiguous. |
| **`appended` vs `replayed`** | The two `AppendResult` statuses. `appended` means new rows were written; `replayed` means the identical batch had already committed. Hooks run only for `appended`. |
| **Aggregate** | A typed state value plus the rules for applying events to it. `defineAggregate` describes it functionally; the `Aggregate` class is an optional object form. |
| **Fold / `evolve`** | The deterministic function `(state, event) => nextState`. Replay, repository loads, projections, and doctor repair must share equivalent logic. |
| **State cache** | An app-owned private table holding current aggregate state at a known version. It is a performance cache, not the source of truth. |
| **Version guard** | The rule that a cache row is trusted only when its version is usable for the requested read. Stale, future, or time-travel-incompatible rows are ignored and replay fills the gap. |
| **Drift** | A cache that disagrees with a replay. Same-version drift cannot be seen by the version guard, so the doctor compares state as well. |
| **Projection** | A handler that consumes events and maintains another representation, such as a totals table. Inline projections commit with the append; v1 has no async pump. |
| **Rebuild** | Replaying all (or a bounded range of) events through projections to reconstruct a read model, or rewriting a state cache from the log. |
| **View** | A public, queryable server function. Because SpacetimeDB views are public, the library ships only factories that require an app `authorize` predicate. |
| **Read model** | Client-visible query output: an app-owned view over events/cache tables, or a materialized table maintained by a projection. |
| **Subscription** | A client query whose results are pushed as rows change. `viewQuery()` and `tableQuery()` build the SQL strings used by SpacetimeDB subscriptions. |
| **Upcast / `upgrade`** | Converting an old stored payload to the current shape before decoding. This is how schema evolution avoids rewriting the event log. |
| **Registry** | The client-side map from event type strings to codecs (`encode`, `decode`, optional `upgrade`). It is shared by append and decode paths. |
| **Domain / bounded context** | A business boundary with its own event types, aggregates, caches, and views. In a multi-domain app, group code by domain and share ids, not event unions. |
| **Cross-aggregate** | An operation that coordinates more than one aggregate stream. Model it with a process stream and deterministic commands, not a transaction spanning unrelated aggregates. |
| **Optimistic concurrency** | Assuming no conflict, appending with an expected version, and failing loudly if another writer won. Retrying with fresh event ids is the recovery path. |
| **Time travel** | Reading state or events as of a version or processing timestamp. Timestamp bounds intersect with version bounds; version is the authoritative order. |
| **Command / reducer** | The server write path. A reducer receives arguments, loads or creates an aggregate, decides events, and appends them. |
| **Contract test** | A suite from `stdb-es/testing` that runs the app's real module through the harness and checks append, cache, projection, and view invariants. |

## Install

```bash
npm install stdb-es spacetimedb
```

`vitest` is an optional peer dependency: only the `stdb-es/testing` entry point needs it.

## Quick start

### 1. Module: tables, append reducer, state cache

```ts
// spacetimedb/src/domains/counter/constants.ts
export const STREAM_TYPES_COUNTER = { Counter: 'Counter' } as const;
export const STREAM_PREFIXES_COUNTER = { counter: 'counter' } as const;
export const EVENT_TYPES_COUNTER = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;
export const TABLES_COUNTER = {
  state: 'counter_state',
  totals: 'counter_totals',
  owner: 'counter_owner',
} as const;
export const VIEWS_COUNTER = {
  stream: 'counter_stream',
  summary: 'counter_summary',
} as const;
export const ROWS_COUNTER = { totals: 'global' } as const;

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
import {
  EVENT_TYPES_COUNTER,
  ROWS_COUNTER,
  STREAM_TYPES_COUNTER,
  TABLES_COUNTER,
} from './domains/counter/constants.js';

export type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

/** App-owned current-state cache. Private, typed, disposable at the cost of a replay. */
const counterState = table(
  { name: TABLES_COUNTER.state },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(), // the guard: load only trusts a row at es_stream.version
    value: t.i64(),
  },
);

/** Materialized read model maintained in the append transaction. */
const counterTotals = table(
  { name: TABLES_COUNTER.totals },
  { id: t.string().primaryKey(), increments: t.u64(), decrements: t.u64() },
);

/** Ownership table used by the view factory's authorize predicate. */
const counterOwner = table(
  { name: TABLES_COUNTER.owner },
  { streamId: t.string().primaryKey(), owner: t.identity() },
);

export const spacetimedb = schema({ ...esTables, counterState, counterTotals, counterOwner });
export default spacetimedb;

const totals: InlineProjection<CtxOf<typeof spacetimedb>> = {
  name: TABLES_COUNTER.totals,
  handles: [EVENT_TYPES_COUNTER.Incremented, EVENT_TYPES_COUNTER.Decremented],
  handle: (ctx, row) => {
    const current = ctx.db.counterTotals.id.find(ROWS_COUNTER.totals);
    const event = JSON.parse(row.data) as CounterEvent;
    const next = {
      id: ROWS_COUNTER.totals,
      increments:
        (current?.increments ?? 0n) +
        (event.kind === EVENT_TYPES_COUNTER.Incremented ? BigInt(event.by) : 0n),
      decrements:
        (current?.decrements ?? 0n) +
        (event.kind === EVENT_TYPES_COUNTER.Decremented ? BigInt(event.by) : 0n),
    };
    if (current) ctx.db.counterTotals.id.update(next);
    else ctx.db.counterTotals.id.insert(next);
  },
  reset: (ctx) => {
    ctx.db.counterTotals.id.delete(ROWS_COUNTER.totals);
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
  if (event.kind === EVENT_TYPES_COUNTER.Incremented) return value + BigInt(event.by);
  if (event.kind === EVENT_TYPES_COUNTER.Decremented) return value - BigInt(event.by);
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
  eventTypes: [
    EVENT_TYPES_COUNTER.Incremented,
    EVENT_TYPES_COUNTER.Decremented,
    EVENT_TYPES_COUNTER.Reset,
  ],
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
import { NO_STREAM, streamId } from 'stdb-es';
import { createEventRegistry, createEventStoreClient } from 'stdb-es/client';
// The same app-owned constants, shared or mirrored across module and web.
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';

type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

const registry = createEventRegistry<CounterEvent>({
  typeOf: (event) => EVENT_TYPES_COUNTER[event.kind],
  events: {
    [EVENT_TYPES_COUNTER.Incremented]: {
      encode: (event) => event,
      decode: (payload: any) => ({ kind: EVENT_TYPES_COUNTER.Incremented, by: payload.by }),
    },
    [EVENT_TYPES_COUNTER.Decremented]: {
      encode: (event) => event,
      decode: (payload: any) => ({ kind: EVENT_TYPES_COUNTER.Decremented, by: payload.by }),
    },
    [EVENT_TYPES_COUNTER.Reset]: {
      encode: (event) => event,
      decode: () => ({ kind: EVENT_TYPES_COUNTER.Reset }),
    },
  },
});

const store = createEventStoreClient({
  // Generated binding, passed in so the client has no generated-code dependency.
  append: (args) => connection.reducers.appendEvents(args),
  registry,
});

const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

// Optimistic concurrency: NO_STREAM requires a new stream.
await store.append(
  id,
  STREAM_TYPES_COUNTER.Counter,
  [{ kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
  { expectedVersion: NO_STREAM },
);

// Encode once, retry verbatim: event ids make the retry idempotent.
const batch = store.encode([{ kind: EVENT_TYPES_COUNTER.Incremented, by: 2 }]);
await store.retry(id, STREAM_TYPES_COUNTER.Counter, batch, { expectedVersion: 1 });
```

### 3. Read model: a view the app owns

```ts
import { makeStreamView } from 'stdb-es/server';
import { VIEWS_COUNTER } from './domains/counter/constants.js';

export const counterStream = makeStreamView(spacetimedb, {
  name: VIEWS_COUNTER.stream, // parameter: { streamId: string }
  // Required. Views are public; this decides who may see the stream.
  authorize: (ctx, streamId) =>
    ctx.db.counterOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});
```

Compare identities with `.equals()`, never `===`: SpacetimeDB identities are objects compared by
value.

`VIEWS_COUNTER.stream` is a parameterized view, so a client subscribes with SQL literals. The shipped
subscription bridge binds the query to a row handler:

```ts
import { subscribeEventRows, viewQuery } from 'stdb-es/client';

const subscription = subscribeEventRows({
  connection,
  query: { query: viewQuery(VIEWS_COUNTER.stream, [id]) },
  readRows: (ctx) => [...ctx.db.counterStream.iter()], // generated cache for the view
  onRows: (rows) => render(rows),
  onError: (error) => console.error(error),
});

// Later: subscription.unsubscribe();
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
    streamType: STREAM_TYPES_COUNTER.Counter,
    initial: () => ({ value: 0n }),
    decode: (row) => JSON.parse(row.data) as CounterEvent,
    evolve: (state, event) => {
      if (event.kind === EVENT_TYPES_COUNTER.Incremented) {
        return { value: state.value + BigInt(event.by) };
      }
      if (event.kind === EVENT_TYPES_COUNTER.Decremented) {
        return { value: state.value - BigInt(event.by) };
      }
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

`stdb-es/client` provides `viewQuery(name, args)` and `tableQuery(name)` for subscriptions,
`sqlString`/`sqlLiteral` for safe literal escaping, and `subscribeEventRows` /
`createStreamSubscription` to bind queries to row handlers with pruning, reconnect replay, and error
propagation.

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
viewQuery(name, args);  tableQuery(name);  sqlLiteral(value);
subscribeEventRows({ connection, query, readRows, onRows, onError?, streamId? });
createStreamSubscription({ connection, query(streamId), readRows, onRows });
```

The append client owns no state. Event ids default to `crypto.randomUUID()`; the server deduplicates
by id, so retries are safe. `upgrade` in an event definition is the escape hatch for schema evolution:
old payloads are migrated to the current shape before `decode` runs. The separate subscription bridge
binds queries to row handlers; it registers callbacks once and lets SDK reconnect replay refresh
rows.

### Testing

For a step-by-step offline testing workflow, see the [unit testing guide](docs/unit%20testing.md).
For tests that need a real server, the Node-only `stdb-es/testing/integration` entry manages a
disposable publish/call/SQL/subscribe/dispose lifecycle; see the
[integration testing guide](docs/integration%20testing.md). `stdb-es/testing` can also run your real
module through SpacetimeDB's module test harness:

```ts
import { streamId } from 'stdb-es';
import { runEventStoreContractTests, wireEvents } from 'stdb-es/testing';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
  VIEWS_COUNTER,
} from './domains/counter/constants.js';

runEventStoreContractTests({
  spacetimedb,
  moduleExports: { appendEvents },
  append: (ctx, args) => appendEvents(ctx, args),
  streamId: () => streamId(STREAM_PREFIXES_COUNTER.counter, '1'),
  streams: [
    {
      streamType: STREAM_TYPES_COUNTER.Counter,
      repository: counterRepository,
      stateCache: counterCache,
      replay: replayCounter,
      sample: {
        wire: (id) => wireEvents(id, [
          [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
          [EVENT_TYPES_COUNTER.Decremented, { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 }],
        ]),
        domain: () => [
          { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 },
          { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 },
        ],
        expectedState: { value: 3n },
        corrupt: (state) => ({ value: state.value + 1000n }),
      },
    },
  ],
  projections: { projections, snapshot: (ctx) => [...ctx.db.counterTotals.iter()] },
  views: [
    {
      name: VIEWS_COUNTER.stream,
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
| `stdb-es` | Error codes, the `streamId(prefix, key)` helper, and protocol types (safe from client and server code) |
| `stdb-es/server` | Tables, append/read, repository, projections, view factories, doctor |
| `stdb-es/client` | Event registry, encoding, append client, subscription query helpers, subscription bridge |
| `stdb-es/testing` | Module/client test helpers, deterministic ids, append-error assertions, fakes, fixtures, contract tests, and the `withIndexRanges` harness shim |
| `stdb-es/testing/integration` | Node-only disposable server/database lifecycle, CLI calls, SQL, subscriptions, and teardown |

## Development

```bash
npm install
npm test              # 111 tests, in-memory harness
npm run build         # tsc -> dist (declarations included)
npm run check:pack    # install a packed tarball in a fresh workspace app
npm run smoke         # publish the example and run the live smoke test
npm run smoke:integration # dogfood stdb-es/testing/integration on a disposable server
npm run example:set:counter:test:integration # consumer-style integration tests for the example set
```

To run the full-stack set (React + module) against the already-running local server:

```bash
npm run example:set:counter:start   # publishes, generates bindings, starts Vite on :5173
```

The full-stack publish preserves existing data. Use `npm run example:set:counter:publish-clean` only
for a deliberate scratch reset with `--delete-data=always`.

The smoke and full-stack commands assume a local server on `127.0.0.1:3000`:

```bash
spacetime start --in-memory --non-interactive   # 127.0.0.1:3000
```

`spacetime build` may print `tsc not found in node_modules` because npm workspaces hoist TypeScript
to the repository root, so the CLI cannot find a per-module `tsc`. The build still succeeds, but the
CLI has skipped its own type check. `npm run example:typecheck` and
`npm run example:set:counter:typecheck` run that check explicitly and are part of their respective
build/publish/start scripts.

It republishes `stdb-es-counter`, appends through the generated reducer, and asserts against
`es_stream` plus the app-owned names in `TABLES_COUNTER.state` and `VIEWS_COUNTER.summary`
(`counter_state` and `counter_summary`) — including a stale-version rejection, an idempotent retry,
and a cache row that is deleted and then rebuilt by replay.

The module-only example lives in `examples/counter`; the runnable full-stack set lives in
[`examples/sets/counter-with-frontend`](examples/sets/counter-with-frontend/README.md). The design
record, including the migration spike results and the rejected alternatives, is in
[docs/event-sourcing-plan.md](docs/event-sourcing-plan.md).

## License

MIT
