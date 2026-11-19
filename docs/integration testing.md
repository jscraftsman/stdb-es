# Integration testing guide

`stdb-es/testing/integration` is the M7 consumer kit for tests that need a **real** SpacetimeDB
server. It creates a disposable database, publishes your module, calls reducers, runs owner and
anonymous SQL, opens live subscriptions, and tears everything down in one lifecycle.

It is **Node-only**. It is deliberately a separate export so `stdb-es/client` and `stdb-es/testing`
remain browser-safe. For offline module/client tests, use the
[Unit testing guide](unit%20testing.md) instead.

## 1. Install and prerequisites

```bash
npm install --save-dev stdb-es
```

The kit requires:

- Node 20 or newer.
- The SpacetimeDB CLI `2.15.0` on `PATH` (`spacetime --version`).
- Your module source directory (default: `spacetimedb`) publishable with `spacetime publish`.

No `vitest` dependency is required. The kit works with Vitest, Node's built-in test runner, or a
plain script.

> The kit publishes to a disposable database. Treat `database` as throwaway data and never point it
> at a database whose contents you need to keep.

## 2. One test, local server

With the default `server: 'local'`, the kit spawns
`spacetime start --in-memory --non-interactive` on a free port, waits for `/v1/health`, publishes,
and stops the server in `dispose()`.

```ts
// integration/counter.test.ts
import { afterEach, expect, it } from 'vitest';
import { createIntegrationEnv, type IntegrationEnv } from 'stdb-es/testing/integration';

let env: IntegrationEnv;

afterEach(async () => {
  await env?.dispose();
});

it('appends an event and exposes it through the public view', async () => {
  env = await createIntegrationEnv({
    modulePath: 'spacetimedb',
  });

  await env.call('append_events', [
    'counter-1',
    'Counter',
    0,
    [
      {
        event_id: 'it-1',
        event_type: 'Incremented',
        data: JSON.stringify({ kind: 'Incremented', by: 1 }),
        metadata: null,
      },
    ],
    null,
  ]);

  const events = await env.sql('SELECT * FROM es_event');
  expect(events.rows).toHaveLength(1);

  const summary = await env.sql('SELECT * FROM counter_summary', { anonymous: true });
  expect(summary.rows).toEqual([{ stream_id: 'counter-1', version: 1, value: 1 }]);
});
```

Each positional reducer argument is serialized as one CLI token. Arrays and objects become JSON
tokens, so the four arguments above match:
`append_events(stream_id, stream_type, expected_version, events, metadata)`.

## 3. Connecting to an external server

Pass an HTTP or WebSocket URL to reuse a server you already run. The kit never stops a process it
did not start; `dispose()` only closes its clients and deletes its database.

```ts
const env = await createIntegrationEnv({
  server: process.env.STDB_SERVER_URL ?? 'http://127.0.0.1:3000',
  modulePath: 'spacetimedb',
  cwd: process.cwd(),
});
try {
  // ...
} finally {
  await env.dispose();
}
```

You may also pass a CLI server nickname such as `'local'`. Only the exact value `'local'` starts an
owned server; any other nickname is assumed to be external.

## 4. Options

`createIntegrationEnv(options?)` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `server` | `'local'` | `'local'` spawns an owned in-memory server; a URL or CLI nickname reuses an existing server. |
| `database` | generated `stdb-es-test-<8 hex>` | Disposable database name. Must match the CLI's lowercase-dash pattern. |
| `modulePath` | `'spacetimedb'` | Module project directory passed to `spacetime publish -p`. |
| `cwd` | `process.cwd()` | Working directory for all CLI calls. |
| `publish` | `true` | Set to `false` to attach to an already published database. |
| `deleteData` | `true` | Publishes with `--delete-data=always`. Safe for a disposable database. |
| `port` | free port | Listen port in owned `'local'` mode. |
| `timeoutMs` | `120000` | Server readiness and default `waitFor` timeout. |
| `keepDatabase` | `false` | Leave the database in place during `dispose()`. |
| `keepServer` | `false` | Leave an owned local server running during `dispose()`. |

`integrationDatabase(prefix?)` is exported for generating additional valid names, for example when
one test needs two environments.

## 5. Environment API

| Member | Purpose |
| --- | --- |
| `env.server` | Resolved HTTP URL (WS URLs are normalized for CLI calls). |
| `env.database` | Database name used by the environment. |
| `env.modulePath` | Resolved module path. |
| `env.call(name, args?, options?)` | Calls a reducer or procedure. Pass an array of positional CLI arguments. `options.anonymous` uses a throwaway identity. |
| `env.sql(query, options?)` | Runs SQL as the owner, or anonymously with `{ anonymous: true }`. Returns `{ rows, statements }` with column-keyed rows. |
| `env.connect(options?)` | Starts a live subscription client. Options: `anonymous`, `queries`, `printInitialUpdate`, `timeoutMs`. |
| `env.waitFor(predicate, options?)` | Polls any condition until it succeeds or times out. Options: `timeoutMs`, `intervalMs`, `description`. |
| `env.dispose()` | Closes clients, deletes the database, then stops an owned server. Idempotent. |

