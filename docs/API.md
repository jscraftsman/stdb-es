# API reference

This is the complete reference for the **shipped** `stdb-es` consumer API. For task-oriented examples,
see the [Package Usage Guide](usage-guide.md). Planned APIs are listed at the end and are not
available yet.

> Requires `spacetimedb >= 2.15 < 3`. JSON event payloads are the only implemented payload mode.
> TypeScript server modules only. `vitest` is an optional peer needed only by `stdb-es/testing`.

## Import map

| Import | Intended environment | Contents |
| --- | --- | --- |
| `stdb-es` | module or client | Stable error codes, error helpers, the `streamId` helper, protocol types and constants |
| `stdb-es/server` | SpacetimeDB module only | Tables, append/read, aggregates, repositories, projections, views, doctor |
| `stdb-es/client` | browser or Node client | Command dispatch, event registry/codecs, row helpers, subscription query and event-row helpers |
| `stdb-es/testing` | offline unit tests | Module/client helpers, command fakes, harness shim, fixtures, contract suite |
| `stdb-es/testing/integration` | Node-only integration tests | Disposable server/database lifecycle, CLI calls, SQL, subscriptions |

Conventions used below:

- **Inputs** are positional arguments unless shown as an object. `readonly` arrays are accepted
  wherever an array appears.
- **Output** describes the synchronous return value. Reducers return `void`; clients observe results
  through subscriptions/views.
- **Throws** means a `SenderError` with a stable `ES_*` message prefix unless another error type is
  named.
- Types are erased at runtime but are part of the public API and documented here.

---

## 1. `stdb-es` — shared surface

Safe to import from both module and client code. It does not import the SpacetimeDB server runtime.

### 1.1 `ES_ERROR`

`ES_ERROR` is a frozen object of stable error-code strings. Match on `esErrorCode(error)`, never on
the human-readable detail.

| Member | Value | Meaning |
| --- | --- | --- |
| `EXPECTED_VERSION_MISMATCH` | `ES_EXPECTED_VERSION_MISMATCH` | The stream version did not match `expectedVersion` |
| `EVENT_ID_CONFLICT` | `ES_EVENT_ID_CONFLICT` | An event id in the batch already belongs to another stream |
| `PARTIAL_DUPLICATE` | `ES_PARTIAL_DUPLICATE` | Some, but not all, event ids in the batch already exist |
| `STREAM_TYPE_MISMATCH` | `ES_STREAM_TYPE_MISMATCH` | The stream exists with a different `streamType` |
| `INVALID_BATCH` | `ES_INVALID_BATCH` | Empty/oversized batch, bad stream id, duplicate id in batch, or unknown sentinel |
| `UNKNOWN_EVENT_TYPE` | `ES_UNKNOWN_EVENT_TYPE` | Empty event type, or a type rejected by `eventTypes`/the registry |
| `INVALID_EVENT_ID` | `ES_INVALID_EVENT_ID` | Missing, empty, or over-long event id |
| `INVALID_PAYLOAD` | `ES_INVALID_PAYLOAD` | Missing, empty, over-long, or non-JSON `data` |

### 1.2 Error helpers

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `buildEsErrorMessage(code, detail)` | Formats the canonical error message | `code: EsErrorCode`, `detail: string` | `string` of the form `"CODE: detail"` |
| `esErrorCode(error)` | Extracts the stable code from a thrown value | `error: unknown` | `EsErrorCode` when the message starts with a known code (or equals it), otherwise `null` |
| `isEsError(error)` | Tests whether an error came from the store | `error: unknown` | `boolean` — `esErrorCode(error) !== null` |

`EsErrorCode` is the union of all values in `ES_ERROR`.

### 1.3 Stream id helper

| Symbol | Purpose | Inputs | Output / throws |
| --- | --- | --- | --- |
| `streamId(prefix, key)` | Builds a stable, validated stream id | `prefix: string`; `key: string \| number \| bigint` | `<prefix>-<key>`, for example `order-42`. Throws an `Error` with code `ES_INVALID_BATCH` when validation fails. |
| `StreamIdKey` | Accepted key type | — | `string \| number \| bigint` |

Validation rules:

- `prefix` must start with a letter and contain only letters, digits, or underscores. This keeps the
  `-` separator unambiguous.
- A string `key` must contain only letters, digits, underscores, dots, colons, or hyphens. This
  supports UUIDs, hex identities, and dotted/colon-separated business keys while rejecting spaces,
  quotes, semicolons, and slashes.
- A numeric `key` must be a non-negative safe integer; a bigint `key` must be non-negative.
- The resulting id must be at most 256 characters, matching `appendToStream`.

`streamId` is a formatting helper only. It does not decide who may create a stream and does not check
ownership. Import it from `stdb-es` in module code for write-side ids and in client code for read-side
queries and subscriptions; browser commands must not carry a stream id. Keep the prefix in an
app-owned `STREAM_PREFIXES_<DOMAIN>` constant.

