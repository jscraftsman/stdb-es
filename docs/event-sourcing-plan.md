# Plan: `spacetime-event-store` — an event sourcing abstraction for Spacetime

Reference: [BuildYourOwnEventStore](https://github.com/oskardudycz/EventSourcing.NetCore/tree/main/Workshops/BuildYourOwnEventStore)
(Postgres + Dapper + a PL/pgSQL `append_event` function).

Target: a TypeScript npm package for SpacetimeDB 2.15.x (CLI verified locally: `spacetimedb-cli 2.15.0`).

> Implementation note: this plan was written under the working name `spacetime-event-store`; the
> package shipped as **`stdb-es`**, with entry points `.`, `./server`, `./client`, `./testing`, and
> `./testing/integration`. The architecture below is what was built.

> Spacetime is the whole backend: the module *is* the application server, reducers are the write
> path, and views are the client read path. The package therefore ships **table definitions, pure
> helper functions, adapter protocols, view factories and contract tests**. The application owns
> its schema assembly, its reducers, its state tables and its views.

---

## 0. Corrections since the first draft

These came out of reading the 2.0 view documentation and running a real migration spike. They
change the design, so they are recorded here rather than quietly edited.

| Earlier claim | Reality |
| --- | --- |
| A typed `t.enum` payload makes every new event type a migration | **False.** Adding a variant is an automatic, non-destructive migration. Verified. Only *changing* an existing variant requires a manual migration. |
| Read models can be private views | **False.** Views must be declared `public`. There is no private view. Access control is done *inside* the view (`view` + `ctx.sender`), not by hiding the view. |
| A view can fold/scan whatever it wants | **False.** Procedural views cannot call `.iter()`; they may only use `.find()`/`.filter()` on indexed columns and `count()`. Declarative `ctx.from` queries are the exception and are evaluated incrementally. |
| Many subscribers multiply view cost | **False for anonymous views.** Anonymous views are materialized once and shared. Only per-caller (`view`) results are computed per subscriber. |
| Library ships public time-travel views | **Rejected.** Since views cannot be private, shipping `es_stream_at` as a library view would expose every private event to every client, contradicting the whole "private core tables" rule. |
| Snapshots are a library-owned table | **Replaced.** Option B: app-owned typed state tables used as a version-guarded load cache. |

---

## 1. Goals and non-goals

**Goals**

- Reproduce the ten workshop modules with the same semantics: streams, events, append, optimistic
  concurrency, stream reads, aggregation, time travel, aggregates + repository, snapshots, projections.
- Private tables for all core data. No public table ever holds events, stream state or snapshots.
- Read models are app-owned views (default) or app-owned materialized tables (escape hatch).
- Strong typing end to end, with canonical JSON payloads as the shipped default and a typed-enum
  mode as the schema-evolution target (spiked, not yet shipped).
- Enforceable in practice: compile-time adapters + contract tests + a drift-detecting doctor +
  a publish-time smoke test.
- Testable at two levels by consumers: fast in-memory unit tests with fakes and the module harness,
  and opt-in integration tests against a disposable real database.
- Documented by a **Package Usage Guide** (module, client, testing, frontend) and a complete
  **API reference**, both written for app developers.
- Publishable to npm, testable with the official module test harness.

**Non-goals (v1)**

- Async checkpoint pump (v1.1 — see §11).
- Library-owned generic snapshot table (Option A). Adding tables later is a safe migration, so
  this stays available without being required.
- Event schema registry server / cross-database distribution.
- Rust/C#/C++ modules. TS-first; the data model is language-neutral.
- A hosted test service. The integration kit manages a disposable database, not infrastructure.

### 1.1 Delivery requirements (v1)

| ID | Requirement | Acceptance criteria |
| --- | --- | --- |
| **R1** | **Core package unit tests** | Every public export in `.`, `./server`, and `./client` has direct coverage; all ten workshop modules have a named test; the contract suite is dogfooded against the counter fixture; `npm test` is green with no live server. |
| **R2** | **Consumer unit-test tools** | `stdb-es/testing` gives a consumer everything needed to test *their* module and client without a server: harness wrapper, wire fixtures, deterministic ids, append-error assertions for server-side seams, a contract suite with optional command-boundary checks, and a fake `command` binding for client-side tests. `createFakeAppend` remains only as a deprecated migration aid. No network, no Node built-ins, runner-agnostic except for the optional `vitest` peer used by the contract suite. |
| **R3** | **Consumer integration-test tools** | A Node-only entry, `stdb-es/testing/integration`, that publishes a module to a disposable database, calls reducers, runs owner and anonymous SQL, connects clients, waits for subscription convergence, and tears down. Works against `spacetime start` locally and a remote server, with no hard dependency on `vitest`. |
| **R4** | **Package Usage Guide** | `docs/usage-guide.md` with four parts — module, client, testing, frontend. It explains domain-separated module/client layouts, app-owned constants (`<SCOPE>_<DOMAIN>`), read-side codecs, shared `streamId` ownership rules, `commandId` idempotency, time travel, cache recovery, authorization, and all three consumer test layers. |
| **R5** | **CI gate for the above** | CI runs library and example typechecks, the offline unit suite, a disposable-server publish smoke test, and — once R3 lands — the consumer integration suite. A failure in any layer blocks merge. |
| **R6** | **API reference** | `docs/API.md` documents every export from `.`, `./server`, `./client`, and `./testing` with its purpose, inputs/payload, and output/guarantees. Planned APIs are listed separately and never presented as shipped. |
| **R7** | **README glossary** | `README.md` defines the consumer-facing terms used by the API and guides: stream, event envelope, version, expected version, position, state cache, version guard, projection, view, upcast, domain, cross-aggregate, and the other terms used by the consumer API. |
| **R8** | **Example sets** | Each planned set contains a publishable module plus a simple React client with a basic UI. The sets cover idempotency, eventual consistency, cross-aggregate coordination, multiple domains, and schema evolution with minimal concept overlap. Implementation waits for an explicit go signal. |
| **R9** | **Backend-owned command writes** (breaking change; §18, M15) | Browser code never builds an event envelope (`streamId`, `streamType`, `eventType`, `data`, `expectedVersion`) and never calls a generic append. It calls **app-defined public command reducers** with a typed command payload plus an idempotency key; only those reducers validate authorization and call `appendToStream`. Commands are declared in the module and mirrored to the frontend by `spacetime generate`. The generic `append_events` reducer is not part of the callable app surface. Counter examples expose `increment`, `decrement`, and `reset`. Rollout is complete after the six phases in §18.6. |

> **Implemented breaking change.** R9 supersedes the client `append`/`retry` surface in §13 and the
> `makeAppendReducer` factory in §4. It does **not** rewrite shipped M0–M8 behavior; those milestones
> stay as historical record, while active guides document the command contract. The full requirement,
> rationale, and rollout are specified in §18.

---

## 2. What changes versus the workshop

| Workshop (Postgres / .NET) | This package (Spacetime 2.15 / TS) |
| --- | --- |
| `append_event(...)` SQL function | `appendToStream()` helper called from an app-owned reducer |
| `SELECT ... FOR UPDATE` | Not needed: transactions are serializable and serialized per database |
| `events.data JSONB`, `type text` | `data t.string()` (canonical JSON) + `eventType t.string()`; typed-enum mode is spiked but not shipped |
| `UNIQUE(stream_id, version)` | No composite unique constraint exists; enforced in the reducer. `eventId` is the PK for dedupe |
| `Guid.CreateVersion7()` | Caller-supplied event ids (this is what makes retries idempotent) |
| `Task` / `async` | Reducers are synchronous |
| Reflection `Apply<TEvent>` | Explicit handler registry keyed by event type string |
| `created timestamptz` | `createdAt t.timestamp()` plus `createdAtMicros t.u64()` because `Timestamp` is not indexable |
| `ISnapshot.Handle(aggregate)` + `es_snapshot` table | App-owned typed state table + version guard (§10) |
| `IProjection` loop in `Store()` | Inline projection handlers in the append transaction (v1) |
| Marten async projections | Deferred to v1.1 (§11) |
| Read models queried by the API | App-owned views and/or materialized tables (§9) |

---

## 3. Spike findings (verified on a local server)

Module: a `DomainEvent` sum type stored as a table column, plus a reducer taking it as an argument.

```ts
const DomainEvent = t.enum('DomainEvent', {
  Incremented: t.object('Incremented', { by: t.i32() }),
  Decremented: t.object('Decremented', { by: t.i32() }),
});
const esEvent = table({ name: 'es_event' }, {
  eventId: t.string().primaryKey(),
  data: DomainEvent,
});
```

| Experiment | Result | Evidence |
| --- | --- | --- |
| Store a typed enum column | Works | `(incremented = (by = 5))`, `(reset = ())` in SQL |
| Use it as a reducer argument | Works | wire format is `{"incremented":{"by":5}}` |
| Add a variant, republish **without** `--delete-data` | **Allowed**, existing rows preserved | `Database Migration Plan ▸ Changed columns for table es_event` → published |
| Insert the new variant afterwards | Works | row `e3 … Reset` present after publish |
| Add a field to an existing variant | **Rejected** | `Changing a type within column data … with fewer fields, requires a manual migration` / `due to size mismatch` |
| Remove a variant | **Rejected** | `with fewer variants, requires a manual migration` |

Consequences:

1. **Additive event types are free.** The common event-sourcing growth pattern (a new business
   event) needs no data migration, no `--delete-data`, no downtime.
2. **Event payloads are frozen once shipped.** Adding a field to an existing event is a manual
   migration. On a production event log you never delete data, so the only legal move is to add a
   `XxxV2` variant and upcast in the registry. This is exactly what JSON + upcasters already do,
   except the old shape is enforced by the schema instead of by convention.
3. **Variant names are permanent** because removing or renaming one blocks publishing.
4. `eventType: t.string()` must stay a separate column regardless: an enum payload cannot be an
   index key, and the event type must be indexable.

### Payload decision

Only the JSON mode ships in v1. The typed-enum column below was verified in the spike and is the
evolution target, but no factory is exported for it yet. Payload mode is fixed at schema construction;
switching later requires a manual migration, so the choice is deliberate.

| | `data: t.string()` (shipped) | `data: AppEventEnum` (spiked, not shipped) |
| --- | --- | --- |
| New event type | app code only | automatic schema change |
| Payload field added | app code (upcaster) | manual migration → `V2` variant + upcaster |
| Event removed/renamed | app code | blocked |
| Event shape documented in schema | no | yes |
| Server-side validation | registry check in reducer | schema-enforced |
| One store, many bounded contexts | yes | one union per module |
| Column size | variable string | derived from the union |

Default JSON because the package is generic and because payload evolution must never require a
database migration. A typed-enum option remains attractive for a single-context app because the spike
shows the additive case is safe; it is not part of the v1 API.

---

## 4. Package layout

> **Historical pre-M15 layout.** This records the M0–M8 package shape. The browser-facing
> `client/event-store.ts` and `makeAppendReducer` append surface was removed in M15 (§18); the shipped
> client entry is command dispatch plus read-side codecs and subscription helpers. `fake-append.ts`
> remains only as a deprecated migration aid.

```
stdb-es/
  package.json            # exports ".", "./server", "./client", "./testing", "./testing/integration"
  src/
    stream-id.ts          # shared streamId(prefix, key) formatter/validator
    server/
      tables.ts           # es_stream, es_event, es_head (+ optional typed payload factory)
      errors.ts           # stable ES_* error codes
      append.ts           # appendToStream + makeAppendReducer
      read.ts             # readStream, getStreamState, listStreams, aggregateStream
      aggregate.ts        # Aggregate base + defineAggregate
      repository.ts       # Repository<T> + StateCache protocol
      projections.ts      # inline projection protocol + rebuildBatch
      views.ts            # view factories (authorization is a required argument)
      doctor.ts           # verify / repair helpers (pure, no exported reducers)
      index.ts
    client/
      encode.ts           # registry, encode/decode, upcasters
      event-store.ts      # encode/append/retry + decoded-row helpers
      views.ts            # subscription query literals
      index.ts
    testing/
      harness.ts          # withIndexRanges workaround
      fixtures.ts         # wire rows and version helpers
      ids.ts              # deterministic, retry-safe event ids
      assertions.ts       # expectAppendError (runner-agnostic)
      fake-append.ts      # records appends for client unit tests
      module-test.ts      # harness + Range shim convenience wrapper
      contracts.ts        # runEventStoreContractTests (optional vitest peer)
      integration/        # Node-only publish/call/sql/subscribe harness
      index.ts
  examples/
    counter/              # publishable module; target of the live smoke test
    sets/                 # planned example sets (R8): each has spacetimedb/ + web/
      idempotent-order/
      eventual-delivery/
      cross-aggregate-transfer/
      multi-domain-storefront/
      schema-evolution/
  docs/
    usage-guide.md        # module, client, testing, frontend (R4)
    unit testing.md       # dedicated offline unit-testing guide (R2/R4)
    API.md                # complete consumer API reference (R6)
    sql-recipes.md        # owner-only inspection and repair
    event-sourcing-plan.md
  scripts/
    smoke-example.mjs     # live publish smoke test
```

```json
{
  "name": "stdb-es",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./server": "./dist/server/index.js",
    "./client": "./dist/client/index.js",
    "./testing": "./dist/testing/index.js",
    "./testing/integration": "./dist/testing/integration/index.js"
  },
  "peerDependencies": { "spacetimedb": ">=2.15.0 <3", "vitest": ">=3 <4" },
  "peerDependenciesMeta": { "vitest": { "optional": true } }
}
```

Two hard boundaries:

- The `server` entry must not import the client SDK or Node built-ins. A module is bundled and runs
  in the V8 isolate.
- The `client` entry must stay browser-safe. Node-only test tooling lives behind
  `./testing/integration`, never behind `./client` or `./testing`.

---

## 5. Ownership and visibility

| Concern | Owner | Visibility | Notes |
| --- | --- | --- | --- |
| `es_stream`, `es_event`, `es_head` | library | **private** | system of record, concurrency, gapless position |
| state table(s) (`counter_state`, …) | **app** | **private** | typed current state; version-guarded load cache |
| read-model views | **app** | public (only option) | anonymous by default, per-caller only when needed |
| materialized read-model tables | **app** | private | only when a view cannot do the job |
| `es_checkpoint` + pump timer | library | private | v1.1 only |
| fold / replay / time travel | library | not exported as reducers | helpers, tests, admin repair |

Rules the package documents and tests:

1. No public table for events, stream state, or state caches.
2. The library exports **no views**. Views cannot be private, so any view the library shipped would
   be a data leak. It exports *factories* that require an authorization predicate.
3. Reducer arguments are untrusted input: validate event id shape, batch size, and that every
   `eventType` is registered before writing.

---

## 6. Core tables

```ts
// src/server/tables.ts
import { table, t } from 'spacetimedb/server';

export const esStream = table(
  { name: 'es_stream',
    indexes: [{ accessor: 'byType', algorithm: 'btree', columns: ['streamType'] }] },
  {
    streamId: t.string().primaryKey(),
    streamType: t.string(),      // 'counter', 'invoice'
    version: t.u32(),            // last appended version, 0 = empty
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    metadata: t.option(t.string()),
  },
);

export const esEvent = table(
  { name: 'es_event',
    indexes: [
      { accessor: 'byPosition',      algorithm: 'btree', columns: ['position'] },
      { accessor: 'byStreamVersion', algorithm: 'btree', columns: ['streamId', 'version'] },
      { accessor: 'byStreamTime',    algorithm: 'btree', columns: ['streamId', 'createdAtMicros'] },
      { accessor: 'byType',          algorithm: 'btree', columns: ['eventType'] },
    ] },
  {
    eventId: t.string().primaryKey(),   // client-supplied UUIDv7 → idempotent retries
    position: t.u64(),                  // gapless global order from es_head
    streamId: t.string(),
    streamType: t.string(),
    version: t.u32(),                   // 1-based, per stream
    eventType: t.string(),              // index key + registry key (always present)
    data: t.string(),                   // canonical JSON (typed-enum mode swaps this column)
    metadata: t.option(t.string()),     // correlation / causation JSON
    createdAt: t.timestamp(),
    createdAtMicros: t.u64(),
    createdBy: t.identity(),
  },
);

export const esHead = table(
  { name: 'es_head' },
  { name: t.string().primaryKey(), position: t.u64() },   // single row: 'global'
);
```

- **`position` comes from a counter row, not `autoInc()`.** Auto-increment values are allocated in
  batches, can contain gaps, and consecutive inserts are not guaranteed to be ordered. A catch-up
  cursor needs a contiguous commit-ordered log. Incrementing `es_head` inside the append
  transaction is safe because transactions serialize, and it costs one hot row.
- **`streamType`** replaces "one table per aggregate" and lets one store host many bounded contexts.
- **`createdAtMicros`** exists only because `Timestamp` is not an indexable column type.

---

## 7. Appending events and optimistic concurrency

```ts
// src/server/append.ts
export const ANY = -1;            // no expectation
export const NO_STREAM = 0;       // stream must not exist
export const STREAM_EXISTS = -2;  // stream must exist

export function appendToStream(ctx, args: {
  streamId: string;
  streamType: string;
  events: EncodedEvent[];
  expectedVersion: number;
  metadata?: string | null;
}): number {
  const { streamId, streamType, events, expectedVersion } = args;
  if (events.length === 0) return ctx.db.esStream.streamId.find(streamId)?.version ?? 0;

  // 1) Idempotent replay of the same batch. MUST run before the version check.
  const existing = events.map(e => ctx.db.esEvent.eventId.find(e.eventId));
  if (existing.every(r => r !== null)) {
    if (existing.some(r => r!.streamId !== streamId))
      throw new SenderError('ES_EVENT_ID_CONFLICT: event id used by another stream');
    return existing[existing.length - 1]!.version;
  }
  if (existing.some(r => r !== null))
    throw new SenderError('ES_PARTIAL_DUPLICATE: some event ids were already appended');

  // 2) Optimistic concurrency.
  const stream = ctx.db.esStream.streamId.find(streamId);
  const current = stream?.version ?? 0;
  if (stream && stream.streamType !== streamType)
    throw new SenderError(`ES_STREAM_TYPE_MISMATCH: ${stream.streamType} != ${streamType}`);
  if (expectedVersion === ANY) { /* ok */ }
  else if (expectedVersion === NO_STREAM && current !== 0)
    throw new SenderError(`ES_EXPECTED_VERSION_MISMATCH: expected no stream, found ${current}`);
  else if (expectedVersion === STREAM_EXISTS && current === 0)
    throw new SenderError('ES_EXPECTED_VERSION_MISMATCH: expected existing stream');
  else if (expectedVersion >= 0 && expectedVersion !== current)
    throw new SenderError(`ES_EXPECTED_VERSION_MISMATCH: expected ${expectedVersion}, found ${current}`);

  // 3) Append.
  let version = current;
  for (const e of events) {
    version += 1;
    ctx.db.esEvent.insert({
      eventId: e.eventId,
      position: nextPosition(ctx),
      streamId, streamType,
      version,
      eventType: e.eventType,
      data: e.data,
      metadata: e.metadata ?? args.metadata ?? null,
      createdAt: ctx.timestamp,
      createdAtMicros: ctx.timestamp.microsSinceUnixEpoch,
      createdBy: ctx.sender,
    });
  }
  if (stream) ctx.db.esStream.streamId.update({ ...stream, version, updatedAt: ctx.timestamp });
  else ctx.db.esStream.insert({
    streamId, streamType, version,
    createdAt: ctx.timestamp, updatedAt: ctx.timestamp,
    metadata: args.metadata ?? null,
  });
  return version;
}
```

Order matters: dedupe **before** the version check, otherwise a retry of a committed batch reports a
false concurrency error for work that already succeeded.

Concurrency notes:

- `expectedVersion` is what the caller *believes* is current: `NO_STREAM`, a concrete version, or `ANY`.
- A mismatch throws before any insert, so nothing is half-applied; the `es_head` bump rolls back too.
- No `FOR UPDATE` equivalent is needed: transactions are serializable and serialized per database.
- Errors use stable `ES_*` prefixes so clients can pattern-match; the message carries expected/found.
- The per-stream version is the concurrency token. The global position is not.

> **Historical pre-M15 example.** Before R9, an app could export a generic `appendEvents` reducer.
> M15 removes that public surface: only app-defined command reducers may append, and they derive the
> event envelope server-side (§18).

In the pre-M15 design, the reducer was app-owned and one line:

```ts
export const appendEvents = spacetimedb.reducer({ /* args */ }, (ctx, args) => {
  const version = appendToStream(ctx, args);
  applyInline(ctx, projections, rowsOf(args));   // v1 inline read models
  return;                                        // reducers return nothing
});
```

Because a reducer returns nothing, the client learns the new version by observing its subscription or
view. Failures reject the client promise and roll the whole transaction back.

---

## 8. Reads, aggregation, time travel

```ts
export function readStream(ctx, streamId: string, opts: {
  fromVersion?: number;
  atVersion?: number;
  atTimestampMicros?: bigint;
  limit?: number;
} = {}) {
  const from = opts.fromVersion ?? 1;
  const to = opts.atVersion ?? 0xffff_ffff;

  // Pick the narrower index when both bounds are present, then filter the remainder in code.
  let rows = opts.atTimestampMicros !== undefined && opts.atVersion === undefined
    ? [...ctx.db.esEvent.byStreamTime.filter([streamId,
        new Range({ tag: 'unbounded' }, { tag: 'included', value: opts.atTimestampMicros })])]
    : [...ctx.db.esEvent.byStreamVersion.filter([streamId,
        new Range({ tag: 'included', value: from }, { tag: 'included', value: to })])];

  if (opts.atTimestampMicros !== undefined && opts.atVersion !== undefined)
    rows = rows.filter(r => r.createdAtMicros <= opts.atTimestampMicros!);

  rows.sort((a, b) => a.version - b.version);
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}
```

- **Stream aggregation** is `fold(initial, readStream(...), handlers)`. It runs on every command
  through the repository; it is not a debug tool.
- **Time travel** needs no extra storage. Version and timestamp bounds intersect.
- Events written in one transaction share `ctx.timestamp`, hence the sort by version.
- **System time is not business time.** `ctx.timestamp` is processing time. "Balance on 1 March"
  needs an effective date inside the event payload. Both bounds are offered; the bitemporal
  distinction is documented, not papered over.

### Where time travel surfaces

| Surface | Who | Why |
| --- | --- | --- |
| `readStream` / `aggregateStream` helpers (module code) | app authors | rebuild state, backfill read models, tests |
| App-defined per-caller view wrapping `streamAt` factory | admins / support | dispute investigation, audit |
| `spacetime sql` recipes | operators | ad-hoc inspection without new API surface |
| App-defined admin reducer calling `verifyState`/`repairState` | operators | drift repair |

Six real use cases, only one of which is debugging: state-cache rebuild after a fold fix, read-model
backfill, drift repair, audit/compliance, tests, and debugging.

`es_stream_at`-style views come from a factory that **requires** an authorization predicate, because
views are always public:

```ts
export const streamAt = es.viewFactories.streamAt({
  name: 'es_stream_at',
  authorize: (ctx, streamId) => ctx.db.streamOwner.streamId.find(streamId)?.owner === ctx.sender,
});
// app exports it; the library never exports a view itself
```

Caveats baked into the docs: parameterized views take SQL-literal arguments only (no typed query
builder), return no primary-key metadata (insert/delete callbacks only), and all arguments of one
view share a single client cache, so callbacks do not say which argument produced a row.

---

## 9. Aggregates, repositories and the state cache

### 9.1 Aggregate

```ts
export abstract class Aggregate {
  version = 0;
  #uncommitted: DomainEvent[] = [];

  constructor(readonly id: string) {}

  protected abstract when(event: DomainEvent): void;          // replay
  protected raise(event: DomainEvent) {                       // decide
    this.when(event);
    this.#uncommitted.push(event);
  }
  apply(event: DomainEvent, version: number) { this.when(event); this.version = version; }
  dequeueUncommitted() { const out = this.#uncommitted; this.#uncommitted = []; return out; }
}
```

The functional form (`decide(state, command) => events`, `evolve(state, event) => state`) ships as
`defineAggregate` in v1.1. The class keeps parity with the workshop.

### 9.2 State cache (replaces "snapshots")

The app owns one typed table per aggregate kind and passes an adapter. The library never sees the
row shape.

```ts
export type StateCache<TState> = {
  load(ctx: Ctx, streamId: string): { version: number; state: TState } | null;
  save(ctx: Ctx, streamId: string, version: number, state: TState): void;
  remove(ctx: Ctx, streamId: string): void;   // rebuild
};
```

```ts
find(ctx, id, opts) {
  const stream = ctx.db.esStream.streamId.find(id);
  if (!stream) return null;

  const agg = this.create(id);
  const cached = this.stateCache?.load(ctx, id);

  // The version guard: stale or time-travelling caches are ignored, never trusted.
  const usable = cached
    && cached.version <= stream.version
    && (opts.atVersion === undefined || cached.version <= opts.atVersion)
    && (opts.atTimestampMicros === undefined || cached.version <= stream.version);

  if (usable) { this.hydrate(agg, cached.state, cached.version); }

  for (const row of readStream(ctx, id, { fromVersion: agg.version + 1, atVersion: opts.atVersion }))
    agg.apply(this.decode(row), row.version);

  return agg;
}
```

Why this is safe to "always keep up to date":

- The cache is written **in the same transaction** as the events it summarizes, so it can never
  describe uncommitted state.
- If an append path forgets to write it, the *guard* turns a correctness bug into a performance
  regression: a stale row is ignored and replayed over.
- If a `when()` handler is fixed, the blast radius is bounded by the guard only if the cache version
  is invalidated. Therefore a fold change requires a rebuild, and `doctor` detects the mismatch
  between `cached.version` and `stream.version` (it cannot detect a same-version logic change —
  that is what contract tests and the publish smoke test are for).
- Cost: full state written on every append. Fine for small aggregates; measure before using it for
  megabyte-sized state.

This is a **current-state projection**, not a snapshot. It is not disposable, and views may read it.
Naming it "snapshot" invites someone to delete it and expect correctness to survive.

---

## 10. Projections: views first, materialization when forced

### 10.1 The constraints that decide everything

From the 2.0 view documentation:

1. **Views are always public.** No private views exist.
2. **Procedural views cannot `.iter()`.** They may use `.find()`, `.filter()` on indexed columns, and
   `count()`. Anything a view reads becomes its *read set*; any change to the read set re-runs the
   whole view body.
3. **`ctx.from` (the query builder) exists only in views** and is evaluated incrementally by the
   query engine, so declarative filters, semijoins and full scans are fine there.
4. **Anonymous views are computed once and shared** with every subscriber; per-caller views are
   computed per subscriber.
5. **Module code cannot query a view.** There is no `ctx.db.<view>`. Another reducer needs a table.
6. **Views with arguments** take positional SQL literals only, have no primary key, and cannot add
   `WHERE`, aggregates or joins at subscription time.
7. **A view that returns duplicate primary keys fails the transaction that triggered the refresh.**

So "view or materialized table" is not a taste question. It is decided by four questions:

1. Does any reducer need to read it? → **materialized** (views are client-only).
2. Can it be expressed with indexed lookups or a declarative query? → if not, **materialized**.
3. Do you need a *computed index* (rank, precomputed total, sort key) that no base column carries?
   → **materialized**.
4. Is the read set huge and rewritten constantly, so the view re-runs on every write? → **materialized**.

### 10.2 Scenario A — order summary (view, the default)

`order_state` is app-owned and private: `orderId` PK, `version`, `status`, `totalCents`, `lineCount`,
`customerId` (btree). Written inline by the append.

```ts
export const orderSummary = spacetimedb.anonymousView(
  { name: 'order_summary', public: true },
  { orderId: t.string() },
  t.option(t.row('OrderSummary', {
    orderId: t.string(), status: t.string(), totalCents: t.i64(), lineCount: t.u32(),
  })),
  (ctx, { orderId }) => {
    const row = ctx.db.orderState.orderId.find(orderId);           // PK lookup: allowed
    return row && { orderId: row.orderId, status: row.status,
                    totalCents: row.totalCents, lineCount: row.lineCount };
  },
);
```

One indexed row read, no storage, nothing to rebuild, no staleness. Anonymous → computed once for all
subscribers. This is the correct default for per-entity read models.

### 10.3 Scenario B — "revenue this month" (materialized, cross-aggregate)

A procedural view cannot `iter()` every order. It *can* read the month's orders through an index:

```ts
// allowed, if order_state.month is indexed — read set = this month's orders
let cents = 0;
for (const o of ctx.db.orderState.month.filter('2026-11')) cents += o.totalCents;
```

That is viable while a month holds hundreds of orders. When it holds hundreds of thousands and
changes on every write, the view re-runs constantly over a huge read set. Materialize instead:

```ts
// app-owned, private
const revenueByMonth = table({ name: 'revenue_by_month' }, {
  month: t.string().primaryKey(),
  totalCents: t.i64(),
  orderCount: t.u32(),
  version: t.u64(),          // last event position folded into this row
});
```

Updated in the same transaction as the append. Prefer a **delta** update (`+ cents`) when the event
is a delta; recompute the row when an order can be edited or cancelled after the fact. Delta updates
are cheap and are also the easiest way to get the arithmetic wrong, so the contract test compares the
materialized row against a full replay.

### 10.4 Scenario C — leaderboard / pagination (materialized, needs an index you can't derive)

"Weekly top 100, page 3" needs a stable sort key, and the ranking is not a column of any base table.
A view cannot carry its own index, and a per-caller view would recompute the ranking per subscriber.
Materialize `(week, rank)` or `(week, score)` with a btree index, then the client subscribes to an
indexed range. This is also the case the official leaderboard guide materializes.

### 10.5 Scenario D — time-travel probe (view, rare and bounded)

`es_stream_at(stream_id, version)` reads two indexed ranges for one stream and folds it for one
admin. Read set = that stream. No storage, no rebuild, and its cost collapses to zero when nobody is
subscribed. Use a `view` (per-caller) with an authorization check, because the events are private.

### 10.6 Scenario E — per-user inbox (view, and only a view)

A public table is all-or-nothing: subscribing exposes every row. A per-caller view filtered by
`ctx.sender` is the only clean way to give each client a different slice of a private table. The cost
is per-subscriber computation, so keep the read set indexed and small. Design for anonymous views
when a shared shape works ("inbox for team X" rather than "my inbox").

### 10.7 Decision table

| Read model | Mechanism |
| --- | --- |
| Per-entity detail, cheap, O(1) from a state table | **anonymous view** |
| Same, but filtered per caller | **per-caller view** |
| Cross-aggregate filter/join expressible declaratively | **`ctx.from` view** (incremental) |
| Cross-aggregate over a bounded index range | anonymous view, until the read set churns |
| Needs to be read by a reducer | **materialized table** |
| Needs a computed index (rank, sort key, rollup) | **materialized table** |
| Huge read set, hot writes, many subscribers | **materialized table** (v1.1: + pump) |
| Needs pagination over a stable order | **materialized table** |

### 10.8 Inline projection API (v1)

```ts
export type InlineProjection = {
  name: string;
  handles: readonly string[];
  handle(ctx: Ctx, event: StoredEvent): void;   // must be deterministic and side-effect free beyond ctx.db
};

export function applyInline(ctx: Ctx, projections: InlineProjection[], rows: StoredEvent[]) {
  for (const row of rows)
    for (const p of projections)
      if (p.handles.includes(row.eventType)) p.handle(ctx, row);
}
```

- Runs inside the append transaction: atomic with the events, no eventual consistency, no rebuild
  machinery.
- Costs write amplification and reducer time. In Spacetime that cost is not local: transactions
  serialize per database, so a slow projection slows *every* write. This is the real argument for
  the async pump.
- `rebuildBatch(ctx, projection, { fromPosition, limit, reset? })` lets an app-gated admin reducer
  rebuild in bounded transactions.

---

## 11. The async checkpoint pump (v1.1)

### What it is

Append writes only events (+ head). A scheduled reducer wakes on an interval, reads
`position > checkpoint`, applies each event to the materialized tables, and advances the checkpoint —
all in one transaction per batch.

```ts
export function drain(ctx, projections: AsyncProjection[], max = 500) {
  for (const p of projections) {
    const cp = ctx.db.esCheckpoint.name.find(p.name) ?? { name: p.name, position: 0n };
    const batch = [...ctx.db.esEvent.byPosition.filter(
      new Range({ tag: 'excluded', value: cp.position }, { tag: 'unbounded' }),
    )].slice(0, max);

    for (const row of batch) p.handle(ctx, row);
    if (batch.length) {
      const position = batch[batch.length - 1].position;
      if (cp.position === 0n)
        ctx.db.esCheckpoint.insert({ name: p.name, position, updatedAt: ctx.timestamp, error: null });
      else
        ctx.db.esCheckpoint.name.update({ ...cp, position, updatedAt: ctx.timestamp, error: null });
    }
  }
}
```

### Concrete example

An order module with four read models: `order_state`, `revenue_by_month`,
`customer_lifetime_value`, `product_sales`.

- **Inline:** every `OrderPlaced` append writes the event, bumps the head, and runs four handlers.
  Five-plus writes per append, all serialized. A `TypeError` in the CLV handler — say a null country —
  makes *order placement itself fail*. Deploying a fifth read model means republishing and backfilling.
- **Pump:** append is two writes. The pump runs every second, drains ≤500 events, updates four tables.
  A broken handler rolls back its batch, records the error, and leaves writes working. A new read
  model starts at checkpoint 0 and backfills itself through the same pump.

### Costs, stated honestly

- **Lag.** The read model trails the log by up to one tick plus batch duration. Any command that must
  read the read model *before* deciding cannot use a pumped projection — compute from events or
  materialize inline.
- **Determinism, not idempotency, is the contract.** Checkpoint and writes commit together, so a
  failed batch replays against identical pre-batch state. What breaks is a handler that reads
  `ctx.timestamp` (pump time, not event time) or `ctx.random`, or a rebuild that replays over rows
  that were never reset. Handlers must be pure functions of (event, current table state).
- **Poison events.** One bad event wedges the projection. Needs an attempt counter plus a
  dead-letter/quarantine rule.
- **Operational surface.** Timer row, checkpoint table, rebuild reducer, error field, monitoring.
- **It still competes with writes** because transactions serialize. Batches must stay small.

### Recommendation: v1.1

Defer it, and design v1 so it is additive:

1. `InlineProjection.handle(ctx, event)` is already the pump's handler signature.
2. `es_event.byPosition` and gapless `position` exist in v1, so the cursor is ready.
3. Adding `es_checkpoint`, a timer table and a scheduled reducer later is a safe automatic migration
   (verified: adding tables and indexes never requires `--delete-data`).
4. The hard part — event schema, concurrency, state-cache guard — should be proven first.

Ship inline in v1 plus `rebuildBatch`. If a read model becomes too expensive, move that one handler
to the pump in v1.1 without touching the event model.

---

## 12. Enforcement: the library cannot own app schema

The package enforces shape and behavior, not table definitions:

1. **Compile-time adapters.** `StateCache<TState>`, `InlineProjection`, and the event registry are
   typed. A wrong column or row shape is a TypeScript error in the app.
2. **Version guard.** Stale caches are ignored, not trusted (§9.2).
3. **Contract tests** (`stdb-es/testing`) run the app's actual module through the harness and fail on
   drift:

   > **Historical pre-M15 shape shown.** The server-only `append` seam is still supported for seeding
   > store invariants; M15 adds the optional `commands` block for the browser boundary (§18.3 and
   > API reference §4.3).

   ```ts
   runEventStoreContractTests({
     name: 'counter contract',
     spacetimedb,
     moduleExports: { appendEvents },
     append: (ctx, args) => appendEvents(ctx, args),
     streamId: () => streamId(STREAM_PREFIXES_COUNTER.counter, '1'),
     streams: [{ streamType: STREAM_TYPES_COUNTER.Counter, repository, stateCache, replay, sample }],
     projections: { projections, snapshot },
     views: [{ name, view, params, seed, check }],
   });
   ```

   Covered invariants: append/concurrency/dedupe; `cache.version === stream.version` after every
   append; cached state equals full replay; time travel; structural integrity; same-version drift
   detection and repair; incremental projection equals rebuild-from-zero; every registered view
   returns the expected rows for a seeded fixture.
4. **Doctor helpers** (pure functions, no exported reducers, per the admin decision):
   `findDrift(ctx, streams)`, `verifyStreamIntegrity(ctx, id)`, `verifyStreamState(ctx, id, opts)`,
   `repairStream(ctx, id, opts)`. The app exposes its own gated reducer if it wants a button.
5. **SQL recipes** in the docs for inspection and repair without new API surface.
6. **Publish smoke test.** After publishing to a scratch database, query every registered view with
   `spacetime sql` and assert on the seeded fixture. This is what catches "the view compiles but
   returns nothing", which no unit test does.

---

## 13. Client SDK

Shared surface (from `.`, usable in module and client code):

```ts
streamId(prefix, key);  // '<prefix>-<key>'; validates shape and the 256-character limit
```

App-owned constants (`STREAM_TYPES_*`, `STREAM_PREFIXES_*`, `EVENT_TYPES_*`, `TABLES_*`, `VIEWS_*`,
`ROWS_*`) stay in each domain's `constants.ts`, not in the core package.

Client surface:

> **Historical pre-M15 surface.** The `encodeEvents` and `createEventStoreClient(...).append/.retry`
> lines below are the baseline that R9 replaces. The shipped client exports `createCommandClient`
> plus read-side codecs and subscription helpers; see §18 and the API reference.

```ts
createEventRegistry({ typeOf, events });          // encode/decode/upgrade per event type
encodeEvents(registry, events, { newEventId?, metadata? });
decodeEvent(registry, row);
createEventStoreClient({ append, registry, newEventId? });
  // encode / append / retry / decode / decodeAll
sliceRows(decodedRows, { streamId?, fromVersion?, atVersion?, atTimestampMicros?, limit? });
viewQuery(name, args);  tableQuery(name);  sqlLiteral(value);
subscribeEventRows({ connection, query, readRows, onRows, onError?, streamId? });
createStreamSubscription({ connection, query(streamId), readRows, onRows });
```

- Historically, `append` called the app's generated reducer and `retry` re-sent the exact encoded
  batch, event ids included, so a timeout after a commit settled as a replay.
- `decode` turns `{ eventType, data }` into a discriminated union. Upcasters live here, so old events
  read as current types.
- The historical append client and `sliceRows` owned no state; they filtered rows a subscription
  already delivered.
- **Shipped (M5):** `subscribeEventRows` binds a view/table/raw query to row handlers, filters rows by
  stream, registers callbacks once so SDK reconnect replay refreshes them, and routes errors to
  `onError` or rethrows them. `createStreamSubscription` keeps one per-stream query active and ignores
  stale callbacks after a switch.
- The client entry is browser-safe; integration-test tooling is a separate Node-only entry (R3).
- **Superseded by R9 / M15 / §18 (implemented):** the `append`/`retry` path above and the generic
  `makeAppendReducer` factory are removed from the browser-facing write path. Frontend code calls
  generated command reducers with a typed command payload; decoding, upcasting, subscriptions, and
  `sliceRows` remain unchanged. This bullet records the baseline that M15 replaced; it does not alter
  the M0–M8 history.

---

## 14. Testing strategy

Four layers, cheapest first. Keep them separate in exports, documentation, and CI.

### 14.1 Layer 1 — core package unit tests (maintainers)

Shipped: `npm test` runs the offline suite with the in-memory harness. No server, no network.

| Workshop exercise | Our test |
| --- | --- |
| 01 CreateStreamsTable | append creates `es_stream` with version 1 and type |
| 02 CreateEventsTable | row shape, position increments, `byStreamVersion` ordering |
| 03 AppendEventFunction | N events → version N; empty stream = 0 |
| 04 OptimisticConcurrency | stale expected version throws, nothing written; NO_STREAM / ANY |
| 04 EventStoreMethods | readStream ranges, getStreamState, listStreams |
| 05 StreamAggregation | fold counter state from events |
| 06 TimeTraveling | atVersion and atTimestamp both replay prefixes |
| 07 AggregateAndRepository | find loads state, save appends uncommitted, stale save fails |
| 08 Snapshots | state cache hit, stale cache ignored, cache-after-time-travel ignored |
| 09 Projections | inline rows match events; rebuild converges |

Package-specific: batch replay idempotency, partial-duplicate rejection, gapless position across
streams, `es_head` rollback, state-cache drift detection, view fixture parity, payload validation,
subscription replay/pruning/error propagation, and every stable `ES_*` error code.

Floor for R1: every public export has a direct test or is exercised by the contract suite; every
`ES_*` error has a rejection test; `npm test` and `npm run build` are green offline. The contract
suite is dogfooded (`test/contracts.test.ts`) so consumer tooling cannot rot.

### 14.2 Layer 2 — consumer unit tests (`stdb-es/testing`, R2)

Shipped: `runEventStoreContractTests`, `wireEvents`, `withIndexRanges`, and the M6/M15 kit:

```ts
createModuleTest(spacetimedb, { ... });      // harness transaction + Range wrapper
ids('evt', n);                               // deterministic, retry-safe fixture ids
expectAppendError(fn, ES_ERROR.EXPECTED_VERSION_MISMATCH);
createFakeCommand({ result?, error? });      // client tests: records intent + commandId
createFakeAppend({ result?, error? });       // deprecated migration aid only
```

`createModuleTest` returns `tx`, `call`, `view`, `anonymousView`, and the underlying harness. All
contexts are shimmed automatically. `createFakeCommand` supports queued `nextResult`/`nextError`
replies for timeout-and-retry sequences; `createFakeAppend` is kept only for consumers midway through
the M15 migration. The task-oriented guide lives in `docs/unit testing.md`.

Rules: no network, no Node built-ins, no server. Runner-agnostic except the optional `vitest` peer
that the contract suite imports. A consumer needs one import and roughly ten lines for a first
meaningful test; `test/unit-kit.test.ts` dogfoods the kit.

### 14.3 Layer 3 — consumer integration tests (`stdb-es/testing/integration`, R3)

Shipped in M7. The Node-only entry owns the lifecycle unit tests cannot:

```ts
const env = await createIntegrationEnv({
  server: 'local', // or an explicit server URL
  database: `my-app-test-${nonce}`,
  modulePath: 'spacetimedb',                  // publishes with --delete-data
});
await env.call('increment', [/* positional CLI args: counterId, by, commandId */]);
await env.sql('SELECT version FROM es_stream');                  // owner
await env.sql('SELECT * FROM summary', { anonymous: true });     // public view
const client = await env.connect({
  anonymous: true,
  queries: ['SELECT * FROM summary'],
});
await client.waitFor((c) => c.rows('summary').length === 1);
await env.dispose();
```

The reducer name and positional order are app-defined; the example assumes an
`increment(counterId, by, commandId)` reducer.

- Readiness check, publish, identities, SQL result parsing, subscription convergence, parameterized
  view subscriptions, stale-version rejection, replay after cache loss, and teardown.
- For `server: 'local'`, it spawns and owns `spacetime start --in-memory --non-interactive` and stops
  that child in `dispose()`. For an explicit URL, it connects to that server and does not stop a
  process it did not start (see §17).
- No `vitest` dependency; callable from any Node test runner or a plain script.
- Must cover: two identities appending concurrently; live subscription convergence; parameterized
  views with literal arguments; cache hit versus replay on a long stream; anonymous view access; and
  stale-version rejection end to end.
- Status: shipped. `src/testing/integration/` is the consumer tool; `scripts/integration-kit-smoke.mjs`
  dogfoods local and external URL modes, and `test/integration-kit.test.ts` covers the pure helpers
  offline. `examples/sets/counter-with-frontend/integration/` is the consumer-style showcase suite.
  The guide lives in `docs/integration testing.md`. The older `scripts/smoke-example.mjs` remains the
  library-specific full recovery smoke.

### 14.4 Layer 4 — maintainer live smoke

`npm run smoke` publishes the counter with `--delete-data`, sends command reducers, checks deterministic
event ids and idempotent replay, rejects a non-owner command, deletes a cache row to prove replay-based
recovery, and queries the anonymous view. It runs against `spacetime start --in-memory`.

### 14.5 CI (R5)

`.github/workflows/ci.yml` runs on push, pull request, and manual dispatch. It pins Node `24.22.3`
and SpacetimeDB CLI `2.15.0`, then gates on build, library and example typechecks, offline
`vitest run`, a packed fresh-workspace install (`npm run check:pack`), the live maintainer smoke, and
the consumer integration smoke (`npm run smoke:integration`) on disposable in-memory local servers.
The pack check verifies the published `exports` map and shipped declarations from module-like and
web-like workspaces; it loads browser-safe entry points at runtime and typechecks `stdb-es/server`,
which needs the SpacetimeDB host to execute. Workflow configuration is committed here; a GitHub
Actions run has not yet been observed.

---

## 15. Milestones

### 15.1 Core, tooling, and documentation

| # | Deliverable | Exit criteria | Status |
| --- | --- | --- | --- |
| M0 | Skeleton, `examples/counter`, publish locally; verify composite range filters, parameterized views, view read-set behavior, reducer factory typing | build + one harness test + one live subscription | done |
| M1 | Tables, `appendToStream`, error codes, dedupe, head counter, payload mode chosen | exercises 01–04 green | done |
| M2 | `readStream`, `getStreamState`, `aggregateStream`, time travel, view factories | 05–06 green; SQL time-travel recipe works | done |
| M3 | Aggregate, Repository, state cache + version guard, registry codec | 07–08 green; cache parity test green | done |
| M4 | Inline projections + `rebuildBatch` + view factories + contract tests + **core unit-test floor** | 09 green; drift + smoke green; every public export covered offline | done |
| M5 | Shared `streamId` helper, client SDK completion (subscription helper), npm metadata, CI gate | `streamId` shape/limit/error tests green; 8 subscription-helper tests green (93 total); CI workflow runs build + typecheck + unit + pack + smoke; fresh-app `npm pack` check passed locally | done |
| M6 | **Consumer unit-test kit** (`stdb-es/testing`) | fake append, id helpers, module-test wrapper, and failure assertions shipped; 10 kit tests pass offline; a one-import, ~10-line consumer test needs no server | done |
| M7 | **Consumer integration-test kit** (`stdb-es/testing/integration`) | one call creates, publishes, and tears down a disposable database; concurrency, subscription, and anonymous-view cases green locally and remotely | done |
| M8 | **Developer documentation**: `docs/usage-guide.md`, `docs/API.md`, README glossary | all four guide parts present; every shipped export documented with inputs/outputs; README glossary links to both documents | documentation done |
| M15 | **Backend-owned command writes** (breaking change; §18) | Phases 1–6 in §18.6 complete: no browser path can call a generic append; commands are declared in the module and mirrored by `spacetime generate`; counter reducers `increment`/`decrement`/`reset` enforce ownership; package, kits, examples, and docs migrated; full suite green | **done — Phases 1–6 complete** |

M1 is the keystone: if dedupe/version/position ordering is wrong, everything downstream inherits it.
M6 comes before M7: the fakes define the seams the integration kit exercises. M15 is separate from
M9–M13: it changes the write contract for shipped pieces and does not start the paused example-set
sequence.

### 15.2 Example sets (one implemented baseline; M9–M13 planned)

Each set is one vertical slice: **publishable module app code + a simple React client with a basic
UI**. The existing `examples/counter` remains the basic warm-up; these sets deliberately start at
intermediate concepts. Keep each set small: one or two streams per domain, one state table, one read
model, one screen, one contract test file. Do not re-teach basic append/read mechanics in every set.

The baseline set `examples/sets/counter-with-frontend` is implemented. Since M15 it demonstrates the
full loop — app-owned constants, `streamId`, client event registry, backend-owned command reducers,
state cache with replay-on-miss, anonymous view subscription, and a one-screen React UI — with
`npm run example:set:counter:start`. It does not replace any of the concept-focused sets below.

| # | Example set | Concept focus | Module app code | Simple React UI | Explicitly out of scope |
| --- | --- | --- | --- | --- | --- |
| **M9** | **Idempotent order intake** (pre-M15 sketch; deferred) | Idempotency; optimistic concurrency; retry after timeout | Pre-M15 sketch: `PlaceOrder` stream; browser `newEventId`; `expectedVersion: NO_STREAM`; fake-append test. Under R9/M15 these become caller `commandId`, module-derived event ids, and command-boundary tests. | Order form, submit button, retry button, result banner showing `appended` vs `replayed` via the version view | No payments, no inventory, no multi-domain split |
| **M10** | **Eventually consistent delivery tracker** | Eventual consistency between independent aggregates and client views; read-your-writes polling | `Delivery` stream plus a `Courier` stream updated by separate reducers; head view for the known version; anonymous location read model; tests assert convergence, not instant global state | Shipment status card, location list, “refresh until version N” control, pending indicator | No async pump, no cross-aggregate compensation, no payment flow |
| **M11** | **Cross-aggregate money transfer** | Cross-aggregate coordination; process state; compensating failure | `Account` streams for two owners plus one `Transfer` process stream; `TransferRequested → Debited → Credited/Reversed`; deterministic inline projection; contract test for balanced totals | Two balances, transfer form, transfer timeline, failed/compensated state | No general saga framework, no multi-domain layout, no schema migration |
| **M12** | **Multi-domain storefront** | Multiple domains; bounded-context boundaries; domain-separated project structure | `orders`, `inventory`, `billing` folders; one schema per module but one stream type registry per domain; domain-local caches/projections/views; cross-domain IDs only, never shared event unions | Three small panels with one shared provider; each domain owns its registry, hooks, and components | No new event-sourcing primitive, no transfer saga, no schema-evolution story |
| **M13** | **Schema evolution** | Event schema evolution; upcasters; additive event types; cache rebuild after a fold change | `Payment` stream with legacy `CardChargedV1` payload and `CardChargedV2`; `upgrade` in the registry; one additive `PaymentMethodAdded` event; doctor-driven cache repair; fixture containing old rows | Payment list showing old and new events decoded to one current union; “rebuild cache” admin button behind an app gate | No business complexity, no multi-domain setup, no eventual-consistency demo |

Each example milestone exits only when all of the following are true:

1. The module publishes to a scratch database with `stdb-es` resolved from the workspace.
2. `docs/API.md` and `docs/usage-guide.md` examples are checked against the set and amended if the
   set exposes a documentation gap.
3. The contract suite covers the set's aggregate and projections.
4. The React client builds and demonstrates the named concept with visible UI state.
5. A short README in the set explains what it teaches and what it deliberately omits.

The implementation of M9–M13 remains **paused pending an explicit go signal**. Only their scope is
recorded here; the implemented full-stack baseline does not start that sequence.

### 15.3 Deferred

| # | Deliverable | Exit criteria | Status |
| --- | --- | --- | --- |
| M14 (v1.1) | Async pump, checkpoint, dead-letter, scheduled rebuild | pump lag measured; poison-event test | deferred |

---

## 16. Risks and decisions

| Risk / decision | Stance |
| --- | --- |
| Typed enum payload vs JSON string | **JSON only in v1; typed enum spiked, not shipped.** Spike: adding a variant is automatic and non-destructive; changing a variant is a manual migration. Mode would be fixed at schema construction. |
| No composite unique constraint | Enforced in the reducer; safe because transactions serialize. `eventId` PK gives cross-stream dedupe. |
| `autoInc` is not a commit-order cursor | Explicit `es_head` row incremented in the append transaction. |
| `Timestamp` not indexable | `createdAtMicros: u64` + `byStreamTime`. |
| Views are always public | Library ships no views; factories require an authorization predicate. |
| Procedural views cannot `.iter()` | Decision table in §10.7; query builder or materialization when scans are needed. |
| Per-caller views scale with subscribers | Prefer anonymous views; use per-caller only for real per-user data. |
| Views cannot be read from reducers | Materialize when module code needs the read model. |
| State cache can silently drift | Version guard makes stale caches self-healing; contract tests catch same-version logic drift; doctor detects version drift. |
| Inline projections stall all writes | Transactions serialize; keep handlers small, move heavy ones to the pump (v1.1). |
| Reducers return nothing | Client observes the new version via subscription/view. |
| Subscription args are literals | Helpers validate and escape; use table queries for dynamic filters on materialized models. |
| Stream id ownership | `streamId(prefix, key)` only formats/validates. Client-generated ids need module validation; module-generated ids require a view for discovery because reducers return void. Hybrid command ids are the recommended default. |
| **Client-shaped events / cross-stream writes** | **Security flaw in the original frontend write path (§18), fixed by M15/R9.** Reducers are public callables; a browser calling a generic append can choose `streamId`, `eventType`, and `data`. The fix removes that surface, sends commands to backend-owned reducers, derives stream ids and events server-side, and authorizes against `ctx.sender`. |
| Event table growth | Minimal indexes, tiered storage, never delete history; archival is an app decision. |
| Determinism | No clock/RNG/network. `ctx.timestamp`, `ctx.sender`, `ctx.random` only. |
| Library bundle size | Server entry depends only on `spacetimedb/server`; helpers tree-shakeable. |

---

## 17. Decisions

Resolved in v1:

1. **Package name and license:** `stdb-es`, MIT.
2. **Payload mode:** canonical JSON in `data: t.string()` is the shipped default. Typed enum is
   designed and spiked (additive variants migrate automatically) but not shipped.
3. **Aggregate form:** both shipped — `Aggregate` class plus `defineAggregate` functional helper.
4. **State-cache default:** app-owned typed table per aggregate kind. No shared generic JSON table.
5. **Integration kit lifecycle.** For `server: 'local'`, `createIntegrationEnv` spawns and owns
   `spacetime start --in-memory --non-interactive` with a unique temporary `--data-dir`, waits for
   readiness, and stops that child in `dispose()`. The isolated directory avoids `spacetime.pid`
   contention with other servers. For an explicit URL, it connects to the external server and never
   stops a process it did not start. The kit is Node-only and shipped in M7.
6. **Contract-test runner.** Keep `vitest` as an optional peer for the contract suite; the rest of
   `stdb-es/testing` stays runner-agnostic.

Still open: none at this time.

**Implemented in M15 (§18):** the frontend append path is replaced by backend-owned command reducers.
The browser sends an intent payload (command + idempotency key); the module decides stream id, event
types, event ids, authorization, and expected version, then appends. Commands are declared in the
module and mirrored to the frontend through `spacetime generate`. This is breaking:
`makeAppendReducer`, `createEventStoreClient`'s `append`/`retry`, and every generic `append_events`
call site are superseded. Active guides and the API reference document the command contract.

---

## 18. Frontend write boundary: commands instead of append (R9 / M15)

**Status: complete — requirement, implementation, examples, tooling, and documentation migrated through Phase 6.**
This section is the authoritative statement of the change. It does not alter the shipped M0–M8
record in §13–§17; it defines the breaking change that supersedes parts of it when delivered.

### 18.1 The flaw

SpacetimeDB reducers are public callables. The shipped browser write path hands client code the
whole event envelope: `createEventStoreClient(...).append(streamId, streamType, events, options)`
encodes events in the browser and passes `AppendCallArgs` to a generated `append_events` reducer
(§13), which `makeAppendReducer` builds from caller-supplied `streamId`, `streamType`,
`expectedVersion`, and an array of `{ eventId, eventType, data, metadata }` (§4). Consequences:

1. **Data shaping.** A browser user can send any `eventType` and any `data` string, bypassing the
   app's event registry and domain validation. The registry is only advisory on this path.
2. **Cross-stream writes.** `appendToStream` trusts the caller's `streamId`/`streamType`; it has no
   ownership check. A user can target any stream, including one owned by another user.
3. **Client-side authorization is not a boundary.** Any check in React event handlers or in a
   client helper can be skipped by calling the reducer directly from devtools or a script.
4. **Auditing is not prevention.** `createdBy: ctx.sender` records who wrote a bad row, but does not
   stop the write.

Therefore a raw append must not be reachable from browser-facing code, and a generic
`append_events` reducer must not remain exported from an app module — otherwise the flaw survives
even if the UI stops using the client helper.

### 18.2 Target contract

**The client sends intent (a command); the backend decides facts (events).**

| Concern | Shipped path (before) | Target path (M15) |
| --- | --- | --- |
| Frontend write call | `client.append(streamId, streamType, events, ...)` → generated `append_events` | generated `increment` / `decrement` / `reset` reducer with a command payload |
| Who builds the event envelope | browser (`encodeEvents`) | backend command reducer |
| Who chooses `streamId` / `streamType` | caller-supplied | derived server-side from validated command fields and an app-owned ownership table |
| Who chooses `eventType` / `data` | caller-supplied | backend event factory / registry |
| Who owns idempotency | browser `newEventId()` event ids | caller `commandId`; backend derives deterministic event ids from it |
| Who validates | browser registry (advisory) | backend command handler (authoritative), using `ctx.sender` |
| Public reducer surface | generic `append_events` | only app-defined command reducers |
| Reads | subscription / view / `decode` | unchanged |

The browser never supplies `streamId`, `streamType`, `eventType`, `data`, `eventId`, `position`, or
`expectedVersion`. Its entire write vocabulary is the set of command reducers the module exports.

### 18.3 Command payload contract

1. **Declared in the backend module.** A command is a plain SpacetimeDB type (for example
   `t.object('IncrementCounter', { counterId: t.string(), by: t.u32(), commandId: t.string() })`)
   used as a reducer argument type. Command names and shapes are part of the backend API.
2. **Mirrored to the frontend by `spacetime generate`.** Web code imports command payload types
   from its generated bindings (the counter set already generates into `web/src/generated/`); it
   must not redeclare them. A generated command reducer is the only callable write surface.
3. **Idempotency key.** Every command carries a caller-generated `commandId` (an opaque string;
   `newCommandId()` defaults to `crypto.randomUUID()`). The backend derives event ids deterministically
   from the command id, so a retry of the same command deduplicates in `appendToStream` instead of
   appending twice.
4. **Server-side derivation.** The reducer resolves `streamId` via app-owned constants
   (`streamId(STREAM_PREFIXES_COUNTER.counter, command.counterId)`), checks ownership against
   `ctx.sender`, validates domain rules (for example `by > 0`), builds encoded events, and calls
   `appendToStream` with a server-chosen `expectedVersion`.
5. **Failure semantics.** Invalid command, unknown stream, missing ownership, or stale version
   rejects before any write with a stable error code (app `CMD_*` or existing `ES_*`). Reducers
   still return `void`; the client observes the new state through its subscription/view (§7).
6. **No generic fallback.** `makeAppendReducer` and any exported `append_events` reducer are removed
   from the shipped write path (Phase 2 for the package, Phase 5 for the examples). Keeping one
   would leave a callable bypass.

### 18.4 Counter example migration

Both `examples/counter` and `examples/sets/counter-with-frontend` migrate in Phase 5. The web app
stops importing the generic append client and calls generated reducers with intent only:

```ts
// web: command payload types come from `spacetime generate`
await conn.reducers.increment({ counterId, by: 1, commandId: newCommandId() });
await conn.reducers.decrement({ counterId, by: 1, commandId: newCommandId() });
await conn.reducers.reset({ counterId, commandId: newCommandId() });
```

```ts
// module: the only place that appends for this stream type
export const increment = spacetimedb.reducer(IncrementCounter, (ctx, command) => {
  const stream = authorizeCounter(ctx, command.counterId); // throws for non-owners
  appendToStream(ctx, {
    streamId: stream.streamId,
    streamType: STREAM_TYPES_COUNTER.Counter,
    expectedVersion: stream.version,
    events: [encodeIncrement(command)], // event id derived from commandId
  });
  updateCounterStateCache(ctx, stream.streamId); // same inline path as today
});
// decrement and reset follow the same shape; no append_events reducer is exported
```

Acceptance for the example: a browser calling `increment` on another owner's `counterId` fails; a
retried command with the same `commandId` does not double-increment; the anonymous summary view and
`stream_events` subscription behave as before.

### 18.5 Compatibility and impact

This is a **breaking change** to the client write API and to module reducer exports. Affected
surfaces, all owned by phases in §18.6:

- `stdb-es/client`: `AppendCallArgs`, `AppendCall`, `EventStoreClientOptions.append`,
  `createEventStoreClient(...).append/.retry`, and browser-side `encodeEvents` for writes.
- `stdb-es/server`: `makeAppendReducer` (no longer a shipped write-path factory).
- `stdb-es/testing`: `createFakeAppend` (now deprecated in favor of `createFakeCommand`) and the
  contract suite's `appendEvents` seam (now augmented by optional command-boundary checks).
- `stdb-es/testing/integration` and smoke scripts: `env.call('append_events', ...)` — migrated in
  Phase 4 to command reducer calls against a publishable command fixture.
- Examples and their README suites — migrated in Phase 5. `docs/API.md` / `docs/usage-guide.md` /
  integration and unit guides, plus `README.md` scripts — migrated in Phase 6.

Read-side helpers (`decode`, upcasters, `sliceRows`, subscriptions, views, `viewQuery`,
`tableQuery`) are intentionally unaffected.

### 18.6 Phased rollout

Each phase starts only after an explicit go signal and completes its own checks before the next is
proposed. "If necessary" is decided at the start of that phase, not assumed.

| Phase | Scope | Exit criteria | Status |
| --- | --- | --- | --- |
| 1 | Requirements/plan docs — this document | Flaw, target contract, command payload rules, counter mapping, impact, and phases recorded; R9, M15, risk, and decision entries added | done |
| 2 | Package source (`src/client`, `src/server`) | Browser-facing append/retry surface removed; `makeAppendReducer` no longer in the shipped write path; optional command-dispatch helper uses generated reducers; read/decode/subscribe helpers unchanged; typecheck, unit suite, build, pack check green | done |
| 3 | Unit testing kit (`src/testing`) if necessary | Fake append seam replaced/augmented by a fake command dispatcher; contract suite adapted to command reducers; offline tests green | done |
| 4 | Integration testing kit (`src/testing/integration`) if necessary | Generic `append_events` calls in kit docs, tests, and smoke scripts replaced by command reducer calls; local and external URL modes green | done |
| 5 | Examples (`examples/counter`, `examples/sets/counter-with-frontend`) | No browser path can call a generic append; `increment`/`decrement`/`reset` module reducers validate ownership; command payload types come from generated bindings; example typechecks, unit tests, and integration tests green | done |
| 6 | Remaining docs (`usage-guide.md`, `API.md`, `README.md`, unit/integration guides, plan status) | No frontend-append snippets remain; command contract and new exports documented; phase status updated; markdown links/fences green | done |

**Phase 2 intermediate state.** The package's own gates are green: root `typecheck`, 118 offline
unit tests (including the new command-client suite), clean `build`, and `check:pack`. Examples still
import the removed APIs, so `example:typecheck`, `example:set:counter:typecheck`, and the publish
smokes stay red **by design** until Phase 5 migrates them. Phase 2 kept the fixture module's
test-only generic append reducer so the store's own harness tests and contract suite remain
meaningful; the integration toolkit still targets it and migrates in Phase 4.

**Phase 3 intermediate state.** The unit kit now exports `createFakeCommand` as the browser-boundary
stand-in and keeps `createFakeAppend` as a deprecated migration aid. The contract suite accepts an
optional `commands` block and dogfoods it against the fixture's `increment` reducer, covering
single-append command handling, `commandId` replay, and rejection when the sender has no ownership
row. Root offline tests are green at 124 tests. The integration toolkit still calls
`append_events` and migrates in Phase 4.

**Phase 4 intermediate state.** The integration kit remains reducer-agnostic. A publishable command
fixture at `test/integration-module` provides `claim_counter`, `increment`, `decrement`, and `reset`
so the live kit smoke can migrate without pulling Phase 5 example work forward. The smoke now checks
command writes, `commandId` replay, non-owner rejection, subscriptions, cache rebuild, and external
URL mode; all 16 checks pass. `docs/integration testing.md` and the CLI-formatting test use command
payloads. Examples and their publish/integration suites still target `append_events` by design until
Phase 5.

**Phase 5 intermediate state.** Both counter examples now export only `increment`, `decrement`, and
`reset` command reducers. The reducers derive the stream id, deterministic event id, event type,
payload, and expected version from intent-only payloads, claim ownership on first use, and reject a
different `ctx.sender`. The React client imports command payload types from `spacetime generate`
output and dispatches through `createCommandClient`; generic append bindings were removed. Offline
module tests, web command tests, the five-test live integration suite, `example:set:counter:publish`
(preserving data), `publish-clean`, and the 19-check publish smoke all pass.

**Phase 6 completion state.** Active documentation now describes the command write contract only.
`README.md`, `docs/API.md`, `docs/usage-guide.md`, and `docs/unit testing.md` use generated command
reducers, `createCommandClient`, `createFakeCommand`, and the contract suite's optional `commands`
check. Server-only `appendToStream` remains documented as a module seam; `createFakeAppend` is marked
deprecated. `docs/integration testing.md` needed no further migration. The plan status and M15 row
are complete, and the markdown link/fence check is green.

Independent of M15, M9–M13 and M14 stay paused/deferred as recorded in §15.

### 18.7 Definition of done for M15

- No module in the repository exports a generic append reducer reachable from a browser.
- No browser code constructs `streamId`, `eventType`, `data`, `eventId`, or `expectedVersion` for a
  write; command payload types are imported from `spacetime generate` output.
- Authorization is enforced in command reducers against `ctx.sender`, with a negative test for a
  non-owner targeting another user's stream.
- Retrying a command with the same `commandId` is an idempotent replay, not a duplicate event.
- All existing CI layers (build, typechecks, offline tests, pack check, live smoke, integration
  smoke, example tests) remain green after the migration.
