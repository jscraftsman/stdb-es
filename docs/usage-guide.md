# Package Usage Guide

This guide shows how to use `stdb-es` from **SpacetimeDB module app code**, from ordinary **client
code**, in **unit/integration tests**, and in a **simple React frontend**. It describes shipped v1
behavior. Anything marked **planned** is a milestone in
[the design record](event-sourcing-plan.md#15-milestones) and is not available yet.

For the complete signature of every export, see [API.md](API.md). For owner-only SQL inspection, see
[sql-recipes.md](sql-recipes.md).

| Entry point | Use it from | Contents |
| --- | --- | --- |
| `stdb-es` | module or client | Error codes, the `streamId` helper, and wire/protocol types |
| `stdb-es/server` | module only | Tables, append/read helpers, repositories, projections, view factories, doctor helpers |
| `stdb-es/client` | browser or Node client | Event registry, encoding, append client, subscription query helpers |
| `stdb-es/testing` | Vitest tests | Harness shim, wire fixtures, contract suite |

> Never import `stdb-es/server` into browser code. Never import Node-only test tooling into a module
> bundle. The client entry is browser-safe; the planned integration kit has its own Node-only entry.

New to the package? Start with **Part 0** below for a complete from-scratch project. Parts 1–4 then
explain the individual pieces in more depth.

---

## Part 0 — New project workflow: full-stack counter from scratch

This section is a standalone walkthrough. It assumes `stdb-es` is already published on npm, so the
project installs it like any other dependency — there are no `file:` links and no checkout of this
repository. The result is the same shape as
[`examples/sets/counter-with-frontend`](../examples/sets/counter-with-frontend/README.md): one
SpacetimeDB TypeScript module, one generated client, and one small React screen.

### 0.1 Prerequisites

```bash
node --version          # 20 or newer
spacetime --version     # 2.15.x
```

Start a local SpacetimeDB server separately, and make sure the `local` nickname exists:

```bash
spacetime server ping local
spacetime server add local --url http://localhost:3000   # only if the nickname is missing
```

The browser connects over WebSocket to `ws://localhost:3000`; the CLI uses HTTP on port `3000`.

### 0.2 Scaffold the project

```bash
mkdir my-counter
cd my-counter

spacetime init --lang typescript --server-only --non-interactive spacetimedb
npm create vite@latest web -- --template react-ts
```

Replace the generated package files with the following so the two subprojects share one root
install. The `publish` script preserves existing data; use `publish:reset` only when you deliberately
want a scratch reset.

```json
// package.json
{
  "name": "my-counter",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "workspaces": ["spacetimedb", "web"],
  "scripts": {
    "build:module": "spacetime build -p spacetimedb",
    "generate": "spacetime generate --lang typescript --module-path spacetimedb --out-dir web/src/generated",
    "typecheck": "tsc -p spacetimedb/tsconfig.json --noEmit && tsc -p web/tsconfig.json --noEmit",
    "publish": "npm run build:module && npm run generate && npm run typecheck && spacetime publish my-counter -s local -p spacetimedb",
    "publish:reset": "npm run build:module && npm run generate && npm run typecheck && spacetime publish my-counter -s local -p spacetimedb --delete-data=always -y",
    "dev": "npm run publish && npm --prefix web run dev"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

```json
// spacetimedb/package.json
{
  "name": "my-counter-module",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "stdb-es": "latest"
  },
  "devDependencies": {
    "spacetimedb": "2.15.0",
    "typescript": "^5.7.0"
  }
}
```

```json
// web/package.json
{
  "name": "my-counter-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "spacetimedb": "2.15.0",
    "stdb-es": "latest"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.7.0",
    "vite": "^7.0.0"
  }
}
```

`latest` keeps this walkthrough focused on the published npm package. Equivalently, run
`npm install stdb-es@latest` inside `spacetimedb/` and again inside `web/`; the root `npm install`
below performs both through npm workspaces. Pin the exact version npm resolves in an application you
intend to reproduce. `stdb-es` declares `spacetimedb >=2.15 <3` as a peer; both subprojects install
`2.15.0` explicitly because generated bindings are version-specific.

Add the config files:

```json
// spacetime.json
{
  "module-path": "./spacetimedb",
  "server": "local"
}
```

```json
// spacetimedb/tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "target": "ESNext",
    "lib": ["ES2021", "dom"],
    "module": "ESNext",
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["./**/*"]
}
```

```json
// web/tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

```ts
// web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
```

