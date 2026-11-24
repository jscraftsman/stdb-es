# Integration testing guide

`stdb-es/testing/integration` is the M7 consumer kit for tests that need a **real** SpacetimeDB
server. It creates a disposable database, publishes your module, calls reducers, runs owner and
anonymous SQL, opens live subscriptions, and tears everything down in one lifecycle.

It is **Node/CLI-only**. It is deliberately a separate export so `.` and `stdb-es/client` remain
framework-neutral and free of Node-only modules. Frontend code uses the generated connection plus
`stdb-es/client`; only the Node test process imports this kit. For offline module/client tests, use the
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
`spacetime start --in-memory --non-interactive` on a free port with a unique temporary `--data-dir`,
waits for `/v1/health`, publishes, and stops the server in `dispose()`. The isolated data directory
gives the server its own `spacetime.pid` lock, so an existing local server (for example one already
running on port 3000 in CI) cannot block startup. The directory is removed during teardown.

```ts
// integration/counter.test.ts
import { afterEach, expect, it } from 'vitest';
import { createIntegrationEnv, type IntegrationEnv } from 'stdb-es/testing/integration';

let env: IntegrationEnv;

afterEach(async () => {
  await env?.dispose();
});

it('calls a command reducer and exposes the new state through the public view', async () => {
  env = await createIntegrationEnv({
    modulePath: 'spacetimedb',
  });

  // App-specific setup: the caller owns this counter.
  await env.call('claim_counter', ['counter-1', 'claim-1']);
  // The client sends intent only; the module derives and appends the event.
  await env.call('increment', ['counter-1', 'it-1', 1]);

  const events = await env.sql('SELECT * FROM es_event');
  expect(events.rows).toHaveLength(1);

  const summary = await env.sql('SELECT * FROM counter_summary', { anonymous: true });
  expect(summary.rows).toHaveLength(1);
  expect(summary.rows[0]).toMatchObject({ version: 1, value: 1 });
});
```

Each positional reducer argument is serialized as one CLI token. A command such as
`increment(counter_id, command_id, by)` is therefore three tokens. The module, not the test, decides
the stream id, event id, event type, payload, and expected version. Never call a generic
`append_events` reducer from a client-facing path; see the backend-owned command contract in the
[M15 change record](spec-changes/frontend-write-boundary-commands-r9-m15.md#183-command-payload-contract).

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
| `keepDatabase` | `false` when publishing, `true` when attaching | Leave the database in place during `dispose()`. An explicit value always wins. |
| `keepServer` | `false` | Leave an owned local server running during `dispose()`. |

With `publish: false`, the kit assumes the database was created elsewhere and keeps it during
`dispose()` unless you explicitly pass `keepDatabase: false`.

`integrationDatabase(prefix?)` is exported for generating additional valid names, for example when
one test needs two environments.

## 5. Environment API

| Member | Purpose |
| --- | --- |
| `env.server` | URL or CLI nickname used for CLI calls (WS URLs are normalized to HTTP). |
| `env.database` | Database name used by the environment. |
| `env.modulePath` | Module path passed to `spacetime publish -p` (relative to `cwd` when relative). |
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

await env.call('increment', ['counter-1', 'it-2', 1]);

await client.waitFor((c) =>
  c.rows('counter_summary').some((row) => row.stream_id === 'counter-1' && row.value === 2),
);

expect(client.tables()).toContain('counter_summary');
await client.close();
```

`client.rows(table)` returns a snapshot. Inserts, deletes, and row updates are applied as subscription
updates arrive; always assert through `waitFor` rather than sleeping.

For parameterized views, build the query with `viewQuery` and `sqlLiteral` from the framework-neutral
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
uses the database owner identity unless you pass `{ anonymous: true }`. Command reducers use
`ctx.sender`, so finish owner setup with the saved CLI identity, then use anonymous calls to assert
that a non-owner is rejected:

```ts
await Promise.all([
  env.call('claim_counter', ['alice', 'claim-alice']),
  env.call('claim_counter', ['bob', 'claim-bob']),
]);
await Promise.all([
  env.call('increment', ['alice', 'cmd-alice', 1]),
  env.call('increment', ['bob', 'cmd-bob', 2]),
]);

await expect(
  env.call('increment', ['alice', 'cmd-intruder', 1], { anonymous: true }),
).rejects.toThrow();

const rows = (await env.sql('SELECT stream_id, created_by FROM es_event')).rows;
expect(rows).toHaveLength(2);
```

The module chooses each stream's expected version, so same-stream races are resolved there. A retry
of the same `commandId` is an idempotent replay: the module derives the same event id and
`appendToStream` writes nothing twice. See
[API reference](API.md#41-module-and-client-helpers) for offline error helpers.

## 8. Teardown and failures

Always use `try`/`finally` or an `afterEach` hook. `dispose()`:

1. closes every client created by `connect()` (terminating their subscription processes);
2. deletes the disposable database, ignoring failures because an in-memory local server may already
   be gone — unless `keepDatabase` is set, which is the default for `publish: false`;
3. stops the spawned server process tree in owned `'local'` mode and removes its temporary data
   directory.

In external URL mode, steps 2–3 do not stop the shared server. An attached environment with
`publish: false` keeps its database by default, so it never deletes a database created elsewhere.

Use `keepServer: true` only while debugging. Do not leave a local server running in CI. To delete an
attached database, pass `keepDatabase: false` explicitly.

## 9. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `spacetime publish failed` | Install CLI `2.15.0`, check `modulePath`, and confirm the module builds outside the kit. |
| Readiness timeout in local mode | Another process owns the chosen `port`, or `spacetime start` cannot launch its standalone binary. Omit `port` to get a free one. |
| `Cannot read properties of undefined` in a subscription test | The table/view name in `client.rows(...)` must match the key emitted by the SQL subscription. |
| Subscription wait times out | Check the exact query, whether the view is public, and whether the expected event was appended after the subscription started. Increase `timeoutMs`. |
| Anonymous SQL cannot see a table | Private tables are owner-only. Query the app's public view with `{ anonymous: true }`. |
| Repeating a command seems to do nothing | That is the intended idempotent replay: the module derives the event id from `commandId`. Use a fresh command id for a new intent. |
| Tests leak state between cases | Create one environment per test and dispose it in `finally`/`afterEach`. |
| Frontend bundle fails to import the kit | Correct: import from `stdb-es/testing/integration` only in Node tests. Keep client code on `stdb-es/client`. |

## 10. Boundary

This kit covers real-server lifecycle, network reducers, SQL, and subscriptions. It does not replace:

- the offline [Unit testing guide](unit%20testing.md) for command reducers, aggregates, and fake commands;
- the [Usage guide](usage-guide.md#36-integration-tests) for library-level smoke recipes;
- the maintainer `npm run smoke:integration` script, which dogfoods this kit in the repository CI
  gate, and the separate `npm run smoke` publish smoke that checks the React counter module directly;
- the runnable counter examples, whose
  [`react-counter/integration/`](../examples/react-counter/integration/counter.integration.test.ts)
  and [`phaser-counter/integration/`](../examples/phaser-counter/integration/counter.integration.test.ts)
  projects show consumers using `createIntegrationEnv` with app-owned constants; run them with
  `npm run example:react-counter:test:integration` and
  `npm run example:phaser-counter:test:integration`.

M9–M13 example sets remain out of scope. This guide documents the shipped M7 tool only.
