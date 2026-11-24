# Phaser counter

A small full-stack example set: one SpacetimeDB module plus one Phaser client using `stdb-es` for the
event log, a state cache, a live anonymous read model, and backend-owned command writes.

This mirrors [`react-counter`](../react-counter/README.md). The module, generated bindings, command
client, and test kits are shared framework-neutral code; only the browser presentation and lifecycle
wiring are Phaser-specific. Both examples call the same `stdb-es` API and the same command reducers.

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
npm run example:phaser-counter:start
```

That command:

1. builds the `stdb-es` package;
2. builds the module in `spacetimedb/`;
3. generates TypeScript client bindings into `web/src/generated`;
4. typechecks both subprojects;
5. publishes to `stdb-es-counter-with-phaser` on the local server, preserving existing data;
6. starts Vite on `http://127.0.0.1:5174`.

`npm run example:phaser-counter:publish` performs the same build/generate/typecheck/publish steps
without starting Vite. Use `npm run example:phaser-counter:publish-clean` only when you deliberately
want to reset the scratch database with `--delete-data=always`.

The module subproject also exposes a non-destructive `publish` script and a separate `publish:clean`
script; run them with `npm --prefix examples/phaser-counter/spacetimedb run <script>`.

After the first publish, you can start only the web app with:

```bash
npm --prefix examples/phaser-counter/web run dev
```

Environment overrides for the web app: `VITE_STDB_URI` (default `ws://localhost:3000`) and
`VITE_STDB_DATABASE` (default `stdb-es-counter-with-phaser`).

## Test it offline

No server or database is needed for the unit tests; the committed generated bindings satisfy the web
type imports:

```bash
npm run example:phaser-counter:test
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
npm run example:phaser-counter:test:integration
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
[integration testing guide](../../docs/integration%20testing.md) for the full API.

## Lifecycle

The framework-neutral package never owns a frontend lifecycle. This example keeps the boundaries
explicit in `web/src/connection.ts` and `web/src/CounterScene.ts`:

1. `connect()` builds the `DbConnection` and registers row callbacks.
2. `subscribeToSummary()` starts the `counter_summary` subscription when the connection is ready.
3. `unsubscribeFromSummary()` calls `SubscriptionHandle.unsubscribe()` on disconnect.
4. `disconnect()` removes row callbacks and calls `DbConnection.disconnect()` when the scene shuts
   down or the page unloads.

The scene subscribes to plain status/snapshot callbacks, so no React hooks, providers, or DOM helpers
from `stdb-es` are involved.

## What it demonstrates

- Backend-owned writes: Phaser calls generated `increment`, `decrement`, and `reset` reducers with
  intent only; the module derives `streamId`, event id, event type, payload, and expected version.
- Ownership: the first caller to use a counter owns it; later commands from another `ctx.sender` fail
  before any append.
- Idempotency: `commandId` produces a deterministic event id, so a retry is a replay rather than a
  duplicate increment.
- Command payload types imported from `web/src/generated/types/reducers.ts`; the web app does not
  redeclare them.
- A module-owned state cache that replays the log when its row is missing.
- An anonymous materialized view subscribed with `tables.counterSummary` and read from the client
  cache; Phaser only renders the rows it is given.
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
phaser-counter/
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
      main.ts                        # Phaser.Game wiring
      connection.ts                  # connect / subscribe / unsubscribe / disconnect
      counter-client.ts              # intent-only command dispatcher
      CounterScene.ts                # rendering and scene input
      domains/counter/
        constants.ts                 # mirrors module constants
        ids.ts
        registry.ts                  # read-side event decoder
        api.ts                       # generated commands -> command client
        api.test.ts                  # createFakeCommand + command ids
      generated/                     # regenerated by the publish script
```

## Out of scope

No authentication provider, no parameterized views in the UI, no cross-aggregate workflow, no schema
evolution, and no async projection pump. The counter uses a simple first-writer ownership row;
production apps should derive ownership from their authenticated identity provider. The parameterized
audit view is exercised by the integration suite, not by the Phaser screen.
