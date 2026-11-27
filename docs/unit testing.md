# Unit testing guide

`stdb-es/testing` lets an app test its SpacetimeDB module and client **offline**: no server, no
network, no disposable database. It wraps the in-memory SpacetimeDB module harness, adds deterministic
fixture ids, provides a fake for generated command bindings, and ships a reusable contract suite.

> This is the complete guide for Layer 2 in the [testing strategy](event-sourcing-plan.md#142-layer-2--consumer-unit-tests-stdb-estesting-r2).
> For the full app walkthrough, see the [Package Usage Guide](usage-guide.md). For exact signatures,
> see the [API reference](API.md#4-stdb-estesting--offline-test-tooling).

## What is shipped

| Export | Use |
| --- | --- |
| `createModuleTest(spacetimedb, moduleExports, options?)` | Fresh in-memory module test with range-scanner workaround applied |
| `ids(prefix, count)` | Deterministic ids for server-side fixtures and retry tests |
| `expectAppendError(fn, code)` | Runner-agnostic assertion for a stable `ES_*` store failure |
| `createFakeCommand<TCommand>(options?)` | Generated command-binding fake that records intent and `commandId` |
| `wireEvent`, `wireEvents`, `versions` | Wire-event and assertion fixtures for server-side store tests |
| `withIndexRanges(ctx)` | Harness shim used automatically by `createModuleTest` |
| `runEventStoreContractTests(options)` | Shared invariant suite, including optional command-boundary checks |

No append fake is shipped: clients have no append binding. Use `createFakeCommand` for client
tests; use `wireEvents`/`ids` only with server-side `appendToStream` fixtures. The fake is a plain
async callback, so React, Phaser, vanilla TypeScript, and Node client tests use the same API.

`vitest >=3 <4` is a required peer dependency of `stdb-es`; install it as a dev dependency in every
workspace that uses this entry. Only `runEventStoreContractTests` imports `describe`/`expect`/`it` at
runtime; `createModuleTest`, `ids`, `expectAppendError`, and `createFakeCommand` are runner-agnostic in
implementation.

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

Call the app's real command reducers. The client sends intent; the test asserts the facts the module
derived from it.

```ts
// spacetimedb/src/domains/counter/reducers.test.ts
import { expect, it } from 'vitest';
import { streamId } from 'stdb-es';
import { readStream } from 'stdb-es/server';
import { createModuleTest } from 'stdb-es/testing';
import spacetimedb, { increment } from '../../index.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
} from './constants.js';

it('derives one event from an increment command', () => {
  const test = createModuleTest(spacetimedb, { increment });
  const id = streamId(STREAM_PREFIXES_COUNTER.counter, 'unit');

  test.call('increment', { counterId: 'unit', by: 5, commandId: 'cmd-1' });

  expect(
    test.tx((ctx) =>
      readStream(ctx, id).map((row) => ({
        eventId: row.eventId,
        eventType: row.eventType,
        version: row.version,
        data: JSON.parse(row.data),
      })),
    ),
  ).toEqual([
    {
      eventId: 'inc-cmd-1',
      eventType: EVENT_TYPES_COUNTER.Incremented,
      version: 1,
      data: { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 },
    },
  ]);
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
  ctx.db.counterOwner.insert({ streamId: id, owner: ctx.sender });
});

const rows = test.view(counterStream, { streamId: id });
expect(rows).toHaveLength(1);
```

For anonymous views, use `test.anonymousView(view, params)`; it uses `anonymousViewContext()`.

### Time, randomness, and sender

The third argument is optional and mirrors the harness options, plus `auth`:

```ts
import { TestAuth, TestClock } from 'spacetimedb/server/test-utils';

const test = createModuleTest(spacetimedb, { increment }, {
  auth: TestAuth.internal(),
  clock: new TestClock(),
  rngSeed: 42,
});
```

Pass a different `auth` to one call when a test needs a second sender. For a JWT-based sender, use
`TestAuth.fromJwtPayload(payload, connectionId)`. A non-owner call should fail before writing:

```ts
import { Identity } from 'spacetimedb';

test.tx((ctx) => {
  ctx.db.counterOwner.insert({ streamId: id, owner: new Identity('11'.repeat(32)) });
});

expect(() =>
  test.call('increment', { counterId: 'unit', by: 1, commandId: 'intruder' }),
).toThrow(/CMD_UNAUTHORIZED/);
```

---

## 3. Deterministic ids

`ids(prefix, count)` returns `${prefix}-1` through `${prefix}-${count}`. The same call always returns
the same ids, so a server-side fixture can be submitted twice to exercise real deduplication.

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

Commands use a different idempotency key: `commandId` is chosen by the caller, and the module derives
deterministic event ids from it. To test command replay, call the same command twice rather than
building event rows:

```ts
const command = { counterId: 'unit', by: 2, commandId: 'cmd-retry' };
test.call('increment', command);
test.call('increment', command);
expect(test.tx((ctx) => readStream(ctx, id))).toHaveLength(1);
```

Use a distinct prefix or command id per test. Reusing an id is how you test a retry; reusing it for a
genuinely new append hides bugs.

---

## 4. Asserting append failures

Store failures carry stable codes such as `ES_EXPECTED_VERSION_MISMATCH`. Match the code, not the
human-readable detail. `expectAppendError` is for the **server-side** store seam used by module tests
and the contract suite.

```ts
import { ES_ERROR, NO_STREAM } from 'stdb-es';
import { appendToStream } from 'stdb-es/server';
import { expectAppendError, wireEvents } from 'stdb-es/testing';

const events = (prefix: string) =>
  wireEvents(prefix, [
    [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 1 }],
  ]);

test.tx((ctx) =>
  appendToStream(ctx, {
    streamId: id,
    streamType: STREAM_TYPES_COUNTER.Counter,
    expectedVersion: NO_STREAM,
    events: events('first'),
  }),
);

expectAppendError(
  () =>
    test.tx((ctx) =>
      appendToStream(ctx, {
        streamId: id,
        streamType: STREAM_TYPES_COUNTER.Counter,
        expectedVersion: NO_STREAM,
        events: events('fresh'),
      }),
    ),
  ES_ERROR.EXPECTED_VERSION_MISMATCH,
);
```

Important: use **fresh** ids for a stale-version test. Dedupe runs before the version check, so
resubmitting an already committed batch returns `replayed` instead of a conflict.

`expectAppendError` also accepts async callbacks:

```ts
await expectAppendError(
  async () => serverAppend(argsWithFreshEventIds),
  ES_ERROR.EXPECTED_VERSION_MISMATCH,
);
```

Command rejections use the app's own codes, not `ES_*`. Assert them directly:

```ts
expect(() =>
  test.call('increment', { counterId: 'unit', by: 0, commandId: 'bad' }),
).toThrow(/CMD_INVALID_COMMAND/);
```

---

## 5. Client tests with a fake command

The client sends intent and owns no event log. Its only side effect is the generated reducer binding,
so `createFakeCommand` is enough for command-id, retry, and rejection tests. It is framework-neutral:
pass the same fake to code that uses React hooks, Phaser scenes, vanilla callbacks, or plain SDK
functions. No DOM or framework runtime is needed.

```ts
import { createCommandClient } from 'stdb-es/client';
import { createFakeCommand } from 'stdb-es/testing';

type Commands = {
  increment: { counterId: string; by: number };
  reset: { counterId: string };
};

const increment = createFakeCommand<Commands['increment']>();
const commands = createCommandClient<Commands>(
  { increment, reset: createFakeCommand<Commands['reset']>() },
  { newCommandId: () => 'cmd-1' },
);

const envelope = await commands.sendNew('increment', { counterId: 'counter-1', by: 1 });

expect(envelope).toEqual({ counterId: 'counter-1', by: 1, commandId: 'cmd-1' });
expect(increment.lastCall).toEqual(envelope);
expect(JSON.stringify(increment.lastCall)).not.toContain('streamId');
expect(JSON.stringify(increment.lastCall)).not.toContain('event');
expect(JSON.stringify(increment.lastCall)).not.toContain('expectedVersion');
```

For a timeout-then-success retry, prepare the envelope first and send it twice. `sendNew` returns the
envelope only after a successful dispatch, so a call that rejects does not hand one back:

```ts
const timeout = createFakeCommand<Commands['increment']>({
  error: new Error('network timeout'),
});
const client = createCommandClient<Commands>({
  increment: timeout,
  reset: createFakeCommand<Commands['reset']>(),
});
const envelope = client.prepare('increment', { counterId: 'counter-1', by: 2 }, {
  commandId: 'retry-1',
});

timeout.nextResult(undefined); // one successful reply after the configured default error

await expect(client.send('increment', envelope)).rejects.toThrow('network timeout');
await expect(client.send('increment', envelope)).resolves.toBeUndefined();

expect(timeout.calls).toHaveLength(2);
expect(timeout.calls[0]).toEqual(timeout.calls[1]);
```

Queued replies are consumed in order; after the queue is empty the configured default applies.
`clear()` clears recorded calls without clearing queued replies. No append fake is shipped; clients
have no append binding. See
[§18 of the M15 change record](spec-changes/frontend-write-boundary-commands-r9-m15.md#18-frontend-write-boundary-commands-instead-of-append-r9--m15).

---

## 6. Contract tests

A module test checks one behavior. A contract suite checks the event-store invariants the app relies
on: append/read ordering, gapless positions, concurrency, dedupe, cache/replay agreement, structural
integrity, time travel, projection rebuild parity, view output, and the optional command boundary.

```ts
import { streamVersion } from 'stdb-es/server';
import { runEventStoreContractTests } from 'stdb-es/testing';
import { counterStreamId, increment, serverAppend, spacetimedb } from '../../index.js';

runEventStoreContractTests({
  name: 'Counter contract',
  spacetimedb,
  moduleExports: { increment },
  append: (ctx, args) => serverAppend(ctx, args),
  streams: [/* one entry per aggregate kind */],
  commands: {
    name: 'increment',
    command: (id, commandId) => ({ counterId: id, by: 1, commandId }),
    authorize: (ctx, id) => {
      ctx.db.counterOwner.insert({ streamId: counterStreamId(id), owner: ctx.sender });
    },
    version: (ctx, id) => streamVersion(ctx, counterStreamId(id)),
  },
  projections: {/* optional */},
  views: [/* optional */],
});
```

Here `counterStreamId(id)` is the app's helper for the id its command reducer derives. The `append`
seam seeds store invariants on the server; `commands` exercises the client-facing boundary through
the real reducer. The command cases check one append per `commandId`, replay on a repeat with the same
key, and rejection when `authorize` has not seeded an ownership row for the caller.

See the [API reference](API.md#43-contract-suite) for every option, or the
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
| Composite range scans return no rows or throw `Cannot convert ... to a BigInt` | Use `createModuleTest`, or wrap the context with `withIndexRanges(ctx)` in your own helper. This is a module test harness bug, not a host bug. |
| Reducer tests fail with a missing datastore error | Add `spacetimedbModuleTestPlugin()` to `vitest.config.ts`. |
| A stale-version test returns `replayed` | You reused committed event ids in the server-side fixture. Generate fresh ids with a new prefix. |
| A command replay appears to do nothing | That is correct when `commandId` is repeated. Use a fresh command id for a new intent. |
| A command fake has no `lastCall` | Bind `createFakeCommand` to the generated command reducer; the testing entry no longer ships an append fake. |
| `vitest` import fails | Install the required peer (`>=3 <4`) as a dev dependency for this workspace. |
| Tests leak state between cases | Create the `createModuleTest` instance inside each `it`. |

---

## 8. What is not here

Server lifecycle tests — publish, call reducers over the network, owner/anonymous SQL, and live
subscription convergence — belong to the Node-only `stdb-es/testing/integration` entry. They need a
real server and are deliberately separate from this offline kit. See the
[Integration testing guide](integration%20testing.md) for the shipped M7 lifecycle. The current
`npm run smoke` is a maintainer-only live check, not a consumer test API.
