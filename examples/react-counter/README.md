# Counter with frontend

A small full-stack example set: one SpacetimeDB module plus one React client using `stdb-es` for the
event log, a state cache, a live anonymous read model, and backend-owned command writes.

This is the baseline for the planned example sets. It deliberately stays small: one stream, three
event types, one state table, an ownership table, two views, and one screen.

## Prerequisites

- Node.js 20+
- A local SpacetimeDB server already running on `http://127.0.0.1:3000`

If the `local` server nickname is not configured:

```bash
spacetime server add local --url http://localhost:3000
```

## Run it

From the repository root:

```bash
npm install
npm run example:react-counter:start
```

That command:

1. builds the `stdb-es` package;
2. builds the module in `spacetimedb/`;
3. generates TypeScript client bindings into `web/src/generated`;
4. typechecks both subprojects;
5. publishes to `stdb-es-counter-with-frontend` on the local server, preserving existing data;
6. starts Vite on `http://127.0.0.1:5173`.

`npm run example:react-counter:publish` performs the same build/generate/typecheck/publish steps
without starting Vite. Use `npm run example:react-counter:publish-clean` only when you deliberately
want to reset the scratch database with `--delete-data=always`.

The module subproject also exposes a non-destructive `publish` script and a separate `publish:clean`
script; run them with `npm --prefix examples/react-counter/spacetimedb run <script>`.

After the first publish, you can start only the web app with:

```bash
npm --prefix examples/react-counter/web run dev
```

Environment overrides for the web app: `VITE_STDB_URI` (default `ws://localhost:3000`) and
`VITE_STDB_DATABASE` (default `stdb-es-counter-with-frontend`).

## Test it offline

No server or database is needed for the unit tests; the committed generated bindings satisfy the web
type imports:

```bash
npm run example:react-counter:test
```

The root script builds `stdb-es`, then runs two Vitest projects:

- `spacetimedb/` uses `createModuleTest` to call the `increment`, `decrement`, and `reset` command
  reducers, read the log with `readStream`, inspect the anonymous summary view, and assert that a
  repeated `commandId` is an idempotent replay and a different sender is rejected.
- `web/` uses `createFakeCommand` behind `makeCounterCommands` to check that the browser sends only
  intent (`counterId`, optional `by`, and `commandId`), that retries reuse the same envelope, and
  that rejected commands surface an error.

Both projects load `spacetimedbModuleTestPlugin()` in their `vitest.config.ts`: the module needs it
for the in-memory datastore, and the client keeps it so importing the `stdb-es/testing` barrel stays
resolvable in Node. No running server is involved. See the
[unit testing guide](../../docs/unit%20testing.md) for the full API.

## Test it against a server

The example also ships a Node-only integration suite at `integration/`. It uses
`stdb-es/testing/integration` to publish this module to a disposable in-memory database, then exercises
the real command and read paths:

```bash
npm run example:react-counter:test:integration
```

The suite covers:

- `createIntegrationEnv` creating and tearing down a disposable database in one lifecycle;
- generated command reducers driving real writes with app-owned stream ids chosen by the module;
- owner SQL over the private `es_event` table and anonymous SQL over `counter_summary`;
- `commandId` replay and non-owner rejection on a real server;
- live subscription convergence for both the anonymous view and the parameterized `stream_events`
  view built with `viewQuery`;
- a second environment connecting through an explicit server URL without stopping the shared server.

No pre-running server is required: local mode spawns and owns `spacetime start --in-memory
--non-interactive`. The suite is separate from the offline Vitest projects because it needs Node
built-ins and a real server. See the
[integration testing guide](../../docs/integration%20testing.md) for the full API. The repository
root also runs `npm run smoke:integration`, a broader dogfood of the same kit.

## What it demonstrates

- Backend-owned writes: the browser calls generated `increment`, `decrement`, and `reset` reducers
  with intent only; the module derives `streamId`, event id, event type, payload, and expected version.
- Ownership: the first caller to use a counter owns it; later commands from another `ctx.sender` fail
  before any append.
- Idempotency: `commandId` produces a deterministic event id, so a retry is a replay rather than a
  duplicate increment.
- Command payload types imported from `web/src/generated/types/reducers.ts`; the web app does not
  redeclare them.
- A module-owned state cache that replays the log when its row is missing.
- An anonymous materialized view consumed with `useTable(tables.counterSummary)`.
- A public parameterized `stream_events` view built with `makeStreamView` and queried with
  `viewQuery('stream_events', [streamId])`; this demo authorizes every stream, but a real app should
  check ownership in the view's `authorize` callback.
- App-owned constants in `domains/counter/constants.ts` on both module and web sides. Never import
  those files from `stdb-es` itself.
- Offline tests that exercise the real command reducers and the real client command client through
  `stdb-es/testing`, with no server in the loop.
- Integration tests that publish this same module and exercise commands, SQL, and subscriptions
  through `stdb-es/testing/integration`.

## Layout

```text
react-counter/
  integration/
    counter.integration.test.ts       # createIntegrationEnv: publish, command, SQL, subscriptions
    vitest.config.ts                  # Node-only integration project
    tsconfig.json
  spacetimedb/
    vitest.config.ts                  # in-memory module harness plugin
    src/
      index.ts                       # module exports only
      schema.ts                      # esTables + counter_state + counter_owner
      domains/counter/
        constants.ts
        events.ts
        aggregate.ts                 # evolve + replay
        reducers.ts                  # increment / decrement / reset commands
        reducers.test.ts             # createModuleTest + ownership + replay
        views.ts                     # counter_summary + stream_events
  web/
    vitest.config.ts
    src/
      main.tsx                       # SpacetimeDBProvider
      App.tsx                        # connection/readiness status
      domains/counter/
        constants.ts                 # mirrors module constants
        ids.ts
        registry.ts                  # read-side event decoder
        api.ts                       # generated commands -> command client
        api.test.ts                  # createFakeCommand + command ids
        CounterPanel.tsx
      generated/                     # regenerated by the publish script
```

## Out of scope

No authentication provider, no parameterized views in the UI, no cross-aggregate workflow, no schema
evolution, and no async projection pump. The counter uses a simple first-writer ownership row;
production apps should derive ownership from their authenticated identity provider. The parameterized
audit view exists for integration tests; the UI still shows one shared public counter.