```html
<!-- web/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My counter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Install everything from the project root:

```bash
npm install
npm ls stdb-es spacetimedb
```

The final layout is:

```text
my-counter/
  package.json
  spacetime.json
  spacetimedb/
    package.json
    tsconfig.json
    src/
      index.ts
      schema.ts
      domains/counter/
        constants.ts
        events.ts
        aggregate.ts
        reducers.ts
        views.ts
  web/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx
      config.ts
      styles.css
      generated/                 # produced by `npm run generate`
      domains/counter/
        constants.ts
        ids.ts
        registry.ts
        api.ts
        CounterPanel.tsx
```

### 0.3 Module: app-owned constants and events

All counter literals live in the app, never in `stdb-es`. The module and web copies mirror each other;
this simple project keeps them in two files rather than adding a shared package.

```ts
// spacetimedb/src/domains/counter/constants.ts
/** App-owned literals for the counter domain. Mirrored in `web/src/domains/counter`. */
export const STREAM_TYPES_COUNTER = {
  Counter: 'Counter',
} as const;

export const STREAM_PREFIXES_COUNTER = {
  counter: 'counter',
} as const;

export const EVENT_TYPES_COUNTER = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;

export const TABLES_COUNTER = {
  state: 'counter_state',
  summary: 'counter_summary',
} as const;
```

```ts
// spacetimedb/src/domains/counter/events.ts
import { EVENT_TYPES_COUNTER } from './constants.js';

/** Stored payloads; the `kind` literal is also the persisted event-type string. */
export type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };
```

### 0.4 Module: schema, fold, append reducer, and view

`esTables` is private library infrastructure. `counter_state` is the app's private state cache, and
`counter_summary` is the public materialized read model the UI subscribes to.

```ts
// spacetimedb/src/schema.ts
import { schema, t, table } from 'spacetimedb/server';
import { esTables, type CtxOf } from 'stdb-es/server';
import { TABLES_COUNTER } from './domains/counter/constants.js';

/** Private, app-owned state cache. `version` is the guard used by replay-on-miss. */
export const counterState = table(
  { name: TABLES_COUNTER.state },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState });
export type Context = CtxOf<typeof spacetimedb>;

export default spacetimedb;
```

```ts
// spacetimedb/src/domains/counter/aggregate.ts
import { readStream } from 'stdb-es/server';
import type { Context } from '../../schema.js';
import { EVENT_TYPES_COUNTER } from './constants.js';
import type { CounterEvent } from './events.js';

/** The single fold used by both incremental updates and full replay. */
export function evolve(value: bigint, event: CounterEvent): bigint {
  switch (event.kind) {
    case EVENT_TYPES_COUNTER.Incremented:
      return value + BigInt(event.by);
    case EVENT_TYPES_COUNTER.Decremented:
      return value - BigInt(event.by);
    case EVENT_TYPES_COUNTER.Reset:
      return 0n;
  }
}

/** A missing or stale cache row must be rebuilt from the log, never read as zero. */
export function replayValue(ctx: Context, streamId: string): bigint {
  let value = 0n;
  for (const row of readStream(ctx, streamId)) {
    value = evolve(value, JSON.parse(row.data) as CounterEvent);
  }
  return value;
}
```

```ts
// spacetimedb/src/domains/counter/reducers.ts
import { makeAppendReducer } from 'stdb-es/server';
import { spacetimedb } from '../../schema.js';
import { evolve, replayValue } from './aggregate.js';
import { EVENT_TYPES_COUNTER } from './constants.js';
import type { CounterEvent } from './events.js';

/** Generic client-facing write path; the client supplies encoded events and ids. */
export const appendEvents = makeAppendReducer(spacetimedb, {
  eventTypes: [
    EVENT_TYPES_COUNTER.Incremented,
    EVENT_TYPES_COUNTER.Decremented,
    EVENT_TYPES_COUNTER.Reset,
  ],

  onAppended: (ctx, result) => {
    const streamId = result.rows[0]?.streamId;
    if (!streamId) return;

    const current = ctx.db.counterState.streamId.find(streamId);
    if (!current) {
      // `onAppended` sees the new rows, so this replay already includes them.
      const value = replayValue(ctx, streamId);
      ctx.db.counterState.insert({ streamId, version: result.version, value });
      return;
    }

    let value = current.value;
    for (const row of result.rows) {
      value = evolve(value, JSON.parse(row.data) as CounterEvent);
    }
    ctx.db.counterState.streamId.update({ streamId, version: result.version, value });
  },
});
```

The hook runs in the same transaction as the append, and deduplicated retries skip it. A missing
cache row triggers a replay instead of assuming a zero counter.

```ts
// spacetimedb/src/domains/counter/views.ts
import { t } from 'spacetimedb/server';
import { counterState, spacetimedb } from '../../schema.js';
import { TABLES_COUNTER } from './constants.js';