### 1.4 Protocol constants

| Symbol | Value | Purpose |
| --- | --- | --- |
| `ANY_VERSION` | `-1` | Skip the expected-version check |
| `NO_STREAM` | `0` | Require that the stream does not exist |
| `STREAM_EXISTS` | `-2` | Require that the stream exists |

Versions are 1-based, so negative values are safe sentinels. Any other negative value is
`ES_INVALID_BATCH`.

### 1.5 Protocol types

These are re-exported by `stdb-es/server`.

| Type | Fields / payload | Notes |
| --- | --- | --- |
| `CtxOf<M>` | Type parameter: a SpacetimeDB `Schema` | Reducer context inferred from an app schema. Use it to type cache adapters and hooks. |
| `EncodedEvent` | `eventId: string`, `eventType: string`, `data: string`, `metadata?: string \| null` | The wire shape accepted by `appendToStream`. `data` must be canonical JSON. |
| `ExpectedVersion` | `number` | A concrete 1-based version or one of the sentinels above |
| `AppendArgs` | `streamId`, `streamType`, `events: readonly EncodedEvent[]`, `expectedVersion`, `metadata?` | Input to `appendToStream` |
| `AppendResult` | `{ status: 'appended', version, rows }` or `{ status: 'replayed', version, rows }` | `rows` are inserted rows for `appended`, existing rows for `replayed`. `version` is the stream version after the batch. |
| `EventStoreConfig<C>` | `eventTypes?`, `maxBatchSize?`, `maxPayloadLength?`, `onAppended?` | Store configuration. `C` is the full app context so `onAppended` sees app tables. |
| `ReadStreamOptions` | `fromVersion?`, `atVersion?`, `atTimestampMicros?`, `limit?` | `fromVersion` defaults to 1; bounds intersect; `limit` applies after ordering. |
| `DecodedEvent<TEvent>` | `eventType: string`, `data: TEvent` | Produced by `parsePayload` and passed to `evolve` |
| `AggregateStreamOptions<TState, TEvent>` | `AggregateDefinition` fields plus `ReadStreamOptions` | Input to `aggregateStream` |
| `FoldOptions<TState, TEvent>` | `initial: TState`, `decode(row)`, `evolve(state, decoded, row)` | Input to `foldEvents` |

`EventStoreConfig.onAppended(ctx: C, result: AppendResult): void` runs inside the append transaction
and only for `status: 'appended'`. A throw rolls the append back. Defaults: `maxBatchSize = 100`,
`maxPayloadLength = 64 * 1024` characters, no registered-type restriction.

---

## 2. `stdb-es/server` — module API

### 2.1 Tables and context types

| Symbol | Purpose | Shape / output |
| --- | --- | --- |
| `GLOBAL_HEAD` | Primary key of the single head row | The string `'global'` |
| `esStream` | Private stream catalogue and concurrency row | Columns: `streamId` (PK), `streamType`, `version`, `createdAt`, `updatedAt`, `metadata` (option). Index: `byType`. |
| `esEvent` | Private append-only event log | Columns: `eventId` (PK), `position: u64`, `streamId`, `streamType`, `version`, `eventType`, `data`, `metadata`, `createdAt`, `createdAtMicros: u64`, `createdBy`. Indexes: `byPosition`, `byStreamVersion`, `byStreamTime`, `byType`. |
| `esHead` | Private global position counter | Columns: `id` (PK), `position: u64` |
| `esTables` | Spread into an app schema | `{ esStream, esEvent, esHead }` |
| `EsTables` | Type of `esTables` | Compile-time only |
| `EsSchemaDef` | Schema definition containing only core tables | Compile-time only |
| `EsDb` | Read-only database view over the core tables | Compile-time only |
| `EsReadCtx` | Minimal context for read helpers | `{ readonly db: EsDb }` |
| `EsCtx` | Full reducer context required by write helpers | `ReducerCtx<EsSchemaDef>` |
| `StreamRow` | Inferred row type of `esStream` | Compile-time only |
| `EventRow` | Inferred row type of `esEvent` | Compile-time only |
| `HeadRow` | Inferred row type of `esHead` | Compile-time only |

The library never updates or deletes `esEvent` rows except through the append path, and it exports no
public table containing raw events.

| Function | Purpose | Inputs | Output / throws |
| --- | --- | --- | --- |
| `esError(code, detail)` | Throws a reducer-visible store error | `code: EsErrorCode`, `detail: string` | Throws `SenderError` with message `CODE: detail` |

### 2.2 Appending inside command reducers

`appendToStream` is a **module-only** helper. Call it from app-owned command reducers that validate the
command and `ctx.sender`, derive the stream id and events, and choose `expectedVersion`. Do not export
a generic append reducer: every reducer a client can call is part of the app's public write surface.

