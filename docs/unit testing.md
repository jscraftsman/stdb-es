# Unit testing guide

`stdb-es/testing` lets an app test its SpacetimeDB module and client **offline**: no server, no
network, no disposable database. It wraps the in-memory SpacetimeDB module harness, adds deterministic
event ids, provides a fake append binding for client tests, and ships a reusable contract suite.

> This is the complete guide for Layer 2 in the [testing strategy](event-sourcing-plan.md#142-layer-2--consumer-unit-tests-stdb-estesting-r2).
> For the full app walkthrough, see the [Package Usage Guide](usage-guide.md). For exact signatures,
> see the [API reference](API.md#4-stdb-estesting--offline-test-tooling).

## What is shipped

| Export | Use |
| --- | --- |
| `createModuleTest(spacetimedb, moduleExports, options?)` | Fresh in-memory module test with range-scanner workaround applied |
| `ids(prefix, count)` | Deterministic event ids for fixtures and retry tests |
| `expectAppendError(fn, code)` | Runner-agnostic assertion for a stable `ES_*` failure |
| `createFakeAppend(options?)` | Generated append-binding fake that records calls |
| `wireEvent`, `wireEvents`, `versions` | Wire-event and assertion fixtures |
| `withIndexRanges(ctx)` | Harness shim used automatically by `createModuleTest` |
| `runEventStoreContractTests(options)` | Shared invariant suite for an app's event store |

`vitest` is an optional peer dependency. `createModuleTest`, `ids`, `expectAppendError`, and
`createFakeAppend` do not need it; `runEventStoreContractTests` imports `describe`/`expect`/`it` from
it and registers cases at call time.

---

## 1. Setup

```bash
npm install --save-dev vitest
```

Module tests need SpacetimeDB's Vitest plugin so the in-memory datastore is available:

```ts
// vitest.config.ts
import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

export default defineConfig({
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
});
```

Keep the test config at the package that owns the module. Client-only tests do not need this plugin,
but including it is harmless.

---

## 2. A first module test

The app owns its literals, so import them from its per-domain `constants.ts` file. The test imports
only from `stdb-es`, `stdb-es/server`, `stdb-es/testing`, `vitest`, and its own module code.

```ts
// spacetimedb/src/domains/counter/reducers.test.ts
import { expect, it } from 'vitest';
import { NO_STREAM, streamId } from 'stdb-es';
import { readStream } from 'stdb-es/server';
import { createModuleTest, wireEvents } from 'stdb-es/testing';
import spacetimedb, { appendEvents } from '../../index.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';

it('appends a batch in version order', () => {
  const test = createModuleTest(spacetimedb, { appendEvents });
  const id = streamId(STREAM_PREFIXES_COUNTER.counter, 'unit');

  test.call('appendEvents', {
    streamId: id,
    streamType: STREAM_TYPES_COUNTER.Counter,
    expectedVersion: NO_STREAM,
    events: wireEvents('seed-', [
      [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
      [EVENT_TYPES_COUNTER.Decremented, { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 }],
    ]),
    metadata: null,
  });

  expect(test.tx((ctx) => readStream(ctx, id).map((row) => row.version))).toEqual([1, 2]);
});
```

`createModuleTest` creates a fresh harness for each test. Call it inside `it`, not once at module
scope, unless you deliberately want to share state between cases.

### `createModuleTest` return value

| Member | Purpose |
| --- | --- |
| `tx(body, auth?)` | Runs `body` in a reducer transaction with a shimmed context; commits on success, rolls back on throw |
| `call(name, args?, auth?)` | Calls a reducer from `moduleExports` inside `tx` |
| `view(target, params, auth?)` | Calls an authenticated view with a shimmed context |
| `anonymousView(target, params)` | Calls an anonymous view with a shimmed context |
| `harness` | The underlying `ModuleTestHarness`, for `clock`, `rng`, `db`, and `runQuery` |
| `auth` | The default `TestAuth` used by `tx`, `call`, and `view` |
| `moduleExports` | The exports object passed in |

`tx` is useful for direct table setup and reads; `call` is shorter for reducers:

```ts
test.tx((ctx) => {
  ctx.db.counterOwner.insert({ streamId: id, owner: test.harness.moduleIdentity });
});

const rows = test.view(counterStream, { streamId: id });
expect(rows).toHaveLength(2);
```

For anonymous views, use `test.anonymousView(view, params)`; it uses `anonymousViewContext()`.

### Time, randomness, and sender

The third argument is optional and mirrors the harness options, plus `auth`:

```ts
import { TestAuth, TestClock } from 'spacetimedb/server/test-utils';

const test = createModuleTest(spacetimedb, { appendEvents }, {
  auth: TestAuth.internal(),
  clock: new TestClock(),
  rngSeed: 42,
});
```

Pass a different `auth` to one call when a test needs a second sender. For a JWT-based sender, use
`TestAuth.fromJwtPayload(payload, connectionId)`.

---

## 3. Deterministic event ids

`ids(prefix, count)` returns `${prefix}-1` through `${prefix}-${count}`. The same call always returns
the same ids, so a fixture can be submitted twice to exercise real deduplication.

```ts
import { ids, wireEvent } from 'stdb-es/testing';

ids('evt', 3); // ['evt-1', 'evt-2', 'evt-3']

const events = ids('retry', 2).map((eventId, index) =>
  wireEvent(eventId, 'Incremented', { kind: 'Incremented', by: index + 1 }),
);
```

`wireEvents(prefix, pairs)` uses `ids` internally. Both helpers reject an empty prefix, a non-positive
count, or ids longer than the server's 128-character limit. `wireEvents(prefix, [])` still returns an
empty array.

Use a distinct prefix per test or per append attempt. Reusing ids is how you test a retry; reusing them
for a genuinely new append hides bugs.

---

## 4. Asserting append failures

Store failures carry stable codes such as `ES_EXPECTED_VERSION_MISMATCH`. Match the code, not the
human-readable detail.

```ts
import { ES_ERROR } from 'stdb-es';
import { expectAppendError, ids, wireEvent } from 'stdb-es/testing';

expectAppendError(
  () =>
    test.call('appendEvents', {
      streamId: id,
      streamType: STREAM_TYPES_COUNTER.Counter,
      expectedVersion: 0, // stale: the stream already exists
      events: [wireEvent('stale-1', EVENT_TYPES_COUNTER.Incremented, { by: 1 })],
    }),
  ES_ERROR.EXPECTED_VERSION_MISMATCH,
);
```

Important: use **fresh** ids for a stale-version test. Dedupe runs before the version check, so
resubmitting an already committed batch returns `replayed` instead of a conflict.

`expectAppendError` accepts synchronous reducer calls and async client calls:

```ts
await expectAppendError(
  async () => client.append(id, streamType, events, { expectedVersion: 0 }),
  ES_ERROR.EXPECTED_VERSION_MISMATCH,
);
```

On failure it throws a plain `Error` describing the expected code, the actual code, and the message.
That keeps it usable with Vitest, Node's test runner, or a plain script.

---

## 5. Client tests with a fake append

The client owns no state. Its only side effect is the injected append callback, so a fake is enough
for encoding, retry, and version tests.

```ts
import { createEventStoreClient } from 'stdb-es/client';
import { createFakeAppend, ids } from 'stdb-es/testing';

const append = createFakeAppend({ result: { status: 'appended', version: 1 } });
const client = createEventStoreClient({
  registry: counterRegistry,
  append,
  newEventId: () => 'fixed-id',
});

await client.append(id, streamType, [{ kind: 'Incremented', by: 1 }]);

expect(append.calls).toHaveLength(1);
expect(append.calls[0]?.events[0]?.eventId).toBe('fixed-id');
expect(append.lastCall?.expectedVersion).toBe(-1); // ANY_VERSION by default
```

The fake records a shallow copy of each call, including a new events array, so later mutations do not
change recorded history. It resolves with `result` by default. Use `error` to reject every call:

```ts
const timeout = createFakeAppend({ error: new Error('network timeout') });
await expect(timeout(callArgs)).rejects.toThrow('network timeout');
```

For a timeout-then-success retry sequence, queue replies:

```ts
const append = createFakeAppend();
append.nextError(new Error('timeout')).nextResult({ status: 'appended' });

await expect(client.retry(id, streamType, encodedBatch)).rejects.toThrow('timeout');
await expect(client.retry(id, streamType, encodedBatch)).resolves.toEqual({
  status: 'appended',
});
expect(append.calls).toHaveLength(2);
expect(append.calls[0]?.events).toEqual(append.calls[1]?.events); // same ids on retry
```

Queued replies are consumed in order; after the queue is empty the configured default applies.
`append.clear()` clears recorded calls without clearing queued replies.

---

## 6. Contract tests

A module test checks one behavior. A contract suite checks the event-store invariants the app relies
on: append/read ordering, gapless positions, concurrency, dedupe, cache/replay agreement, structural
integrity, time travel, projection rebuild parity, and view output.

```ts
import { runEventStoreContractTests } from 'stdb-es/testing';

runEventStoreContractTests({
  name: 'Counter contract',
  spacetimedb,
  moduleExports: { appendEvents },
  append: (ctx, args) => appendEvents(ctx, args),
  streams: [/* one entry per aggregate kind */],
  projections: {/* optional */},
  views: [/* optional */],
});
```

See the [API reference](API.md#42-contract-suite) for every option, or the
[usage guide](usage-guide.md#34-contract-tests-for-app-code) for a complete counter example. The
package dogfoods this suite in `test/contracts.test.ts`, so regressions in the shipped helper fail
this repository's own `npm test`.

Use both layers: a handful of focused module/client tests for app rules, plus one contract suite for
the store invariants. Contract tests are slower because each case creates a fresh harness.

---

## 7. Running and troubleshooting

```bash
npx vitest run              # one shot, CI friendly
npx vitest                  # watch mode
```

No `spacetime start` is needed. These tests use the in-memory module harness only.

| Symptom | Fix |
| --- | --- |
| Composite range scans return no rows or throw `Cannot convert ... to a BigInt` | Use `createModuleTest`, or wrap the context with `withIndexRanges(ctx)` in your own helper. This is a `spacetimedb@2.15.0` harness bug, not a host bug. |
| Reducer tests fail with a missing datastore error | Add `spacetimedbModuleTestPlugin()` to `vitest.config.ts`. |
| A stale-version test returns `replayed` | You reused committed event ids. Generate fresh ids with a new prefix. |
| `vitest` import fails | Install the optional peer as a dev dependency when using `runEventStoreContractTests`. |
| Tests leak state between cases | Create the `createModuleTest` instance inside each `it`. |

---

## 8. What is not here

Server lifecycle tests — publish, call reducers over the network, owner/anonymous SQL, and live
subscription convergence — belong to the Node-only `stdb-es/testing/integration` entry. They need a
real server and are deliberately separate from this offline kit. See the
[Integration testing guide](integration%20testing.md) for the shipped M7 lifecycle. The current
`npm run smoke` is a maintainer-only live check, not a consumer test API.