/** World-readable, materialized read model for the simple React UI. */
export const counterSummary = spacetimedb.anonymousView(
  { name: TABLES_COUNTER.summary, public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);
```

A module entry point may export only SpacetimeDB exports. Re-exporting tables, types, or other
non-export values makes schema inspection fail.

```ts
// spacetimedb/src/index.ts
export { default } from './schema.js';
export { appendEvents } from './domains/counter/reducers.js';
export { counterSummary } from './domains/counter/views.js';
```

### 0.5 Build, generate bindings, and publish

Run these from the project root:

```bash
npm install
npm run typecheck
npm run build:module
npm run generate
npm run publish
```

Or use the one-command script:

```bash
npm run dev       # publish, then start Vite on http://127.0.0.1:5173
```

What each step does:

| Command | Effect |
| --- | --- |
| `npm run build:module` | Bundles the TypeScript module for SpacetimeDB. |
| `npm run generate` | Writes client bindings into `web/src/generated`. Never edit that folder. |
| `npm run typecheck` | Type-checks module and web code, including the generated bindings. |
| `npm run publish` | Publishes/updates `my-counter` on `local` **without** deleting data. |
| `npm run publish:reset` | Destructive scratch reset using `--delete-data=always -y`. |

`spacetime build` may print `tsc not found in node_modules` because npm hoists TypeScript to the
root workspace. The bundle still succeeds; `npm run typecheck` is the explicit type check. Regenerate
bindings after changing any schema, reducer, or view.

### 0.6 Web: config, constants, id, registry, and adapter

```ts
// web/src/config.ts
export const SPACETIMEDB_URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const DATABASE_NAME =
  import.meta.env.VITE_STDB_DATABASE ?? 'my-counter';

const TOKEN_KEY = `${SPACETIMEDB_URI}/${DATABASE_NAME}/auth_token`;

export function readToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function writeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
```

```ts
// web/src/domains/counter/constants.ts
/** Mirrors `spacetimedb/src/domains/counter/constants.ts`. No server imports. */
export const STREAM_TYPES_COUNTER = {
  Counter: 'Counter',
} as const;

export const STREAM_PREFIXES_COUNTER = {
  counter: 'counter',
} as const;

export const EVENT_TYPES_COUNTER = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;

export const TABLES_COUNTER = {
  state: 'counter_state',
  summary: 'counter_summary',
} as const;
```

```ts
// web/src/domains/counter/ids.ts
import { streamId } from 'stdb-es';
import { STREAM_PREFIXES_COUNTER } from './constants.js';

/** The single public counter used by this UI. */
export const COUNTER_STREAM_ID = streamId(STREAM_PREFIXES_COUNTER.counter, '1');
```

`streamId` only formats and validates. It does not grant ownership. This demo deliberately uses one
public counter; a real multi-user app would derive or authorize the id in the module.

```ts
// web/src/domains/counter/registry.ts
import { createEventRegistry, type EventDefinition } from 'stdb-es/client';
import { EVENT_TYPES_COUNTER } from './constants.js';

export type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

/** Identity codec: the domain object is already the persisted JSON payload. */
const definitions: Record<string, EventDefinition<CounterEvent, any>> = {
  [EVENT_TYPES_COUNTER.Incremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Incremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Decremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Decremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Reset]: {
    encode: (event) => event,
    decode: () => ({ kind: EVENT_TYPES_COUNTER.Reset }),
  },
};

export const counterRegistry = createEventRegistry<CounterEvent>({
  typeOf: (event) => EVENT_TYPES_COUNTER[event.kind],
  events: definitions,
});
```

The identity `encode` is intentional: these events are already plain JSON, and the stored `kind`
matches the registry key. Use an explicit codec when a domain type contains `bigint`, `Date`, or
UI-only fields, or when you need an `upgrade` for historical payloads.

```ts
// web/src/domains/counter/api.ts
import { createEventStoreClient } from 'stdb-es/client';
import type { AppendEventsParams } from '../../generated/types/reducers.js';
import { counterRegistry } from './registry.js';

type EncodedEvents = AppendEventsParams['events'];

/** The typed `useReducer(reducers.appendEvents)` call. */
export type AppendCall = (params: AppendEventsParams) => Promise<void>;

export function makeCounterStore(callAppend: AppendCall) {
  return createEventStoreClient({
    registry: counterRegistry,
    // The client library produces one args object, which matches generated reducers.
    append: (args) =>
      callAppend({
        streamId: args.streamId,
        streamType: args.streamType,
        expectedVersion: args.expectedVersion,
        events: args.events as EncodedEvents,
        metadata: args.metadata ?? undefined,
      }),
  });
}
```

Generated TypeScript reducers take **one params object**, not positional arguments. The
`stdb-es/client` callback also receives one `AppendCallArgs` object; this adapter maps the two types
without changing their semantics.

### 0.7 Web: provider, screen, and panel

```tsx
// web/src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import App from './App.js';
import { DATABASE_NAME, SPACETIMEDB_URI, readToken, writeToken } from './config.js';
import { DbConnection } from './generated/index.js';
import './styles.css';

const connectionBuilder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(DATABASE_NAME)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_connection, _identity, token) => writeToken(token));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </React.StrictMode>,
);
```

```tsx
// web/src/App.tsx
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './generated/index.js';
import { CounterPanel } from './domains/counter/CounterPanel.js';
import { TABLES_COUNTER } from './domains/counter/constants.js';

