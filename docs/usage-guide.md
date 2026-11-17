# Package Usage Guide

This guide shows how to use `stdb-es` from **SpacetimeDB module app code**, from ordinary **client
code**, in **unit/integration tests**, and in a **simple React frontend**. It describes shipped v1
behavior. Anything marked **planned** is a milestone in
[the design record](event-sourcing-plan.md#15-milestones) and is not available yet.

For the complete signature of every export, see [API.md](API.md). For owner-only SQL inspection, see
[sql-recipes.md](sql-recipes.md).

| Entry point | Use it from | Contents |
| --- | --- | --- |
| `stdb-es` | module or client | Error codes and wire/protocol types |
| `stdb-es/server` | module only | Tables, append/read helpers, repositories, projections, view factories, doctor helpers |
| `stdb-es/client` | browser or Node client | Event registry, encoding, append client, subscription query helpers |
| `stdb-es/testing` | Vitest tests | Harness shim, wire fixtures, contract suite |

> Never import `stdb-es/server` into browser code. Never import Node-only test tooling into a module
> bundle. The client entry is browser-safe; the planned integration kit has its own Node-only entry.

---

## Part 1 — Module app code

### 1.1 Ownership model

`stdb-es` owns the event log; your app owns everything a user can see.

| Concern | Owner | Visibility |
| --- | --- | --- |
| `es_stream`, `es_event`, `es_head` | library | private |
| Current-state cache tables | app | private |
| Projection/read-model tables | app | private or public materialized table |
| Views | app | always public, with authorization inside the view |

The module is still your application server. You assemble the schema, export reducers and views, and
decide which events mean what. The library supplies typed helpers and factories.

### 1.2 Project structure for one or many domains

For a small module, a single `index.ts` is fine. For multiple business domains, keep the code
separate even though SpacetimeDB publishes one schema.

```text
spacetimedb/
  package.json
  tsconfig.json
  src/
    index.ts                  # schema assembly only
    domains/
      orders/
        constants.ts          # STREAM_TYPES_ORDER, EVENT_TYPES_ORDER, TABLES_ORDER, VIEWS_ORDER
        events.ts             # domain event union
        aggregate.ts          # initial + decode + evolve
        cache.ts              # StateCache adapter over orders_state
        projections.ts        # InlineProjection definitions
        views.ts              # public views / authorize predicates
        reducers.ts           # command reducers
        orders.test.ts        # module unit tests
      inventory/
        constants.ts
        events.ts
        aggregate.ts
        cache.ts
        projections.ts
        views.ts
        reducers.ts
        inventory.test.ts
      billing/
        constants.ts
        events.ts
        aggregate.ts
        cache.ts
        views.ts
        reducers.ts
    shared/
      auth.ts                 # authorize helpers reused by views
```

Rules for domain separation:

- `index.ts` spreads `...esTables` plus every domain's table definitions into one `schema()`.
- Each domain owns its stream type prefix, event union, codec, cache table, and views.
- Domains exchange **ids and facts**, not imported event unions. A billing projection may react to an
  `OrderPlaced` event string, but it should not import the orders module's internal types.
- Use distinct table names such as `orders_state` and `billing_invoice` to avoid collisions.
- A view cannot be called from a reducer. If module logic needs a read model, materialize it as a
  table in the same transaction.

#### App-owned constants convention

`stdb-es` exports constants only for its own protocol (`GLOBAL_HEAD`, `ANY_VERSION`, `ES_ERROR`,
etc.). Stream types, event types, table names, and view names belong to **your app**, so keep them in
a `constants.ts` file inside each domain. Use the naming format `<SCOPE>_<DOMAIN>` with uppercase
names:

```ts
// spacetimedb/src/domains/orders/constants.ts
export const STREAM_TYPES_ORDER = {
  Order: 'Order',
} as const;

export const EVENT_TYPES_ORDER = {
  Placed: 'OrderPlaced',
  Cancelled: 'OrderCancelled',
} as const;

export const TABLES_ORDER = {
  state: 'orders_state',
  summary: 'orders_summary',
} as const;

export const VIEWS_ORDER = {
  stream: 'order_stream',
  head: 'order_head',
} as const;
```

Use these constants in schema definitions, `makeStreamView({ name })`, projection `handles`, client
registries, `viewQuery`/`tableQuery`, and contract fixtures. Do not add them to the core package.

Keep `constants.ts` free of server-only imports. If module and web are separate packages, place the
file in a small shared package or generate it from one source so both sides use identical literals.

### 1.3 Schema, state cache, and repository

```ts
// spacetimedb/src/index.ts
import { schema, t, table } from 'spacetimedb/server';
import {
  esTables,
  makeRepository,
  defineAggregate,
  type CtxOf,
  type StateCache,
} from 'stdb-es/server';

export type CounterEvent =
  | { kind: 'Incremented'; by: number }
  | { kind: 'Decremented'; by: number }
  | { kind: 'Reset' };

/** App-owned and private. `version` is the guard. */
const counterState = table(
  { name: 'counter_state' },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState });
export default spacetimedb;

export type Context = CtxOf<typeof spacetimedb>;

export const counterDefinition = defineAggregate<{ value: bigint }, CounterEvent>({
  streamType: 'Counter',
  initial: () => ({ value: 0n }),
  decode: (row) => JSON.parse(row.data) as CounterEvent,
  evolve: (state, event) => {
    switch (event.kind) {
      case 'Incremented':
        return { value: state.value + BigInt(event.by) };
      case 'Decremented':
        return { value: state.value - BigInt(event.by) };
      case 'Reset':
        return { value: 0n };
    }
  },
});

/** The library never sees the row shape; it only sees this adapter. */
export const counterCache: StateCache<{ value: bigint }, Context> = {
  load: (ctx, streamId) => {
    const row = ctx.db.counterState.streamId.find(streamId);
    return row ? { version: row.version, state: { value: row.value } } : null;
  },
  save: (ctx, streamId, version, state) => {
    const row = { streamId, version, value: state.value };
    if (ctx.db.counterState.streamId.find(streamId)) {
      ctx.db.counterState.streamId.update(row);
    } else {
      ctx.db.counterState.insert(row);
    }
  },
  remove: (ctx, streamId) => ctx.db.counterState.streamId.delete(streamId),
};

export const counterRepository = makeRepository(counterDefinition, {
  encode: (event) => ({ eventType: event.kind, data: event }),
  cache: counterCache,
});
```

Cache rules:

1. Write the cache row in the **same transaction** as the events it describes.
2. Only trust a row whose `version` is usable for the requested read. `Repository.load` does this for
   you; a hand-written append hook must do it too.
3. A missing row means **replay the log**, never "state is empty".
4. Changing `evolve` does not change already-cached state. Rebuild the cache and run the doctor after
   a fold change.

### 1.4 Choose one write path

Use **one** of these patterns per aggregate. Do not let both maintain the same cache.

#### Pattern A — generic `append_events` reducer

Best when clients append encoded events directly.

```ts
// spacetimedb/src/index.ts, continued
import { makeAppendReducer, readStream } from 'stdb-es/server';

function replayCounter(ctx: Context, streamId: string): { value: bigint } {
  let state = counterDefinition.initial();
  for (const row of readStream(ctx, streamId)) {
    state = counterDefinition.evolve(state, counterDefinition.decode(row), row);
  }
  return state;
}

export const appendEvents = makeAppendReducer(spacetimedb, {
  eventTypes: ['Incremented', 'Decremented', 'Reset'],
  onAppended: (ctx, result) => {
    const streamId = result.rows[0]?.streamId;
    if (!streamId) return;

    const current = ctx.db.counterState.streamId.find(streamId);
    // A missing row means replay. `onAppended` sees the new rows, so that
    // replay already includes them and must not fold them a second time.
    let state = current ? { value: current.value } : replayCounter(ctx, streamId);

    if (current) {
      for (const row of result.rows) {
        state = counterDefinition.evolve(state, counterDefinition.decode(row), row);
      }
    }

    counterCache.save(ctx, streamId, result.version, state);
  },
});
```

`onAppended` receives the full app context, runs inside the append transaction, and is skipped for an
idempotent replay. A throw rolls the append back.

> `eventTypes` validation belongs to `makeAppendReducer`/`appendToStream`. `Repository.save` calls
> `appendToStream` without an `EventStoreConfig`, so validate event type strings in your own `decode`
> or `encode` functions when Pattern B is the only write path.

#### Pattern B — command-specific reducers

Best when commands should decide events themselves.

```ts
// spacetimedb/src/domains/counter/reducers.ts
import { t } from 'spacetimedb/server';
import { spacetimedb, counterRepository, type CounterEvent } from '../../index.js';

export const increment = spacetimedb.reducer(
  { streamId: t.string(), by: t.i32() },
  (ctx, { streamId, by }) => {
    const aggregate = counterRepository.loadOrCreate(ctx, streamId);
    const events: CounterEvent[] = [{ kind: 'Incremented', by }];
    counterRepository.save(ctx, aggregate, events, {
      expectedVersion: aggregate.version,
    });
  },
);
```

`Repository.save` generates a UUIDv7 event id by default, appends with the expected version, folds
new rows into the loaded aggregate, and writes the cache in the same transaction. A replayed batch is
not folded twice.

### 1.5 Optimistic concurrency and time travel

```ts
import {
  ANY_VERSION,
  NO_STREAM,
  STREAM_EXISTS,
  aggregateStream,
  appendToStream,
  readStream,
} from 'stdb-es/server';

// Fail if the stream already exists: useful for "create" commands.
appendToStream(ctx, { streamId, streamType: 'Order', expectedVersion: NO_STREAM, events });

// Fail if it does not exist.
appendToStream(ctx, { streamId, streamType: 'Order', expectedVersion: STREAM_EXISTS, events });

// Skip the check; safe only for single-writer or naturally idempotent streams.
appendToStream(ctx, { streamId, streamType: 'Order', expectedVersion: ANY_VERSION, events });

// Read a version prefix.
const firstTen = readStream(ctx, streamId, { atVersion: 10 });

// Read by processing time. `createdAtMicros` is indexable; `Timestamp` is not.
const early = readStream(ctx, streamId, { atTimestampMicros: 1_700_000_000_000_000n });

// Fold a prefix straight into state. Returns null if the stream does not exist.
const past = aggregateStream(ctx, streamId, {
  ...counterDefinition,
  atVersion: 10,
});
```

Both bounds intersect. Order by `version`, never by timestamp: events appended in one transaction
share a timestamp. `createdAtMicros` is processing time; put business time in the payload.

`Repository.load(ctx, id, { atVersion })` ignores caches newer than the requested version and replays
the needed prefix. A `atTimestampMicros` bound always replays, because a cache row does not record
which version corresponds to that time.

### 1.6 Projections and read models

An inline projection runs in the append transaction. Keep it deterministic and small.

```ts
import { applyInline, rebuildBatch, type InlineProjection } from 'stdb-es/server';

const totals: InlineProjection<Context> = {
  name: 'counter_totals',
  handles: ['Incremented', 'Decremented'],
  handle: (ctx, row) => {
    const event = JSON.parse(row.data) as CounterEvent;
    const current = ctx.db.counterTotals.id.find('global');
    const next = {
      id: 'global',
      increments: (current?.increments ?? 0n) + (event.kind === 'Incremented' ? BigInt(event.by) : 0n),
      decrements: (current?.decrements ?? 0n) + (event.kind === 'Decremented' ? BigInt(event.by) : 0n),
    };
    if (current) ctx.db.counterTotals.id.update(next);
    else ctx.db.counterTotals.id.insert(next);
  },
  reset: (ctx) => ctx.db.counterTotals.id.delete('global'),
};

// From onAppended:
applyInline(ctx, [totals], result.rows);

// From an app-gated admin reducer, in bounded batches:
const report = rebuildBatch(ctx, [totals], { fromPosition: 1_000n, limit: 200 });
// report: { processed, lastPosition, projections }
```

Do not read `ctx.random` or `ctx.timestamp` for business values in a projection: a rebuild would
produce different results. `rebuildBatch({ reset: true })` requires every projection to define
`reset`. There is no async pump in v1.

For a hot read path, expose a materialized table with `spacetimedb.anonymousView` (anonymous views are
materialized once) or a per-caller `spacetimedb.view` keyed on `ctx.sender`. Use the library's view
factories only for low-volume audit/support reads.

### 1.7 Views and authorization

All SpacetimeDB views are public. The library therefore ships **no** unguarded view; its factories
require an `authorize` predicate.

```ts
import { makeStreamView, makeStreamAtView, makeStreamHeadView } from 'stdb-es/server';

export const orderStream = makeStreamView(spacetimedb, {
  name: 'order_stream',
  authorize: (ctx, streamId) =>
    ctx.db.orderOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const orderStreamAt = makeStreamAtView(spacetimedb, {
  name: 'order_stream_at',
  authorize: (ctx, streamId) =>
    ctx.db.orderOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const orderHead = makeStreamHeadView(spacetimedb, {
  name: 'order_head',
  authorize: (ctx, streamId) =>
    ctx.db.orderOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});
```

Compare identities with `.equals()`, not `===`. If `authorize` returns false, the factories return an
empty result (`undefined` for the head view), never an error that leaks existence.

Parameterized views accept SQL literals only, have no primary-key metadata, and share one client
cache per view. They are not a substitute for a materialized table on a hot path.

### 1.8 Doctor helpers

The library exports pure helpers, not a repair reducer. Expose an admin reducer behind your own
authorization check if operators need a button.

```ts
import { findDrift, repairStream, verifyStreamIntegrity, verifyStreamState } from 'stdb-es/server';

const integrity = verifyStreamIntegrity(ctx, streamId);
// { streamId, streamType, eventCount, problems, ok }

const state = verifyStreamState(ctx, streamId, {
  cache: counterCache,
  replay: replayCounter,
});
// { exists, streamVersion, cachedVersion, cachedState, replayedState, ok }

const bad = findDrift(ctx, { cache: counterCache, replay: replayCounter, streamType: 'Counter' });
const action = repairStream(ctx, streamId, { cache: counterCache, replay: replayCounter });
// 'unchanged' | 'repaired' | 'removed'
```

`verifyStreamIntegrity` catches structural damage. `verifyStreamState` also catches same-version
drift, which the version guard cannot see. Pass `equal` when state contains `Map`, `Set`, or other
non-plain values.

### 1.9 Schema and event evolution

- **Adding a new event type** is app code plus a new string in the registry. JSON payloads need no
  database migration.
- **Changing an existing payload** is not safe in place. Add a `V2` event type and an `upgrade`
  function in the client registry, or keep the old field and add a new optional one.
- **Changing `evolve`** changes the meaning of history. Rebuild state caches and projections, then run
  the doctor/contract suite.
- **Renaming or removing an event type** breaks old rows and existing clients. Treat shipped type
  strings and payload field names as permanent.

---

## Part 2 — Client code

### 2.1 Registry

```ts
// web/src/domains/counter/constants.ts
export const EVENT_TYPES_COUNTER = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;

// web/src/domains/counter/registry.ts
import { createEventRegistry, type EventDefinition } from 'stdb-es/client';
import { EVENT_TYPES_COUNTER } from './constants.js';

type CounterEvent =
  | { kind: 'Incremented'; by: number }
  | { kind: 'Decremented'; by: number }
  | { kind: 'Reset' };

const definitions: Record<string, EventDefinition<CounterEvent, any>> = {
  [EVENT_TYPES_COUNTER.Incremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: 'Incremented', by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Decremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: 'Decremented', by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Reset]: {
    encode: (event) => event,
    decode: () => ({ kind: 'Reset' }),
  },
};

export const counterRegistry = createEventRegistry<CounterEvent>({
  typeOf: (event) => EVENT_TYPES_COUNTER[event.kind],
  events: definitions,
});
```

#### Identity `encode` vs an explicit payload

`encode` produces the JSON value that becomes `es_event.data`. Use it deliberately:

| Situation | Use | Why |
| --- | --- | --- |
| The domain event is already a plain JSON-safe object and its shape is the persisted contract | `encode: (event) => event` | No transformation needed; the event type string already records `kind` |
| The domain type has `bigint`, `Date`, `Map`, class instances, or UI-only fields | explicit `encode` | Convert to a stable JSON shape and drop fields that are not part of the event |
| You want the stored payload to stay stable while TypeScript types change | explicit `encode` | The persisted shape is an API, not a mirror of your internal model |
| Old rows have a different shape | explicit `encode` plus `upgrade` | `upgrade` adapts old payloads before `decode` runs |

Example of a justified explicit codec:

```ts
type PaymentEvent = { kind: 'MoneyCaptured'; amount: bigint; currency: string };

const paymentRegistry = createEventRegistry<PaymentEvent>({
  typeOf: (event) => EVENT_TYPES_PAYMENT.Captured,
  events: {
    [EVENT_TYPES_PAYMENT.Captured]: {
      // bigint cannot be JSON.stringify'd directly.
      encode: (event) => ({ amount: event.amount.toString(), currency: event.currency }),
      decode: (payload) => ({
        kind: 'MoneyCaptured',
        amount: BigInt(payload.amount),
        currency: payload.currency,
      }),
      // Old rows that stored `amount` as a number are upgraded on read.
      upgrade: (payload: any) =>
        typeof payload.amount === 'string' ? payload : { ...payload, amount: String(payload.amount) },
    },
  },
});
```

`decode` must invert the current `encode` shape. `upgrade` runs first and exists only for historical
rows. Once deployed, the output of `encode` is historical data: change it only with a new event type
or an `upgrade`.

`encode` is used by `encodeEvents`, `store.encode`, and `store.append`. It is **not** used on the read
path (`upgrade` and `decode` are), and it is separate from the server-side `RepositoryOptions.encode`
used when a module command calls `repository.save(...)`.

### 2.2 Append client

```ts
// web/src/domains/counter/api.ts
import { createEventStoreClient } from 'stdb-es/client';
import { counterRegistry } from './registry.js';
import type { DbConnection } from '../../generated/index.js';

export function makeCounterStore(connection: DbConnection) {
  return createEventStoreClient({
    registry: counterRegistry,
    // Adapt to the generated binding's shape. The callback itself takes one object.
    append: (args) =>
      connection.reducers.appendEvents(
        args.streamId,
        args.streamType,
        args.expectedVersion,
        args.events,
        args.metadata,
      ),
  });
}
```

The `append` callback receives:

```ts
type AppendCallArgs = {
  streamId: string;
  streamType: string;
  expectedVersion: number;
  events: EncodedEvent[];
  metadata: string | null;
};
```

The callback may return `Promise<unknown>`; its resolved value is ignored.

### 2.3 Append, retry, and errors

```ts
import { ES_ERROR, esErrorCode } from 'stdb-es';
import { NO_STREAM } from 'stdb-es';

// Create: fail if the stream already exists.
await store.append('order-42', 'Order', [{ kind: 'Incremented', by: 5 }], {
  expectedVersion: NO_STREAM,
});

// Encode once, retry verbatim. Event ids are reused, so a commit that timed out
// settles as `replayed` rather than a duplicate append.
const batch = store.encode([{ kind: 'Incremented', by: 2 }]);
try {
  await store.retry('order-42', 'Order', batch, { expectedVersion: 1 });
} catch (error) {
  if (esErrorCode(error) === ES_ERROR.EXPECTED_VERSION_MISMATCH) {
    // Reload the version and decide whether to retry with a new expected version.
  } else {
    throw error;
  }
}
```

`store.append` defaults to `ANY_VERSION`. Pass an explicit expected version whenever two clients can
write the same stream. `newEventId` defaults to `crypto.randomUUID()`; inject your own generator in
tests or if you use a different id scheme.

### 2.4 Decode and slice subscribed rows

```ts
import { sliceRows } from 'stdb-es/client';

const decoded = store.decodeAll(viewRows);
const current = sliceRows(decoded, {
  streamId: 'order-42',
  fromVersion: 5,
  atVersion: 20,
  limit: 50,
});
```

`sliceRows` sorts by version. It filters rows the subscription already delivered; it is not a second
source of truth and does not fetch missing history.

### 2.5 Subscription queries

```ts
import { tableQuery, viewQuery } from 'stdb-es/client';

connection.subscribe([
  tableQuery('counter_summary'),
  viewQuery('order_stream', ['order-42']),
  viewQuery('order_stream_at', ['order-42', 10]),
]);

viewQuery('order_stream', ["O'Brien"]); // strings are escaped by viewQuery
```

`viewQuery(name, args)` emits `SELECT * FROM name(args...)`, escaping strings and formatting
bigints/booleans/nulls. Identifiers are validated; they are not escaped as values.

### 2.6 Stream IDs

The shared `streamId(prefix, key)` helper from `stdb-es` builds ids of the form `<prefix>-<key>`:

```ts
import { NO_STREAM, streamId } from 'stdb-es';
import { STREAM_TYPES_ORDER } from './constants.js';

const id = streamId('order', '42'); // 'order-42'
const createId = streamId('order', crypto.randomUUID());

await store.append(createId, STREAM_TYPES_ORDER.Order, [{ kind: 'Placed' }], {
  expectedVersion: NO_STREAM,
});
```

The helper:

- requires a prefix starting with a letter and containing only letters, digits, or underscores, so
  the `-` separator is unambiguous;
- accepts string, non-negative integer, or non-negative bigint keys;
- allows letters, digits, `_`, `.`, `:`, and `-` in string keys — UUIDs, hex identities, and dotted
  business keys all work;
- rejects spaces, quotes, semicolons, slashes, and other unsafe characters;
- enforces the same 256-character limit as `appendToStream`;
- throws an `Error` whose code is `ES_INVALID_BATCH`.

It is **formatting and validation only**. It does not decide ownership or generate a business id for
you.

#### Who generates the stream id?

| Approach | Use when | Consequence |
| --- | --- | --- |
| **Frontend** | Create flows where the client knows the business id or wants an idempotent retry | Use `expectedVersion: NO_STREAM`; the module must still validate and authorize the id |
| **Module** | The id comes from `ctx.sender`, a server-side sequence, or other trusted domain rules | The client cannot know the id before the append; it must discover it through a view because reducers return `void` |
| **Hybrid (recommended default)** | The client supplies a stable command/correlation id and the module derives or validates the stream id | Avoids client-chosen privileged ids while keeping retry correlation simple |

Frontend-generated example above is appropriate for a public "create order" flow. A module-derived
example looks like this:

```ts
// spacetimedb/src/domains/orders/reducers.ts
import { streamId } from 'stdb-es';
import { t } from 'spacetimedb/server';
import { orderRepository, spacetimedb, type OrderEvent } from '../../index.js';
import { STREAM_TYPES_ORDER } from './constants.js';

export const placeOrder = spacetimedb.reducer(
  { commandId: t.string() },
  (ctx, { commandId }) => {
    const id = streamId('order', commandId);
    // Check ownership/authorization for `id` here before saving.
    const aggregate = orderRepository.loadOrCreate(ctx, id);
    const events: OrderEvent[] = [{ kind: 'Placed', orderId: id }];
    orderRepository.save(ctx, aggregate, events, { expectedVersion: aggregate.version });
  },
);
```

Use `streamId` on both sides only with the same prefix. Event ids are a separate concern: client
appends get ids from `crypto.randomUUID()` (or an injected generator), while `Repository.save` uses
`ctx.newUuidV7()`.

---

## Part 3 — Testing

### 3.1 Test layers

| Layer | Where it runs | Tooling | Purpose |
| --- | --- | --- | --- |
| Core package tests | offline | `npm test` | Library maintainers verify every shipped export |
| Consumer module/client unit tests | offline | `stdb-es/testing` + Vitest | App code verifies reducers, cache, projections, views, and client encoding without a server |
| Consumer integration tests | real server | planned `stdb-es/testing/integration` | App code verifies publish, concurrency, subscriptions, and anonymous access end to end |
| Maintainer smoke | real server | `npm run smoke` | Publish the counter example and assert live behavior |

### 3.2 Core package tests

```bash
npm test        # offline; no server
npm run build
```

The suite uses SpacetimeDB's in-memory module harness. It covers append/concurrency/dedupe, reads and
time travel, aggregates and caches, projections, views, doctor helpers, and all stable `ES_*` error
codes.

### 3.3 App module unit tests

`stdb-es/testing` currently ships `withIndexRanges`, `wireEvent`, `wireEvents`, and `versions`, plus
the contract suite. `withIndexRanges` works around a `Range` class mismatch in the
`spacetimedb@2.15.0` test harness; use it on every reducer or view context in tests. The real host is
unaffected.

```ts
// spacetimedb/src/domains/counter/reducers.test.ts
import { expect, it } from 'vitest';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { readStream, streamVersion } from 'stdb-es/server';
import { wireEvents, withIndexRanges } from 'stdb-es/testing';
import spacetimedb, { appendEvents } from '../../index.js';

it('appends a batch in version order', () => {
  const harness = createModuleTestHarness(spacetimedb, { appendEvents });

  harness.withReducerTx(TestAuth.internal(), (rawCtx) => {
    const ctx = withIndexRanges(rawCtx);
    appendEvents(ctx, {
      streamId: 'counter-1',
      streamType: 'Counter',
      expectedVersion: 0,
      events: wireEvents('seed-', [
        ['Incremented', { kind: 'Incremented', by: 5 }],
        ['Decremented', { kind: 'Decremented', by: 2 }],
      ]),
    });
  });

  harness.withReducerTx(TestAuth.internal(), (rawCtx) => {
    const ctx = withIndexRanges(rawCtx);
    expect(readStream(ctx, 'counter-1').map((row) => row.version)).toEqual([1, 2]);
    expect(streamVersion(ctx, 'counter-1')).toBe(2);
  });
});
```

`wireEvents(prefix, pairs)` produces deterministic ids `${prefix}-1`, `${prefix}-2`, and so on, which
also makes retry/dedupe tests reproducible.

### 3.4 Contract tests for app code

```ts
// spacetimedb/src/domains/counter/contract.test.ts
import { expect } from 'vitest';
import { makeRepository, readStream } from 'stdb-es/server';
import { runEventStoreContractTests, wireEvents } from 'stdb-es/testing';
import {
  appendEvents,
  counterCache,
  counterDefinition,
  counterStream,
  spacetimedb,
  type Context,
} from '../../index.js';

const repository = makeRepository(counterDefinition, {
  encode: (event) => ({ eventType: event.kind, data: event }),
  cache: counterCache,
});

/** Full replay that ignores the cache, as required by the doctor and contract. */
const replay = (ctx: Context, id: string) => {
  let state = counterDefinition.initial();
  for (const row of readStream(ctx, id)) {
    state = counterDefinition.evolve(state, counterDefinition.decode(row), row);
  }
  return state;
};

runEventStoreContractTests({
  name: 'Counter contract',
  spacetimedb,
  moduleExports: { appendEvents },
  append: (ctx, args) => appendEvents(ctx, args),
  streamId: () => 'counter-contract',
  streams: [
    {
      streamType: 'Counter',
      repository,
      stateCache: counterCache,
      replay,
      sample: {
        wire: (id) =>
          wireEvents(id, [
            ['Incremented', { kind: 'Incremented', by: 5 }],
            ['Decremented', { kind: 'Decremented', by: 2 }],
          ]),
        domain: () => [
          { kind: 'Incremented', by: 5 },
          { kind: 'Decremented', by: 2 },
        ],
        expectedState: { value: 3n },
        corrupt: (state) => ({ value: state.value + 1_000n }),
      },
    },
  ],
  views: [
    {
      name: 'counter_stream',
      view: counterStream,
      params: (id) => ({ streamId: id }),
      seed: (ctx, id) => ctx.db.counterOwner.insert({ streamId: id, owner: ctx.sender }),
      check: (rows) => expect((rows as unknown[]).length).toBeGreaterThan(0),
    },
  ],
});
```

The contract suite checks append/read ordering, gapless positions, stale-version rejection,
idempotent replay, cache/replay agreement, structural integrity, time travel, same-version drift
repair, projection rebuild parity, and view output. Each case uses a fresh harness.

### 3.5 Client unit tests without a server

There is no network call to fake if you inject the append callback.

```ts
import { expect, it } from 'vitest';
import { createEventStoreClient } from 'stdb-es/client';
import { counterRegistry } from './registry.js';

it('reuses ids when a batch is retried', async () => {
  const calls: unknown[] = [];
  const store = createEventStoreClient({
    registry: counterRegistry,
    newEventId: () => 'fixed-id',
    append: async (args) => {
      calls.push(args);
    },
  });

  const batch = store.encode([{ kind: 'Incremented', by: 1 }]);
  await store.retry('counter-1', 'Counter', batch, { expectedVersion: 0 });

  expect(calls).toHaveLength(1);
  expect(batch[0]?.eventId).toBe('fixed-id');
});
```

**Planned in M6:** `createModuleTest`, `ids`, `expectAppendError`, and `createFakeAppend` will reduce
the setup above to a one-import helper. They are not shipped yet.

### 3.6 Integration tests

The shipped smoke test proves the real-server path for the library:

```bash
spacetime start --in-memory --non-interactive
npm run smoke
```

It publishes the counter example, appends, rejects a stale version, replays idempotently, deletes a
cache row and verifies replay-based recovery, and queries the anonymous view.

**Planned in M7:** `stdb-es/testing/integration` will expose a Node-only `createIntegrationEnv` that
publishes to a disposable database, calls reducers, runs owner/anonymous SQL, connects clients, waits
for subscription convergence, and disposes the database. It will connect to an already-running
server; it will not spawn `spacetime start` for you.

---

## Part 4 — Simple React frontend

### 4.1 Setup

Generate TypeScript bindings from the published module with the SpacetimeDB CLI, then install the
React SDK:

```bash
npm install stdb-es spacetimedb
npx spacetime generate --lang ts --out-dir web/src/generated
```

The generated module exposes `DbConnection`, `tables`, and `reducers`. Keep it in one folder and
never edit it by hand.

### 4.2 Provider

```tsx
// web/src/app/provider.tsx
import type { ReactNode } from 'react';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from '../generated/index.js';

const connectionBuilder = DbConnection.builder()
  .withUri(import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000')
  .withDatabaseName(import.meta.env.VITE_STDB_DATABASE ?? 'stdb-es-counter');

export function AppProvider({ children }: { children: ReactNode }) {
  return <SpacetimeDBProvider connectionBuilder={connectionBuilder}>{children}</SpacetimeDBProvider>;
}
```

`useSpacetimeDB()` gives access to the connection state and `getConnection()`. `useTable(query)`
returns `[rows, isReady]` for generated tables and anonymous views. `useReducer(reducerDef)` returns
a typed function that calls a generated reducer and returns a promise.

### 4.3 Domain-separated frontend layout

```text
web/src/
  app/
    provider.tsx
    layout.tsx
  generated/
  domains/
    counter/
      constants.ts       # EVENT_TYPES_COUNTER, TABLES_COUNTER, VIEWS_COUNTER
      api.ts             # makeCounterStore + registry
      registry.ts
      CounterPanel.tsx
      counter.test.ts     # client unit test
    orders/
      constants.ts       # same literals as the module domain constants
      api.ts
      registry.ts
      OrderList.tsx
    inventory/
      constants.ts
      api.ts
      registry.ts
      StockPanel.tsx
  shared/
    ui/
```

Each domain owns its constants, registry, api wrapper, hooks, and components. Share only the
provider, design system, and generated client. A multi-domain screen composes domain panels; it does
not import one domain's event union into another.

Frontend `constants.ts` files mirror the module domain constants using the `<SCOPE>_<DOMAIN>` naming
format. Keep them free of server imports. If module and web are separate packages, generate them from
one source so the literals cannot drift.

### 4.4 A minimal counter panel

```tsx
// web/src/domains/counter/CounterPanel.tsx
import { useEffect, useMemo, useState } from 'react';
import { useReducer as useSpacetimeReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { ES_ERROR, esErrorCode } from 'stdb-es';
import { createEventStoreClient, viewQuery } from 'stdb-es/client';
import { reducers, tables } from '../../generated/index.js';
import { counterRegistry } from './registry.js';

const STREAM_ID = 'counter-1';
const STREAM_TYPE = 'Counter';

export function CounterPanel() {
  const [rows, ready] = useTable(tables.counterSummary);
  const { getConnection } = useSpacetimeDB();
  const callAppend = useSpacetimeReducer(reducers.appendEvents);
  const [by, setBy] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const state = rows.find((row) => row.streamId === STREAM_ID);

  const store = useMemo(
    () =>
      createEventStoreClient({
        registry: counterRegistry,
        append: (args) =>
          callAppend(
            args.streamId,
            args.streamType,
            args.expectedVersion,
            args.events,
            args.metadata,
          ),
      }),
    [callAppend],
  );

  // Parameterized views are not covered by useTable's typed query builder;
  // subscribe through the connection with a literal query.
  useEffect(() => {
    const connection = getConnection();
    if (!connection) return;
    connection.subscribe([viewQuery('counter_stream', [STREAM_ID])]);
  }, [getConnection]);

  async function increment() {
    setBusy(true);
    setError(null);
    try {
      await store.append(STREAM_ID, STREAM_TYPE, [{ kind: 'Incremented', by }], {
        expectedVersion: state?.version ?? 0,
      });
      // The reducer returns void. The new version arrives through the subscription;
      // do not assume a local version here.
    } catch (cause) {
      setError(
        esErrorCode(cause) === ES_ERROR.EXPECTED_VERSION_MISMATCH
          ? 'Someone updated this counter first. The list will refresh.'
          : 'Could not append the event.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Counter {STREAM_ID}</h2>
      <p>{ready ? `Value: ${state?.value.toString() ?? '0'}` : 'Loading…'}</p>
      <input
        aria-label="Increment by"
        type="number"
        value={by}
        onChange={(event) => setBy(Number(event.target.value))}
      />
      <button disabled={busy} onClick={increment}>
        Increment
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
```

For a view row, `store.decode(row)` and `store.decodeAll(rows)` accept the minimal `StoredEventRow`
shape (`eventId`, `position`, `streamId`, `streamType`, `version`, `eventType`, `data`, optional
`metadata` and `createdAtMicros`). Use them when you want domain events rather than raw rows.

### 4.5 UI guidance for the example sets

- Show the current version or status. Reducers return void, so "success" is observed through a
  subscription or a head view.
- Show `replayed` distinctly from `appended` in idempotency demos by reading the head view after a
  retry.
- For eventual consistency, show a pending state until the expected version arrives; do not claim a
  global commit from a local click.
- Keep one screen per set. Multi-domain sets use a shared provider and separate panels.
- Never subscribe to `es_event` directly. It is private; use an authorized view or a materialized read
  model.

---

## Checklist before shipping an app

- [ ] `esTables` is spread into exactly one module schema.
- [ ] Core tables remain private; no view exposes them without `authorize`.
- [ ] Every state cache table has a `version` column and a replay-on-miss path.
- [ ] Every command uses an explicit `expectedVersion` when concurrent writers are possible.
- [ ] Event ids are stable across retries and fresh for new events.
- [ ] Projections are deterministic and have `reset` if rebuilds are needed.
- [ ] Old payloads have `upgrade` functions in the client registry.
- [ ] The contract suite and module unit tests run offline in CI.
- [ ] The React client reads public views/materialized tables only.