SQL results preserve the CLI JSON shape for complex values (identities, options, timestamps), while
column names become object keys:

```ts
const result = await env.sql('SELECT stream_id, version FROM es_stream');
result.rows; // [{ stream_id: 'counter-1', version: 1 }]
result.statements[0]?.columns; // ['stream_id', 'version']
```

## 6. Subscriptions and convergence

`env.connect()` wraps `spacetime subscribe`, so the kit needs no generated client bindings. Each
query starts one CLI process and feeds a client-side row cache keyed by the table/view name in the
subscription result.

```ts
const client = await env.connect({
  anonymous: true,
  queries: ['SELECT * FROM counter_summary'],
});

await client.waitFor((c) => c.rows('counter_summary').length === 1, {
  description: 'initial counter summary',
});

await env.call(/* append another event */);

await client.waitFor((c) =>
  c.rows('counter_summary').some((row) => row.stream_id === 'counter-1' && row.value === 2),
);

expect(client.tables()).toContain('counter_summary');
await client.close();
```

`client.rows(table)` returns a snapshot. Inserts, deletes, and row updates are applied as subscription
updates arrive; always assert through `waitFor` rather than sleeping.

For parameterized views, build the query with `viewQuery` and `sqlLiteral` from the browser-safe
`stdb-es/client` entry:

```ts
import { sqlLiteral, viewQuery } from 'stdb-es/client';

const client = await env.connect({
  anonymous: true,
  queries: [viewQuery('stream_view', [sqlLiteral('counter-1')])],
});
```

`printInitialUpdate` defaults to `true`. Set it to `false` when you only want later deltas.

## 7. Identities and concurrency

Two anonymous CLI calls use distinct throwaway identities. Owner SQL sees all rows; anonymous SQL
uses the database owner identity unless you pass `{ anonymous: true }`. This lets you assert that a
public view is readable while private tables remain owner-only:

```ts
await Promise.all([
  env.call('append_events', ['alice', 'Counter', 0, [eventA], null], { anonymous: true }),
  env.call('append_events', ['bob', 'Counter', 0, [eventB], null], { anonymous: true }),
]);

const rows = (await env.sql('SELECT stream_id, created_by FROM es_event', { anonymous: true })).rows;
expect(rows).toHaveLength(2);
```

Each stream has its own version, so independent writers do not conflict. Use
`ES_ERROR.EXPECTED_VERSION_MISMATCH` assertions for same-stream races; generate fresh event ids for
the retry so dedupe does not turn the stale attempt into a replay. See
[API reference](API.md#41-module-and-client-helpers) for offline error helpers.

## 8. Teardown and failures

Always use `try`/`finally` or an `afterEach` hook. `dispose()`:

1. closes every client created by `connect()` (terminating their subscription processes);
2. deletes the disposable database, ignoring failures because an in-memory local server may already
   be gone;
3. stops the spawned server process tree in owned `'local'` mode.

In external URL mode, step 2 still deletes the database, but the server keeps running.

Use `keepDatabase: true` or `keepServer: true` only while debugging. Do not leave a local server
running in CI.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `spacetime publish failed` | Install CLI `2.15.0`, check `modulePath`, and confirm the module builds outside the kit. |
| Readiness timeout in local mode | Another process owns the chosen `port`, or `spacetime start` cannot launch its standalone binary. Omit `port` to get a free one. |
| `Cannot read properties of undefined` in a subscription test | The table/view name in `client.rows(...)` must match the key emitted by the SQL subscription. |
| Subscription wait times out | Check the exact query, whether the view is public, and whether the expected event was appended after the subscription started. Increase `timeoutMs`. |
| Anonymous SQL cannot see a table | Private tables are owner-only. Query the app's public view with `{ anonymous: true }`. |
| Stale-version test returns `replayed` | Use fresh event ids; dedupe runs before the version check. |
| Tests leak state between cases | Create one environment per test and dispose it in `finally`/`afterEach`. |
| Browser bundle fails to import the kit | Correct: import from `stdb-es/testing/integration` only in Node tests. Keep client code on `stdb-es/client`. |

## 10. Boundary

This kit covers real-server lifecycle, network reducers, SQL, and subscriptions. It does not replace:

- the offline [Unit testing guide](unit%20testing.md) for reducers, aggregates, and fake appends;
- the [Usage guide](usage-guide.md#36-integration-tests) for library-level smoke recipes;
- the maintainer `npm run smoke` and `npm run smoke:integration` scripts, which dogfood this kit in
  the repository CI gate.

M9–M13 example sets remain out of scope. This guide documents the shipped M7 tool only.