export default function App() {
  const { isActive } = useSpacetimeDB();
  const [rows, ready] = useTable(tables.counterSummary);

  return (
    <main>
      <header>
        <h1>My counter</h1>
        <p>
          {isActive ? 'Connected' : 'Connecting…'} ·{' '}
          {ready ? `${TABLES_COUNTER.summary} ready` : 'Waiting for the view'}
        </p>
      </header>
      <CounterPanel rows={rows} ready={ready} />
    </main>
  );
}
```

```tsx
// web/src/domains/counter/CounterPanel.tsx
import { useMemo, useState } from 'react';
import { useReducer as useSpacetimeReducer } from 'spacetimedb/react';
import { ES_ERROR, NO_STREAM, esErrorCode } from 'stdb-es';
import { reducers } from '../../generated/index.js';
import { makeCounterStore } from './api.js';
import { EVENT_TYPES_COUNTER, STREAM_TYPES_COUNTER } from './constants.js';
import { COUNTER_STREAM_ID } from './ids.js';
import type { CounterEvent } from './registry.js';

type CounterRow = { streamId: string; version: number; value: bigint };

type Props = {
  rows: readonly CounterRow[];
  ready: boolean;
};

export function CounterPanel({ rows, ready }: Props) {
  const callAppend = useSpacetimeReducer(reducers.appendEvents);
  const store = useMemo(() => makeCounterStore(callAppend), [callAppend]);

  const [by, setBy] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const row = rows.find((candidate) => candidate.streamId === COUNTER_STREAM_ID);
  const version = row?.version ?? NO_STREAM;

  async function append(events: CounterEvent[]) {
    setBusy(true);
    setMessage(null);
    try {
      await store.append(COUNTER_STREAM_ID, STREAM_TYPES_COUNTER.Counter, events, {
        expectedVersion: version,
      });
      setMessage('Committed. The view will refresh when the subscription applies.');
    } catch (cause) {
      setMessage(
        esErrorCode(cause) === ES_ERROR.EXPECTED_VERSION_MISMATCH
          ? 'Someone updated the counter first. The view will refresh.'
          : 'Could not append the event.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Counter</h2>
      <p className="value" aria-live="polite">
        {ready ? String(row?.value ?? 0n) : 'Loading…'}
      </p>
      <p className="meta">stream {COUNTER_STREAM_ID} · version {row?.version ?? 0}</p>

      <label>
        Amount
        <input
          type="number"
          value={by}
          onChange={(event) => setBy(Number(event.target.value))}
        />
      </label>

      <div className="actions">
        <button
          disabled={busy}
          onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Incremented, by }])}
        >
          Increment
        </button>
        <button
          disabled={busy}
          onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Decremented, by }])}
        >
          Decrement
        </button>
        <button disabled={busy} onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Reset }])}>
          Reset
        </button>
      </div>

      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
```

```css
/* web/src/styles.css */
:root {
  font-family: system-ui, sans-serif;
  color: #18212f;
  background: #f5f7fa;
}

body {
  margin: 0;
}

main {
  max-width: 32rem;
  margin: 4rem auto;
  padding: 0 1rem;
}

header p {
  color: #52606d;
}

.panel {
  padding: 1.5rem;
  border: 1px solid #d7dfe8;
  border-radius: 12px;
  background: white;
}

.value {
  margin: 0;
  font-size: 3rem;
  font-weight: 700;
}

.meta {
  margin-top: 0.25rem;
  color: #52606d;
  font-size: 0.875rem;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 1.25rem;
}

input {
  padding: 0.5rem;
  border: 1px solid #bcc6d0;
  border-radius: 6px;
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}

button {
  padding: 0.5rem 0.75rem;
  border: 0;
  border-radius: 6px;
  background: #2563eb;
  color: white;
  cursor: pointer;
  font: inherit;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}