| Function | Purpose | Inputs | Output / throws |
| --- | --- | --- | --- |
| `appendToStream(ctx, args, config?)` | Validates and appends a batch in the caller's transaction | `ctx: C extends EsCtx`, `args: AppendArgs`, optional `EventStoreConfig<C>` | `AppendResult`. Throws the `ES_*` errors listed in §1.1. |

A command reducer derives `AppendArgs` itself. The browser sends only the command payload, including
`commandId`; the module derives the stream id, event ids, event types, payloads, and expected version.
See [§18.3 of the design record](event-sourcing-plan.md#183-command-payload-contract) for the command
contract.

Append order and guarantees:

1. Validate ids/types/payloads. `streamId` ≤ 256 chars, `eventId` ≤ 128 chars, batch 1–100 events by
   default, payload 1–64 KiB and valid JSON.
2. Deduplicate **before** the version check. All ids already present on the same stream return
   `replayed`; a foreign id throws `EVENT_ID_CONFLICT`; a partial match throws `PARTIAL_DUPLICATE`.
3. Check stream type, then `expectedVersion`.
4. Insert events with gapless versions and positions, update `es_stream` and `es_head`, then call
   `onAppended`. All of this is one transaction.

### 2.3 Reads and time travel

| Function | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `readStream(ctx, streamId, opts?)` | Reads events in version order | `ctx: EsReadCtx`, `streamId: string`, optional `ReadStreamOptions` | `EventRow[]`, sorted by `version` ascending; `[]` when no rows match |
| `getStreamState(ctx, streamId)` | Reads the stream catalogue row | `ctx: EsReadCtx`, `streamId: string` | `StreamRow \| null` |
| `streamVersion(ctx, streamId)` | Reads the concurrency token | `ctx: EsReadCtx`, `streamId: string` | `number` — last version, or `0` when the stream does not exist |
| `listStreams(ctx, streamType?)` | Lists streams | `ctx: EsReadCtx`, optional `streamType: string` | `StreamRow[]` |
| `foldEvents(rows, opts)` | Folds decoded events into a state value | `rows: readonly EventRow[]`, `FoldOptions` | `TState` |
| `aggregateStream(ctx, streamId, opts)` | Replays a stream into state | `ctx: EsReadCtx`, `streamId: string`, `AggregateStreamOptions` | `TState \| null` — `null` when the stream does not exist |
| `parsePayload(row, parse?)` | Decodes one row's `data` column | `row: EventRow`, optional `parse: (json: string) => TEvent` (default `JSON.parse`) | `DecodedEvent<TEvent>` |

`readStream` uses the `(streamId, version)` index for version bounds and the
`(streamId, createdAtMicros)` index for time bounds. When both are supplied, rows must satisfy both.
`limit` is applied after sorting. Timestamps are processing time; business time belongs in the
payload.

### 2.4 Aggregates

| Symbol | Purpose | Inputs / members | Output / notes |
| --- | --- | --- | --- |
| `AggregateDefinition<TState, TEvent>` | Functional description of an aggregate kind | `streamType`, `initial(): TState`, `decode(row): TEvent`, `evolve(state, event, row): TState` | Shared by replay, repositories, and doctor fixtures. `evolve` must be deterministic. |
| `defineAggregate(definition)` | Identity helper with type inference | An `AggregateDefinition` | The same definition, typed |
| `Aggregate<TState, TEvent>` | Optional class form | `id`, `initial` constructor args; `version`; `state` getter; `apply(event, version)`; `hydrate(state, version)`; `uncommitted`; `dequeueUncommitted()`; protected `evolve` and `raise` | `raise` applies and queues an event; `apply`/`hydrate` never queue. Prefer `defineAggregate` with a repository when cache/replay parity matters. |

### 2.5 Repositories and state caches

| Symbol | Purpose | Inputs / fields | Output / notes |
| --- | --- | --- | --- |
| `CachedState<TState>` | One cache row as seen by the library | `version: number`, `state: TState` | Returned by `StateCache.load` |
| `StateCache<TState, C>` | Adapter over an app-owned typed table | `load(ctx, streamId)`, `save(ctx, streamId, version, state)`, `remove(ctx, streamId)` | `load` returns `CachedState \| null`. `save`/`remove` return `void`. |
| `EncodedDomainEvent` | Encoder output for one domain event | `eventType: string`, `data: unknown`, `metadata?: string \| null` | `data` is JSON-serialized by the repository |
| `EventEncoder<TEvent>` | Converts a domain event to wire data | `(event: TEvent) => EncodedDomainEvent` | Must be deterministic |
| `RepositoryOptions<TState, TEvent, C>` | Repository configuration | AggregateDefinition fields plus `encode`, optional `cache`, optional `newEventId(ctx)` | `newEventId` defaults to `ctx.newUuidV7().toString()` for repository-generated batches |
| `LoadedAggregate<TState>` | A loaded or fresh aggregate | `id`, `version`, `state` | `version = 0` means no events |
| `LoadOptions` | Bounds for `Repository.load` / `loadOrCreate` | `atVersion?`, `atTimestampMicros?` | A time bound forces replay; a version bound ignores newer caches |
| `SaveOptions` | Options for `Repository.save` | `expectedVersion?`, `metadata?`, `eventIds?: readonly string[]` | `expectedVersion` defaults to `aggregate.version`; `eventIds` must match `events.length` |
| `Repository<TState, TEvent, C>` | Typed command-side access to one aggregate kind | Constructed with `RepositoryOptions` | Methods below |
| `makeRepository(definition, opts)` | Builds a repository from an aggregate definition | `definition`, options excluding the definition fields | `Repository` |

`Repository` methods:

| Method | Inputs | Output / behavior |
| --- | --- | --- |
| `create(id)` | `id: string` | `LoadedAggregate` with initial state and version 0 |
| `load(ctx, id, opts?)` | Context, id, optional `LoadOptions` | `LoadedAggregate \| null`. Cache is used only when `version <= stream.version`, `version <= atVersion` when set, and no time bound is set. The remaining tail is replayed. |
| `loadOrCreate(ctx, id, opts?)` | Same as `load` | `LoadedAggregate`; falls back to `create` when the stream is missing |
| `save(ctx, aggregate, events, opts?)` | Context, aggregate, events, optional `SaveOptions` | `AppendResult \| null`. Returns `null` for an empty event array. Appends with the expected version, folds new rows into the aggregate, and writes the cache. A replayed batch is not folded twice. |
| `invalidate(ctx, streamId)` | Context, id | `void`; removes the cache row so the next load replays |

For command-reducer writes, pass `eventIds` derived from the command's `commandId`. A retried command
then reaches `appendToStream` with the same ids and settles as a replay. The default
`newEventId`/`ctx.newUuidV7()` path is for server-side fixtures and non-command module code, not for
browser idempotency.

A missing cache row is always recovered by replay. A stale cache degrades performance, not
correctness.

### 2.6 Projections

| Symbol | Purpose | Inputs / fields | Output / notes |
| --- | --- | --- | --- |
| `InlineProjection<C>` | A projection handler | `name`, `handles: readonly string[]`, `handle(ctx, event)`, optional `reset(ctx)` | Runs in the append transaction. Must be deterministic; no clock/RNG-derived business values. `reset` is required for `rebuildBatch({ reset: true })`. |
| `RebuildOptions` | Bounds for a rebuild | `fromPosition?: bigint` (exclusive), `limit?: number`, `reset?: boolean` | Use bounded batches in admin reducers |
| `RebuildResult` | Rebuild report | — | `{ processed: number, lastPosition: bigint \| null, projections: string[] }` |
| `applyInline(ctx, projections, rows)` | Runs matching projections for appended rows | Context, projections, `EventRow[]` | `void`. Called from `onAppended`. |
| `rebuildBatch(ctx, projections, opts?)` | Replays committed events through projections | Context, projections, optional `RebuildOptions` | `RebuildResult`. A handler failure rolls back the batch and throws an error naming the projection and event position. |

Projections are synchronous and inline in v1. There is no async checkpoint pump.

### 2.7 View factories

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `Authorize<C>` | Authorization predicate type | `(ctx: C, streamId: string) => boolean` | `true` allows the view to return data |
| `StreamViewOptions<M>` | Options shared by factories | `name: string`, `authorize: Authorize<CtxOf<M>>` | `name` must be unique in the module |
| `makeStreamView(schema, opts)` | Exposes one stream's events | App schema, options | Public parameterized view with param `{ streamId }`; returns `EventRow[]` sorted by version, or `[]` when unauthorized |
| `makeStreamAtView(schema, opts)` | Exposes a version prefix | App schema, options | Public view with params `{ streamId, atVersion }`; returns `EventRow[]` up to that version, or `[]` |
| `makeStreamHeadView(schema, opts)` | Exposes only stream metadata | App schema, options | Public view with param `{ streamId }`; returns `StreamRow \| undefined`, never payloads |

Views are always public in SpacetimeDB. `authorize` is a required argument; the factories never ship
an unchecked view. Use identity `.equals()` rather than `===` inside predicates.

### 2.8 Doctor helpers

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `StreamProblem` | Structural problem union | — | One of `stream-version-mismatch`, `version-gap`, `version-duplicate`, `stream-type-mismatch`, `empty-stream`, each with details |
| `StreamIntegrity` | Integrity report | — | `{ streamId, streamType: string \| null, eventCount, problems: StreamProblem[], ok }` |
| `verifyStreamIntegrity(ctx, streamId)` | Checks structural consistency | `EsReadCtx`, id | `StreamIntegrity`. A missing stream is `ok: true` with `streamType: null`. |
| `CacheVerification<TState>` | Cache comparison report | — | `{ streamId, exists, streamVersion, cachedVersion, cachedState, replayedState, ok }` |
| `VerifyCacheOptions<C, TState>` | Options for state verification | `cache`, `replay`, optional `equal` | `replay` must ignore the cache; default `equal` is bigint-safe and key-order-independent |
| `verifyStreamState(ctx, streamId, opts)` | Compares cache with full replay | Context, id, options | `CacheVerification<TState>`. Detects missing/stale caches and same-version drift. |
| `findDrift(ctx, opts)` | Finds all failing streams | Context, `VerifyCacheOptions` plus optional `streamType` | `CacheVerification<TState>[]` containing only `ok: false` rows |
| `RepairAction` | Result of a repair | — | `'unchanged' \| 'repaired' \| 'removed'` |
| `RepairOptions<C, TState>` | Options for repair | `cache`, `replay`, optional `equal` | Same replay/equality rules as verification |
| `repairStream(ctx, streamId, opts)` | Rewrites or removes one cache row | Context, id, options | `RepairAction`. Orphan cache rows are removed; stale or drifted rows are rewritten from replay at the stream version. |

The library exports no repair reducer. Expose one from your app behind an authorization gate.

---

## 3. `stdb-es/client` — browser-safe client API

### 3.1 Registry and decoding

| Symbol | Purpose | Inputs / fields | Output |
| --- | --- | --- | --- |
| `StoredEventRow` | Minimal row shape delivered by a view | `eventId`, `position: bigint`, `streamId`, `streamType`, `version`, `eventType`, `data: string`, optional `metadata`, `createdAtMicros` | Compile-time only. Extra generated-row fields are harmless. |
| `DecodedEventRow<TEvent>` | Envelope plus domain event | `Omit<StoredEventRow, 'data'>` plus `event: TEvent` | Returned by `decodeEvent` and `sliceRows` |
| `EventDefinition<TEvent, TPayload>` | Codec for one event type | `encode(event): TPayload`, `decode(payload): TEvent`, optional `upgrade(payload: unknown): TPayload` | `upgrade` runs before `decode`; use it for old payload shapes |
| `EventRegistry<TEvent>` | Map of event types to codecs | `typeOf(event): string`, `definitions: Record<string, EventDefinition>` | Read-side codec registry |
| `createEventRegistry(input)` | Builds a registry | `{ typeOf, events }` | `EventRegistry<TEvent>` |
| `decodeEvent(registry, row)` | Decodes one stored row | Registry, `StoredEventRow` | `TEvent`. Throws `ES_UNKNOWN_EVENT_TYPE` for an unknown `eventType`. |
| `ReadRowsOptions` | Filters for subscribed rows | `streamId?`, `fromVersion?`, `atVersion?`, `atTimestampMicros?`, `limit?` | Bounds intersect |
| `sliceRows(rows, opts?)` | Filters and sorts decoded rows | `DecodedEventRow[]`, options | `DecodedEventRow[]` sorted by `version`; timestamps are compared only when present |

The registry is client-side: the server stores opaque JSON. Adding an event type is an app/registry
change, not a database migration. It is the codec for **reading** stored rows; browser writes use
generated command reducers (§3.2). The `encode` field remains in `EventDefinition` for app-defined
codecs, but the package no longer exports an `encodeEvents` helper.

### 3.2 Command client

The browser-facing write surface is a set of generated command reducers. `createCommandClient` adds an
idempotency key and dispatches intent; it never builds an event envelope.

| Symbol | Purpose | Inputs / fields | Output |
| --- | --- | --- | --- |
| `CommandEnvelope<TCommand>` | A command plus its idempotency key | `TCommand & { commandId: string }` | Compile-time only |
| `CommandCall<TCommand>` | Shape of a generated command reducer binding | `(command: CommandEnvelope<TCommand>) => Promise<unknown>` | The resolved value is ignored |
| `CommandIdOptions` | Constructor options | Optional `newCommandId?: () => string` | Defaults to `crypto.randomUUID()` |
| `WithCommandIdOptions` | Per-command options | `CommandIdOptions` plus optional `commandId?: string` | An explicit key reuses a pending command |
| `newCommandId()` | Generates a fresh idempotency key | None | `string` from `crypto.randomUUID()` |
| `withCommandId(command, options?)` | Adds a key without sending | Command object and options | `CommandEnvelope<TCommand>`; preserves an existing non-empty `commandId` |
| `CommandCalls<TCommands>` | One generated reducer per command name | Map of names to `CommandCall` | Compile-time only |
| `createCommandClient(calls, options?)` | Binds generated reducers into a dispatcher | `CommandCalls<TCommands>`, optional `CommandIdOptions` | `CommandClient<TCommands>` |
| `CommandClient<TCommands>` | Return type of `createCommandClient` | — | Compile-time only |

Methods on the returned client:

| Method | Inputs | Output / behavior |
| --- | --- | --- |
| `prepare(name, command, options?)` | Command name, intent, optional key | `CommandEnvelope<TCommand>`. Does not send. Use this when the envelope must be persisted before dispatch. |
| `send(name, envelope)` | Command name, prepared envelope | `Promise<void>`. Sends the envelope verbatim. |
| `sendNew(name, command, options?)` | Command name, intent, optional key | `Promise<CommandEnvelope<TCommand>>`. Prepares, sends, and returns the envelope after a successful dispatch. |

A command contains only intent, such as `{ counterId, by }`. The module owns the stream id, event ids,
event types, payloads, and expected version. A repeated `commandId` is resolved as an idempotent replay
inside the module. Command failures propagate to the caller; there is no client-side append/retry helper
because reducers return `void` and the resulting state arrives through subscriptions/views.

The separate subscription bridge in §3.4 can be used when a client needs live rows.

### 3.3 Subscription query helpers

| Symbol | Purpose | Inputs | Output / throws |
| --- | --- | --- | --- |
| `sqlString(value)` | Escapes a SQL string literal | `value: string` | Quoted string with `'` doubled |
| `SqlLiteral` | Accepted view argument type | — | `string \| number \| bigint \| boolean \| null` |
| `sqlLiteral(value)` | Formats one SQL literal | `SqlLiteral` | `string`. Rejects non-finite numbers. |
| `viewQuery(name, args?)` | Builds a parameterized-view subscription query | View name, literal args in declaration order | `SELECT * FROM <name>(<args>)`. Throws on an invalid identifier. |
| `tableQuery(name)` | Builds a table/anonymous-view query | Table name | `SELECT * FROM <name>`. Throws on an invalid identifier. |

Use `viewQuery(VIEWS_ORDER.stream, [streamId(STREAM_PREFIXES_ORDER.order, '42')])` rather than
constructing SQL from raw user input. Both constants are app-owned; see the usage guide.

### 3.4 Subscription helpers

These helpers bridge the SQL builders above to the SDK's `subscriptionBuilder()`. They use structural
types, so a generated `DbConnection` is accepted without importing generated code into this package.

| Symbol | Purpose | Inputs / fields | Output |
| --- | --- | --- | --- |
| `SubscriptionQuery` | Query input | `{ view, args? }`, `{ table }`, or `{ query }` (one SQL string or an array) | Compile-time only |
| `EventSubscriptionOptions<TRow>` | Configuration for one subscription | `connection`, `query`, `readRows(ctx)`, `onRows(rows, ctx)`, optional `onError(error, errorCtx)`, `streamId`, `rowStreamId(row)` | Compile-time only |
| `subscribeEventRows(opts)` | Registers a query and forwards applied rows | Options above | `EventSubscription` |
| `EventSubscription` | Retained SDK handle | `queries`, `unsubscribe()`, `unsubscribeThen(onEnd)`, `isActive()`, `isEnded()` | Returned by `subscribeEventRows` |
| `StreamSubscriptionOptions<TRow>` | Configuration for a single-stream switcher | Same as above, but `query(streamId)` and `onRows(rows, ctx, streamId)`; no fixed `streamId` | Compile-time only |
| `createStreamSubscription(opts)` | Keeps exactly one stream query active | Options above | `StreamSubscription` |
| `StreamSubscription` | Stream switcher handle | `streamId`, `queries`, `select(streamId)`, `unsubscribe()`, `unsubscribeThen(onEnd)`, `isActive()`, `isEnded()` | Returned by `createStreamSubscription` |
| `SubscriptionConnection`, `SubscriptionBuilder`, `SubscriptionHandleLike` | Structural SDK types | The `subscriptionBuilder()`, callback registration, and handle methods used here | Compile-time only |

`readRows(ctx)` extracts the current rows from the SDK subscription context, for example
`ctx => [...ctx.db.counterSummary.iter()]`. When `streamId` is supplied, rows are filtered to that
stream and `rowStreamId` can override the default `streamId` / `stream_id` row lookup; a row without a
usable id throws. `createStreamSubscription` sets `streamId` automatically, unsubscribes the previous
handle on `select`, ignores late callbacks from that handle, and passes the selected id to `onRows`.

Callbacks are registered once. With automatic reconnect enabled, the SDK replays the retained query
and invokes `onApplied` again, so `onRows` receives refreshed rows without a second `subscribe()`
call. `onError` receives subscription and reducer errors; if omitted, the error is rethrown rather
than swallowed. `unsubscribeThen` delegates to the SDK handle when available.

```ts
import { streamId } from 'stdb-es';
import { subscribeEventRows } from 'stdb-es/client';
import { STREAM_PREFIXES_ORDER, VIEWS_ORDER } from './constants.js';

const id = streamId(STREAM_PREFIXES_ORDER.order, '42');

const subscription = subscribeEventRows({
  connection, // a generated DbConnection
  query: { view: VIEWS_ORDER.stream, args: [id] },
  streamId: id,
  readRows: (ctx) => [...ctx.db.orderStream.iter()], // the generated cache for the view
  onRows: (rows) => render(rows),
  onError: (error) => report(error),
});

// Later, when the screen unmounts:
subscription.unsubscribe();
```

---

## 4. `stdb-es/testing` — offline test tooling

`runEventStoreContractTests` imports `vitest` at runtime, so install it as a dev dependency when using
the contract suite. The other tooling in this entry is runner-agnostic. See the
[unit testing guide](unit%20testing.md) for task-oriented examples.

### 4.1 Module and client helpers

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `createModuleTest(spacetimedb, moduleExports, options?)` | Creates a fresh offline module test | The module's default schema export, its reducer/view exports, and optional `auth`, `clock`, `rngSeed`, `moduleIdentity` | `ModuleTest` with `tx`, `call`, `view`, `anonymousView`, `harness`, `auth`, and `moduleExports` |
| `ids(prefix, count)` | Builds deterministic event ids | Non-empty `prefix`; positive safe integer `count` | `string[]` of `${prefix}-1` … `${prefix}-count`; throws on invalid input or ids over 128 characters |
| `expectAppendError(fn, code)` | Asserts a stable store failure from a server-side seam | A sync or async callback and an `EsErrorCode` | `void` for sync callbacks; `Promise<void>` for async ones. Throws a plain `Error` when no error or a different code occurs. |
| `createFakeCommand<TCommand>(options?)` | Fakes a generated command reducer binding | Optional `result` or `error`; use `nextResult`/`nextError` for sequences | `FakeCommand<TCommand>` call function with `calls`, `lastCall`, `nextResult`, `nextError`, and `clear` |
| `FakeCommandOptions`, `FakeCommand<TCommand>` | Command-fake types | — | Compile-time only |

Every context passed to `tx`, `call`, `view`, or `anonymousView` is wrapped with `withIndexRanges`, so
the 2.15 harness behaves like the real host. `tx` commits when the body returns and rolls back when it
throws. `call` looks up the reducer by export name. `view` and `anonymousView` call the supplied view
function directly with the matching harness context type.

`createFakeCommand` records one shallow snapshot of the intent payload per call, including
`commandId`. Queued replies from `nextResult`/`nextError` are consumed first; afterwards the configured
`result`/`error` (default: resolve `undefined`) applies. `clear()` empties `calls` but keeps the queue.
It never sees a stream id, event, or expected version.

No append fake is shipped: the browser has no append binding. For server-side store tests, use
`wireEvents`/`ids` with your own `appendToStream` seam, or `expectAppendError` on an existing fixture.

### 4.2 Harness shim and fixtures

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `withIndexRanges(ctx)` | Makes SpacetimeDB 2.15 harness range scans behave like the real host | Reducer/view context | The same context type with shimmed `db.esEvent` range accessors. Safe no-op after re-wrapping. |
| `wireEvent(eventId, eventType, payload)` | Builds one wire event | `eventId`, `eventType`, JSON-serializable payload | `EncodedEvent` with `data: JSON.stringify(payload)` |
| `wireEvents(prefix, pairs)` | Builds a deterministic batch | `prefix: string`, pairs of `[eventType, payload]` | `EncodedEvent[]` with ids `${prefix}-1`, `${prefix}-2`, … |
| `versions(rows)` | Compact version assertions | Rows with a `version` field | `number[]` |

`withIndexRanges` works around a duplicate `Range` class inside the 2.15 module test harness. The
production host is unaffected; do not add the wrapper to module code.

### 4.3 Contract suite

| Type | Purpose | Fields |
| --- | --- | --- |
| `ContractStream<TState, TEvent>` | One aggregate kind under contract | `streamType`, `repository`, `stateCache`, `replay`, `sample` |
| `ContractStream.sample` | Fixture events and expected state | `wire(streamId): EncodedEvent[]` with deterministic ids; `domain(streamId): TEvent[]`; `expectedState: TState`; optional `corrupt(state): TState` |
| `ContractProjections` | Optional projection check | `projections: readonly InlineProjection[]`, `snapshot(ctx): unknown` in stable order |
| `ContractView` | Optional view check | `name`, `view`, `params(streamId)`, optional `seed(ctx, streamId)`, `check(result, streamId)` |
| `ContractCommands<TCommand>` | Optional browser-boundary check | `name`, `command(streamId, commandId)`, optional `authorize(ctx, streamId)`, `version(ctx, streamId)` |
| `EventStoreContractOptions` | Suite configuration | `name?`, `spacetimedb`, `moduleExports?`, `append`, `streams`, `commands?`, `projections?`, `views?`, `streamId?(stream)` |

| Function | Purpose | Inputs | Output / behavior |
| --- | --- | --- | --- |
| `runEventStoreContractTests(options)` | Registers the shared contract suite | Options above | `void`; registers Vitest `describe`/`it` cases at call time. Each case builds a fresh harness and wraps contexts with `withIndexRanges`. |

The required `append` option is a **server-side write seam** used to seed store invariants, not a
browser API. When `commands` is supplied, `name` must be exported through `moduleExports`; the suite
then checks single-append command handling, `commandId` replay, and — when `authorize` is present —
rejection of a sender without an ownership row.

Covered invariants: append/read ordering, gapless positions, stale-version rejection with fresh ids,
idempotent replay, repository/cache agreement, structural integrity, time travel, same-version drift
detection and repair, projection rebuild parity, view output, and the optional command boundary.

For stale-version tests, generate **fresh** event ids. Dedupe runs before the version check, so
resubmitting identical ids is a valid replay even when `expectedVersion` is stale.

---

## 5. `stdb-es/testing/integration` — live integration tooling (Node-only)

This entry owns a real server lifecycle and needs the SpacetimeDB CLI `2.15.0` on `PATH`. It has no
`vitest` dependency. In owned local mode the spawned server uses a unique temporary `--data-dir`, so
it does not contend with another server's `spacetime.pid` lock. See the
[integration testing guide](integration%20testing.md) for task-oriented examples.

| Symbol | Purpose | Inputs | Output |
| --- | --- | --- | --- |
| `createIntegrationEnv(options?)` | Creates a disposable published database | Options below | `IntegrationEnv` |
| `integrationDatabase(prefix?)` | Generates a CLI-valid database name | Optional prefix, default `stdb-es-test` | `${normalized-prefix}-${8 hex}` |

### 5.1 `CreateIntegrationEnvOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | `'local'` | Owned in-memory server for `'local'`; an HTTP/WS URL or CLI nickname reuses an external server. |
| `database` | generated | Disposable database name; only generated names are guaranteed to be unique. |
| `modulePath` | `'spacetimedb'` | Directory passed to `spacetime publish -p`. |
| `cwd` | `process.cwd()` | Working directory for CLI calls. |
| `publish` | `true` | Publish during setup. Set `false` to attach to an existing database. |
| `deleteData` | `true` | Publish with `--delete-data=always`. Only use against disposable databases. |
| `port` | free port | Listen port in owned local mode. |
| `keepDatabase` | `false` when publishing, `true` when attaching | Leave the database during `dispose()`. An explicit value always wins. |
| `keepServer` | `false` | Leave an owned local server running during `dispose()`. |
| `timeoutMs` | `120000` | Readiness and default `waitFor` timeout. |

Attached environments (`publish: false`) keep their database on `dispose()` by default; pass
`keepDatabase: false` explicitly to delete one.

### 5.2 `IntegrationEnv`

| Member | Inputs | Output / behavior |
| --- | --- | --- |
| `server` | — | URL or CLI nickname used for CLI calls; WS URLs are normalized to HTTP. |
| `database` | — | Database name. |
| `modulePath` | — | Module path passed to `spacetime publish -p`, relative to `cwd` when relative. |
| `call(name, args?, options?)` | Reducer/procedure name; object or array of positional CLI values; optional `{ anonymous }` | `Promise<void>`. Each array element is one JSON token; a bare object is one JSON token. Non-serializable values throw. |
| `sql(query, options?)` | SQL statement; optional `{ anonymous }` | `{ rows, statements }`. Rows are keyed by column name. |
| `connect(options?)` | `{ anonymous?, queries?, printInitialUpdate?, timeoutMs? }` | `IntegrationClient` backed by `spacetime subscribe`. |
| `waitFor(predicate, options?)` | Sync/async predicate; `{ timeoutMs?, intervalMs?, description? }` | `Promise<void>`; throws with the description on timeout. |
| `dispose()` | — | Closes clients, deletes the database, stops an owned server. Idempotent. |

`IntegrationClient` exposes `rows(table)`, `tables()`, `subscribe(query)`, `waitFor(predicate,
options?)`, and `close()`. Its row cache applies insert, delete, and update subscription messages;
assert convergence with `waitFor` rather than fixed delays.

---

## 6. Not shipped / planned

Do not import these; they have no runtime implementation yet.

| Item | Milestone | Planned purpose |
| --- | --- | --- |
| Typed-enum payload mode | later | Schema-enforced event unions; currently only designed and spiked |
| Async projection pump, `es_checkpoint`, dead-letter, scheduled rebuild | M14 (v1.1) | Offload expensive projections without changing the event model |