```

The panel takes the expected version from the subscribed summary row. On the first append the row is
absent, so `NO_STREAM` makes the append create-only. A failed version check is handled explicitly;
the next subscription update supplies the correct version.

### 0.8 Run and verify

```bash
npm run dev
```

Open `http://127.0.0.1:5173`, wait for `Connected` and `counter_summary ready`, then use the three
buttons. The value shown is the materialized `counter_state` row exposed by `counter_summary`, not a
local React calculation.

You can also inspect the read model directly:

```bash
spacetime sql my-counter 'SELECT * FROM counter_summary' -s local --format json
```

A successful append returns a row like:

```json
[["counter-1", 1, 5]]
```

The columns are `stream_id`, `version`, and `value`. `es_stream`, `es_event`, and `es_head` are
private and are not available to the browser.

If you need a clean scratch database:

```bash
npm run publish:reset
```

That command deletes all data in `my-counter`. The normal `npm run publish` does not.

### 0.9 What this workflow establishes

- `stdb-es` is consumed from npm by two independent workspace packages.
- App-owned literals are mirrored in module and web `constants.ts` files; the core package exports
  none of them.
- The module owns the event log, the version-guarded state cache, the generic append reducer, and the
  public read model.
- The client encodes plain JSON events with stable ids, uses the view's version as the optimistic
  concurrency token, and calls the generated reducer with one params object.
- The React UI reads only the public view and observes commits through the subscription.

For multi-domain apps, repeat the `domains/<name>` pattern on both sides and compose the panels under
one provider. See [Part 1](#part-1--module-app-code) and [Part 4](#part-4--simple-react-frontend) for
the deeper layout rules.

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
        constants.ts          # STREAM_TYPES_*, STREAM_PREFIXES_*, EVENT_TYPES_*, TABLES_*, VIEWS_*
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
etc.). Stream types, stream-id prefixes, event types, table names, view names, and stable row keys
belong to **your app**, so keep them in a `constants.ts` file inside each domain. Use the naming
format `<SCOPE>_<DOMAIN>` with uppercase names:

```ts
// spacetimedb/src/domains/orders/constants.ts
export const STREAM_TYPES_ORDER = {
  Order: 'Order',
} as const;

export const STREAM_PREFIXES_ORDER = {
  order: 'order',
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
  at: 'order_stream_at',
  head: 'order_head',
} as const;

export const ROWS_ORDER = {
  summary: 'global',
} as const;
```

Use these constants in schema definitions, `makeStreamView({ name })`, projection `handles`, client
registries, `streamId(prefix, key)`, `viewQuery`/`tableQuery`, and contract fixtures. Do not add them
to the core package. TS event unions can use `typeof EVENT_TYPES_ORDER.Placed` so the discriminant
and the persisted event-type string cannot drift.

Keep `constants.ts` free of server-only imports. If module and web are separate packages, place the
file in a small shared package or generate it from one source so both sides use identical literals.

### 1.3 Schema, state cache, and repository

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
  esTables,
  makeRepository,
  defineAggregate,
  type CtxOf,
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

/** App-owned and private. `version` is the guard. */
const counterState = table(
  { name: TABLES_COUNTER.state },
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
  streamType: STREAM_TYPES_COUNTER.Counter,
  initial: () => ({ value: 0n }),
  decode: (row) => JSON.parse(row.data) as CounterEvent,
  evolve: (state, event) => {
    switch (event.kind) {
      case EVENT_TYPES_COUNTER.Incremented:
        return { value: state.value + BigInt(event.by) };
      case EVENT_TYPES_COUNTER.Decremented:
        return { value: state.value - BigInt(event.by) };
      case EVENT_TYPES_COUNTER.Reset:
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
  eventTypes: [
    EVENT_TYPES_COUNTER.Incremented,
    EVENT_TYPES_COUNTER.Decremented,
    EVENT_TYPES_COUNTER.Reset,
  ],
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
import { EVENT_TYPES_COUNTER } from './constants.js';

export const increment = spacetimedb.reducer(
  { streamId: t.string(), by: t.i32() },
  (ctx, { streamId, by }) => {
    const aggregate = counterRepository.loadOrCreate(ctx, streamId);
    const events: CounterEvent[] = [{ kind: EVENT_TYPES_COUNTER.Incremented, by }];
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
import { STREAM_TYPES_ORDER } from './constants.js';

// Fail if the stream already exists: useful for "create" commands.
appendToStream(ctx, { streamId, streamType: STREAM_TYPES_ORDER.Order, expectedVersion: NO_STREAM, events });

// Fail if it does not exist.
appendToStream(ctx, { streamId, streamType: STREAM_TYPES_ORDER.Order, expectedVersion: STREAM_EXISTS, events });

// Skip the check; safe only for single-writer or naturally idempotent streams.
appendToStream(ctx, { streamId, streamType: STREAM_TYPES_ORDER.Order, expectedVersion: ANY_VERSION, events });

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
import { EVENT_TYPES_COUNTER, ROWS_COUNTER, TABLES_COUNTER } from './constants.js';

const totals: InlineProjection<Context> = {
  name: TABLES_COUNTER.totals,
  handles: [EVENT_TYPES_COUNTER.Incremented, EVENT_TYPES_COUNTER.Decremented],
  handle: (ctx, row) => {
    const event = JSON.parse(row.data) as CounterEvent;
    const current = ctx.db.counterTotals.id.find(ROWS_COUNTER.totals);
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
  reset: (ctx) => ctx.db.counterTotals.id.delete(ROWS_COUNTER.totals),
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
import { VIEWS_ORDER } from './constants.js';

export const orderStream = makeStreamView(spacetimedb, {
  name: VIEWS_ORDER.stream,
  authorize: (ctx, streamId) =>
    ctx.db.orderOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const orderStreamAt = makeStreamAtView(spacetimedb, {
  name: VIEWS_ORDER.at,
  authorize: (ctx, streamId) =>
    ctx.db.orderOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const orderHead = makeStreamHeadView(spacetimedb, {
  name: VIEWS_ORDER.head,
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
import { STREAM_TYPES_COUNTER } from './constants.js';

const integrity = verifyStreamIntegrity(ctx, streamId);
// { streamId, streamType, eventCount, problems, ok }

const state = verifyStreamState(ctx, streamId, {
  cache: counterCache,
  replay: replayCounter,
});
// { exists, streamVersion, cachedVersion, cachedState, replayedState, ok }

const bad = findDrift(ctx, {
  cache: counterCache,
  replay: replayCounter,
  streamType: STREAM_TYPES_COUNTER.Counter,
});
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
// web/src/domains/counter/constants.ts — mirrors the module constants
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

// web/src/domains/counter/registry.ts
import { createEventRegistry, type EventDefinition } from 'stdb-es/client';
import { EVENT_TYPES_COUNTER } from './constants.js';

type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

const definitions: Record<string, EventDefinition<CounterEvent, any>> = {
  [EVENT_TYPES_COUNTER.Incremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Incremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Decremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Decremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Reset]: {
    encode: (event) => event,
    decode: () => ({ kind: EVENT_TYPES_COUNTER.Reset }),
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
// web/src/domains/payments/constants.ts
export const EVENT_TYPES_PAYMENT = {
  Captured: 'MoneyCaptured',
} as const;

// web/src/domains/payments/registry.ts
type PaymentEvent = {
  kind: typeof EVENT_TYPES_PAYMENT.Captured;
  amount: bigint;
  currency: string;
};

const paymentRegistry = createEventRegistry<PaymentEvent>({
  typeOf: (event) => EVENT_TYPES_PAYMENT.Captured,
  events: {
    [EVENT_TYPES_PAYMENT.Captured]: {
      // bigint cannot be JSON.stringify'd directly.
      encode: (event) => ({ amount: event.amount.toString(), currency: event.currency }),
      decode: (payload) => ({
        kind: EVENT_TYPES_PAYMENT.Captured,
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
import type { AppendEventsParams } from '../../generated/types/reducers.js';
import { counterRegistry } from './registry.js';

type EncodedEvents = AppendEventsParams['events'];

/** The typed `useReducer(reducers.appendEvents)` call. */
export type AppendCall = (params: AppendEventsParams) => Promise<void>;

export function makeCounterStore(callAppend: AppendCall) {
  return createEventStoreClient({
    registry: counterRegistry,
    // The client library produces one args object, which matches generated reducers.
    append: (args) =>
      callAppend({
        streamId: args.streamId,
        streamType: args.streamType,
        expectedVersion: args.expectedVersion,
        events: args.events as EncodedEvents,
        metadata: args.metadata ?? undefined,
      }),
  });
}
```

Generated TypeScript reducers take one params object, not positional arguments. `useReducer` exposes
that same signature; the adapter only reconciles the generated `EncodedEvent` type with the client
library's `EncodedEvent` type.

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
import { ES_ERROR, NO_STREAM, esErrorCode, streamId } from 'stdb-es';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';

const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

// Create: fail if the stream already exists.
await store.append(
  id,
  STREAM_TYPES_COUNTER.Counter,
  [{ kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
  { expectedVersion: NO_STREAM },
);

// Encode once, retry verbatim. Event ids are reused, so a commit that timed out
// settles as `replayed` rather than a duplicate append.
const batch = store.encode([{ kind: EVENT_TYPES_COUNTER.Incremented, by: 2 }]);
try {
  await store.retry(id, STREAM_TYPES_COUNTER.Counter, batch, { expectedVersion: 1 });
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
import { streamId } from 'stdb-es';
import { sliceRows } from 'stdb-es/client';
import { STREAM_PREFIXES_COUNTER } from './constants.js';

const decoded = store.decodeAll(viewRows);
const current = sliceRows(decoded, {
  streamId: streamId(STREAM_PREFIXES_COUNTER.counter, '1'),
  fromVersion: 5,
  atVersion: 20,
  limit: 50,
});
```

`sliceRows` sorts by version. It filters rows the subscription already delivered; it is not a second
source of truth and does not fetch missing history.

### 2.5 Subscription queries

```ts
import { streamId } from 'stdb-es';
import { tableQuery, viewQuery } from 'stdb-es/client';
import { STREAM_PREFIXES_COUNTER, TABLES_COUNTER, VIEWS_ORDER } from './constants.js';

const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

connection.subscribe([
  tableQuery(TABLES_COUNTER.summary),
  viewQuery(VIEWS_ORDER.stream, [id]),
  viewQuery(VIEWS_ORDER.at, [id, 10]),
]);

viewQuery(VIEWS_ORDER.stream, ["O'Brien"]); // strings are escaped by viewQuery
```

`viewQuery(name, args)` emits `SELECT * FROM name(args...)`, escaping strings and formatting
bigints/booleans/nulls. Identifiers are validated; they are not escaped as values.

### 2.6 Stream IDs

The shared `streamId(prefix, key)` helper from `stdb-es` builds ids of the form `<prefix>-<key>`:

```ts
import { NO_STREAM, streamId } from 'stdb-es';
import {
  EVENT_TYPES_ORDER,
  STREAM_PREFIXES_ORDER,
  STREAM_TYPES_ORDER,
} from './constants.js';

const id = streamId(STREAM_PREFIXES_ORDER.order, '42'); // 'order-42'
const createId = streamId(STREAM_PREFIXES_ORDER.order, crypto.randomUUID());

await store.append(createId, STREAM_TYPES_ORDER.Order, [{ kind: EVENT_TYPES_ORDER.Placed }], {
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
import {
  EVENT_TYPES_ORDER,
  STREAM_PREFIXES_ORDER,
  STREAM_TYPES_ORDER,
} from './constants.js';

export const placeOrder = spacetimedb.reducer(
  { commandId: t.string() },
  (ctx, { commandId }) => {
    const id = streamId(STREAM_PREFIXES_ORDER.order, commandId);
    // Check ownership/authorization for `id` here before saving.
    const aggregate = orderRepository.loadOrCreate(ctx, id);
    const events: OrderEvent[] = [{ kind: EVENT_TYPES_ORDER.Placed, orderId: id }];
    orderRepository.save(ctx, aggregate, events, { expectedVersion: aggregate.version });
  },
);
```

Use `streamId` on both sides with the same `STREAM_PREFIXES_*` value. Event ids are a separate concern: client
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
import { NO_STREAM, streamId } from 'stdb-es';
import { readStream, streamVersion } from 'stdb-es/server';
import { wireEvents, withIndexRanges } from 'stdb-es/testing';
import spacetimedb, { appendEvents } from '../../index.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';

const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

it('appends a batch in version order', () => {
  const harness = createModuleTestHarness(spacetimedb, { appendEvents });

  harness.withReducerTx(TestAuth.internal(), (rawCtx) => {
    const ctx = withIndexRanges(rawCtx);
    appendEvents(ctx, {
      streamId: id,
      streamType: STREAM_TYPES_COUNTER.Counter,
      expectedVersion: NO_STREAM,
      events: wireEvents('seed-', [
        [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
        [EVENT_TYPES_COUNTER.Decremented, { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 }],
      ]),
    });
  });

  harness.withReducerTx(TestAuth.internal(), (rawCtx) => {
    const ctx = withIndexRanges(rawCtx);
    expect(readStream(ctx, id).map((row) => row.version)).toEqual([1, 2]);
    expect(streamVersion(ctx, id)).toBe(2);
  });
});
```

`wireEvents(prefix, pairs)` produces deterministic ids `${prefix}-1`, `${prefix}-2`, and so on, which
also makes retry/dedupe tests reproducible.

### 3.4 Contract tests for app code

```ts
// spacetimedb/src/domains/counter/contract.test.ts
import { expect } from 'vitest';
import { streamId } from 'stdb-es';
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
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
  VIEWS_COUNTER,
} from './constants.js';

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
  streamId: () => streamId(STREAM_PREFIXES_COUNTER.counter, 'contract'),
  streams: [
    {
      streamType: STREAM_TYPES_COUNTER.Counter,
      repository,
      stateCache: counterCache,
      replay,
      sample: {
        wire: (id) =>
          wireEvents(id, [
            [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
            [EVENT_TYPES_COUNTER.Decremented, { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 }],
          ]),
        domain: () => [
          { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 },
          { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 },
        ],
        expectedState: { value: 3n },
        corrupt: (state) => ({ value: state.value + 1_000n }),
      },
    },
  ],
  views: [
    {
      name: VIEWS_COUNTER.stream,
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
import { NO_STREAM, streamId } from 'stdb-es';
import { createEventStoreClient } from 'stdb-es/client';
import { counterRegistry } from './registry.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';

it('reuses ids when a batch is retried', async () => {
  const calls: unknown[] = [];
  const store = createEventStoreClient({
    registry: counterRegistry,
    newEventId: () => 'fixed-id',
    append: async (args) => {
      calls.push(args);
    },
  });

  const batch = store.encode([{ kind: EVENT_TYPES_COUNTER.Incremented, by: 1 }]);
  await store.retry(
    streamId(STREAM_PREFIXES_COUNTER.counter, '1'),
    STREAM_TYPES_COUNTER.Counter,
    batch,
    { expectedVersion: NO_STREAM },
  );

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
for subscription convergence, and disposes the database. With `server: 'local'` it will spawn and own
`spacetime start --in-memory --non-interactive`, stopping that process in `dispose()`. With an
explicit URL it will connect to that server without stopping a process it did not start.

---

## Part 4 — Simple React frontend

A runnable version of this part lives in
[`examples/sets/counter-with-frontend`](../examples/sets/counter-with-frontend/README.md). Run
`npm run example:set:counter:start` from the repository root to publish the module and open it with
Vite.

### 4.1 Setup

Generate TypeScript bindings from the published module with the SpacetimeDB CLI, then install the
React SDK:

```bash
npm install stdb-es spacetimedb
npx spacetime generate \
  --lang typescript \
  --module-path spacetimedb \
  --out-dir web/src/generated
```

The generated module exposes `DbConnection`, `tables`, and `reducers`. Keep it in one folder and
never edit it by hand. For the complete setup and module that produces these bindings, see
[Part 0](#part-0--new-project-workflow-full-stack-counter-from-scratch).

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
      constants.ts       # STREAM_TYPES_*, STREAM_PREFIXES_*, EVENT_TYPES_*, TABLES_*, VIEWS_*
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
import { ES_ERROR, esErrorCode, streamId } from 'stdb-es';
import { createEventStoreClient, viewQuery } from 'stdb-es/client';
import { reducers, tables } from '../../generated/index.js';
import type { AppendEventsParams } from '../../generated/types/reducers.js';
import { counterRegistry } from './registry.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
  VIEWS_COUNTER,
} from './constants.js';

const STREAM_ID = streamId(STREAM_PREFIXES_COUNTER.counter, '1');
const STREAM_TYPE = STREAM_TYPES_COUNTER.Counter;

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
          callAppend({
            streamId: args.streamId,
            streamType: args.streamType,
            expectedVersion: args.expectedVersion,
            events: args.events as AppendEventsParams['events'],
            metadata: args.metadata ?? undefined,
          }),
      }),
    [callAppend],
  );

  // Parameterized views are not covered by useTable's typed query builder;
  // subscribe through the connection with a literal query.
  useEffect(() => {
    const connection = getConnection();
    if (!connection) return;
    connection.subscribe([viewQuery(VIEWS_COUNTER.stream, [STREAM_ID])]);
  }, [getConnection]);

  async function increment() {
    setBusy(true);
    setError(null);
    try {
      await store.append(
        STREAM_ID,
        STREAM_TYPE,
        [{ kind: EVENT_TYPES_COUNTER.Incremented, by }],
        { expectedVersion: state?.version ?? 0 },
      );
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
- [ ] App-owned stream types, prefixes, event types, table names, view names, and stable row keys come
      from per-domain `constants.ts` files; no duplicated literals in registries, views, or fixtures.
- [ ] Core tables remain private; no view exposes them without `authorize`.
- [ ] Every state cache table has a `version` column and a replay-on-miss path.
- [ ] Every command uses an explicit `expectedVersion` when concurrent writers are possible.
- [ ] Event ids are stable across retries and fresh for new events.
- [ ] Projections are deterministic and have `reset` if rebuilds are needed.
- [ ] Old payloads have `upgrade` functions in the client registry.
- [ ] The contract suite and module unit tests run offline in CI.
- [ ] The React client reads public views/materialized tables only.
