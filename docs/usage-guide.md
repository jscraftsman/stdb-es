# Package Usage Guide

This guide shows how to use `stdb-es` from **SpacetimeDB module app code**, from ordinary **client
code**, in **unit/integration tests**, and from a **framework-neutral frontend**. React is the
reference UI; the same package API applies to Phaser, vanilla TypeScript, and other generated-binding
clients. It describes shipped v1 behavior. Anything marked **planned** is a milestone in
[the design record](event-sourcing-plan.md#15-milestones) and is not available yet.

For the complete signature of every export, see [API.md](API.md). For owner-only SQL inspection, see
[sql-recipes.md](sql-recipes.md).

| Entry point | Use it from | Contents |
| --- | --- | --- |
| `stdb-es` | module or client | Error codes, the `streamId` helper, and wire/protocol types |
| `stdb-es/server` | module only | Tables, append/read helpers, repositories, projections, view factories, doctor helpers |
| `stdb-es/client` | any TypeScript frontend or Node SDK client | Command dispatch, read-side event registry/codecs, subscription query helpers, subscription bridge |
| `stdb-es/testing` | Vitest unit tests | Harness shim, wire fixtures, command fakes, contract suite |
| `stdb-es/testing/integration` | Node/CLI tests only | Disposable server lifecycle, CLI calls, SQL, subscriptions |

> Never import `stdb-es/server` into frontend code. Never import Node-only test tooling into a module
> bundle or frontend app. `.` and `./client` are framework-neutral; `stdb-es/testing/integration` is a
> separate Node/CLI-only entry.

New to the package? Start with **Part 0** below for a complete from-scratch project. Parts 1–4 then
explain the individual pieces in more depth.

---

## Part 0 — New project workflow: full-stack counter from scratch

This section is a standalone walkthrough. It assumes `stdb-es` is already published on npm, so the
project installs it like any other dependency — there are no `file:` links and no checkout of this
repository. The result is the same shape as
[`examples/react-counter`](../examples/react-counter/README.md): one SpacetimeDB TypeScript module,
one generated client, and one small reference UI screen.

### 0.1 Prerequisites

```bash
node --version          # 20 or newer
spacetime --version     # 2.16.x
```

Start a local SpacetimeDB server separately, and make sure the `local` nickname exists:

```bash
spacetime server ping local
spacetime server add local --url http://localhost:3000   # only if the nickname is missing
```

The client connects over WebSocket to `ws://localhost:3000`; the CLI uses HTTP on port `3000`.

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
    "spacetimedb": "2.16.3",
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
    "spacetimedb": "2.16.3",
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
intend to reproduce. `stdb-es` declares `spacetimedb >=2.16.3 <3` as a peer; both subprojects install
`2.16.3` explicitly because generated bindings are version-specific.

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
  owner: 'counter_owner',
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

### 0.4 Module: schema, fold, command reducers, and view

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

/** The first caller to use a counter owns it; command reducers check `ctx.sender`. */
export const counterOwner = table(
  { name: TABLES_COUNTER.owner },
  {
    streamId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState, counterOwner });
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
import { t } from 'spacetimedb/server';
import { streamId as makeStreamId } from 'stdb-es';
import {
  appendToStream,
  streamVersion,
  type AppendResult,
  type EsCtx,
} from 'stdb-es/server';
import { spacetimedb, type Context } from '../../schema.js';
import { evolve, replayValue } from './aggregate.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';
import type { CounterEvent } from './events.js';

type Ctx = Context & EsCtx;
type EventType = CounterEvent['kind'];

const EVENT_TYPES = [
  EVENT_TYPES_COUNTER.Incremented,
  EVENT_TYPES_COUNTER.Decremented,
  EVENT_TYPES_COUNTER.Reset,
] as const;

function assertCommand(command: { counterId: string; commandId: string }): void {
  if (!command.counterId || !command.commandId) {
    throw new Error('CMD_INVALID_COMMAND: counterId and commandId are required');
  }
}

/** Derives the stream id and checks `ctx.sender` before any append. */
function authorize(ctx: Ctx, counterId: string): string {
  const stream = makeStreamId(STREAM_PREFIXES_COUNTER.counter, counterId);
  const owner = ctx.db.counterOwner.streamId.find(stream);
  if (owner) {
    if (!owner.owner.equals(ctx.sender)) {
      throw new Error('CMD_UNAUTHORIZED: sender does not own this counter');
    }
    return stream;
  }

  ctx.db.counterOwner.insert({ streamId: stream, owner: ctx.sender });
  return stream;
}

/** Runs inside the append transaction, only for genuinely new events. */
function onAppended(ctx: Ctx, result: AppendResult): void {
  const stream = result.rows[0]?.streamId;
  if (!stream) return;

  const current = ctx.db.counterState.streamId.find(stream);
  if (!current) {
    // `onAppended` sees the new rows, so this replay already includes them.
    ctx.db.counterState.insert({
      streamId: stream,
      version: result.version,
      value: replayValue(ctx, stream),
    });
    return;
  }

  let value = current.value;
  for (const row of result.rows) value = evolve(value, JSON.parse(row.data) as CounterEvent);
  ctx.db.counterState.streamId.update({ streamId: stream, version: result.version, value });
}

function appendCommand(
  ctx: Ctx,
  command: { counterId: string; commandId: string },
  eventType: EventType,
  eventIdPrefix: string,
  by?: number,
): void {
  assertCommand(command);
  const stream = authorize(ctx, command.counterId);
  const data: CounterEvent =
    by === undefined
      ? { kind: EVENT_TYPES_COUNTER.Reset }
      : eventType === EVENT_TYPES_COUNTER.Decremented
        ? { kind: EVENT_TYPES_COUNTER.Decremented, by }
        : { kind: EVENT_TYPES_COUNTER.Incremented, by };

  appendToStream(
    ctx,
    {
      streamId: stream,
      streamType: STREAM_TYPES_COUNTER.Counter,
      // The module chooses the version; the client never sends one.
      expectedVersion: streamVersion(ctx, stream),
      events: [
        {
          // Derived from commandId, so a retry is an idempotent replay.
          eventId: `${eventIdPrefix}-${command.commandId}`,
          eventType,
          data: JSON.stringify(data),
        },
      ],
    },
    { eventTypes: EVENT_TYPES, onAppended },
  );
}

/** The only public write surface. No generic `append_events` reducer is exported. */
export const increment = spacetimedb.reducer(
  { counterId: t.string(), by: t.u32(), commandId: t.string() },
  (ctx, command) => {
    if (command.by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');
    appendCommand(ctx, command, EVENT_TYPES_COUNTER.Incremented, 'inc', command.by);
  },
);

export const decrement = spacetimedb.reducer(
  { counterId: t.string(), by: t.u32(), commandId: t.string() },
  (ctx, command) => {
    if (command.by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');
    appendCommand(ctx, command, EVENT_TYPES_COUNTER.Decremented, 'dec', command.by);
  },
);

export const reset = spacetimedb.reducer(
  { counterId: t.string(), commandId: t.string() },
  (ctx, command) => {
    appendCommand(ctx, command, EVENT_TYPES_COUNTER.Reset, 'rst');
  },
);
```

These command reducers are the only client-callable writes. The client sends `counterId`, an optional
`by`, and `commandId`; the module derives the stream id, event type, deterministic event id, payload,
and expected version. The first caller owns the counter. The hook runs in the same transaction as the
append, and deduplicated retries skip it. A missing cache row triggers a replay instead of assuming a
zero counter.

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
export { decrement, increment, reset } from './domains/counter/reducers.js';
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

### 0.6 Web: config, constants, ids, registry, and command client

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
  owner: 'counter_owner',
} as const;
```

```ts
// web/src/domains/counter/ids.ts
import { streamId } from 'stdb-es';
import { STREAM_PREFIXES_COUNTER } from './constants.js';

/** The single public counter used by this UI. */
export const COUNTER_ID = '1';
export const COUNTER_STREAM_ID = streamId(STREAM_PREFIXES_COUNTER.counter, COUNTER_ID);
```

`streamId` only formats and validates; it does not grant ownership. The web app uses this id for read
queries only. The module derives the same id from the command's `counterId` (set to `COUNTER_ID` by
this UI) and checks ownership against `ctx.sender`.

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
import {
  createCommandClient,
  type CommandCalls,
  type CommandClient,
  type CommandIdOptions,
} from 'stdb-es/client';
import type {
  DecrementParams,
  IncrementParams,
  ResetParams,
} from '../../generated/types/reducers.js';

/** Intent-only shapes. `commandId` is added by `createCommandClient`. */
export type CounterCommands = {
  increment: Omit<IncrementParams, 'commandId'>;
  decrement: Omit<DecrementParams, 'commandId'>;
  reset: Omit<ResetParams, 'commandId'>;
};

export type CounterCommandClient = CommandClient<CounterCommands>;

/** Binds generated reducer hooks into one typed command dispatcher. */
export function makeCounterCommands(
  calls: CommandCalls<CounterCommands>,
  options: CommandIdOptions = {},
): CounterCommandClient {
  return createCommandClient(calls, options);
}
```

Generated TypeScript reducers take **one params object**. Their payload types come from
`web/src/generated/types/reducers.ts`, so web code never redeclares command shapes. The command client
adds `commandId` and dispatches intent; it never builds a stream id, event, or expected version.

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
import { reducers } from '../../generated/index.js';
import { makeCounterCommands, type CounterCommands } from './api.js';
import { COUNTER_ID, COUNTER_STREAM_ID } from './ids.js';

type CounterRow = { streamId: string; version: number; value: bigint };

type Props = {
  rows: readonly CounterRow[];
  ready: boolean;
};

export function CounterPanel({ rows, ready }: Props) {
  const callIncrement = useSpacetimeReducer(reducers.increment);
  const callDecrement = useSpacetimeReducer(reducers.decrement);
  const callReset = useSpacetimeReducer(reducers.reset);
  const commands = useMemo(
    () =>
      makeCounterCommands({
        increment: callIncrement,
        decrement: callDecrement,
        reset: callReset,
      }),
    [callIncrement, callDecrement, callReset],
  );

  const [by, setBy] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const row = rows.find((candidate) => candidate.streamId === COUNTER_STREAM_ID);

  async function send<K extends keyof CounterCommands>(name: K, command: CounterCommands[K]) {
    setBusy(true);
    setMessage(null);
    try {
      // The returned envelope can be retried verbatim after a timeout.
      await commands.sendNew(name, command);
      setMessage('Command accepted. The view will refresh when the subscription applies.');
    } catch (cause) {
      const detail = `${(cause as { message?: string })?.message ?? cause}`;
      setMessage(
        detail.includes('CMD_UNAUTHORIZED')
          ? 'Only this counter’s owner can change it.'
          : 'Command rejected.',
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
        <button disabled={busy} onClick={() => send('increment', { counterId: COUNTER_ID, by })}>
          Increment
        </button>
        <button disabled={busy} onClick={() => send('decrement', { counterId: COUNTER_ID, by })}>
          Decrement
        </button>
        <button disabled={busy} onClick={() => send('reset', { counterId: COUNTER_ID })}>
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

The panel sends only intent. `createCommandClient` supplies `commandId`, and the module derives the
stream id, event, and expected version. A rejected command is reported to the user; the next
subscription update supplies the refreshed state.

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

After a successful command, the read model returns a row like:

```json
[["counter-1", 1, 5]]
```

The columns are `stream_id`, `version`, and `value`. `es_stream`, `es_event`, and `es_head` are
private and are not available to clients.

If you need a clean scratch database:

```bash
npm run publish:reset
```

That command deletes all data in `my-counter`. The normal `npm run publish` does not.

### 0.9 What this workflow establishes

- `stdb-es` is consumed from npm by two independent workspace packages.
- App-owned literals are mirrored in module and web `constants.ts` files; the core package exports
  none of them.
- The module owns the event log, the version-guarded state cache, ownership, the command reducers, and
  the public read model.
- The client imports generated command payload types, adds `commandId` with `createCommandClient`, and
  sends intent through generated reducer hooks. It never builds an event envelope or expected version.
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

### 1.4 Command reducers are the write path

Every reducer a client can call is part of the app's public write surface. Export **command
reducers**, not a generic append. Each command accepts intent plus `commandId`; its reducer:

1. validates the fields and `ctx.sender`;
2. derives the stream id, stream type, event ids, event types, and data;
3. chooses `expectedVersion` (usually `streamVersion(ctx, streamId)`); and
4. calls the module-only `appendToStream`, optionally with `onAppended` to update a cache or inline
   projection in the same transaction.

A repeated `commandId` must produce the same event id so `appendToStream` treats the retry as
`replayed`. See [Part 0](#part-0--new-project-workflow-full-stack-counter-from-scratch) for a complete
counter reducer with ownership and deterministic event ids.

`makeRepository(...).save(...)` is also a **module-only** seam: a command reducer may use it instead of
calling `appendToStream` directly. It appends with the expected version, folds new rows into the
loaded aggregate, and writes the cache in one transaction. Pass `eventIds` derived from the command's
`commandId` so a retried command replays the same batch. Client code never calls it. The same rule
applies to `ids`, `wireEvents`, and `expectAppendError`: they are fixtures for server-side tests, not
client write APIs.

> Do not export a generic `append_events` reducer. A client calling it could choose `streamId`,
> `eventType`, and `data` for any stream. The generated bindings for `increment`, `decrement`, and
> `reset` are the only client write surface in the counter example set.

### 1.5 Optimistic concurrency and time travel (module only)

`appendToStream` and the sentinels below are server-side helpers for command reducers. A client sends
a command id, not an expected version.

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

The package no longer exports `encodeEvents`; the registry is for **reading** stored rows. `decode`
and `upgrade` are the fields the client uses. The `encode` field remains in `EventDefinition` for
app-owned codecs, and it is separate from the server-side `RepositoryOptions.encode` used when a
module command calls `repository.save(...)`. Client writes use generated command payload types.

### 2.2 Command client

```ts
// web/src/domains/counter/api.ts
import {
  createCommandClient,
  type CommandCalls,
  type CommandClient,
  type CommandIdOptions,
} from 'stdb-es/client';
import type {
  DecrementParams,
  IncrementParams,
  ResetParams,
} from '../../generated/types/reducers.js';

/** Intent only. `commandId` is added by `createCommandClient`. */
export type CounterCommands = {
  increment: Omit<IncrementParams, 'commandId'>;
  decrement: Omit<DecrementParams, 'commandId'>;
  reset: Omit<ResetParams, 'commandId'>;
};

export function makeCounterCommands(
  calls: CommandCalls<CounterCommands>,
  options: CommandIdOptions = {},
): CommandClient<CounterCommands> {
  return createCommandClient(calls, options);
}
```

Generated TypeScript reducers take one params object, not positional arguments. A `CommandCall` is a
generated reducer binding: `(command) => Promise<unknown>`. The resolved value is ignored because
reducers return `void`; results arrive through subscriptions and views. Payload types come from
`web/src/generated/types/reducers.ts` and must not be redeclared by hand.

### 2.3 Command ids, retries, and errors

```ts
import { newCommandId } from 'stdb-es/client';
import { makeCounterCommands } from './api.js';

const commands = makeCounterCommands({
  increment: callIncrement,
  decrement: callDecrement,
  reset: callReset,
});

// sendNew prepares, dispatches, and returns the envelope on success.
const sent = await commands.sendNew('increment', { counterId: '1', by: 5 });

// Replay the same envelope after an ambiguous timeout. The module derives the
// same event id and `appendToStream` settles it as `replayed`.
await commands.send('increment', sent);

// Persist before dispatch when a timeout is possible. An explicit commandId
// also lets several prepare calls produce the same key.
const pending = commands.prepare(
  'decrement',
  { counterId: '1', by: 2 },
  { commandId: newCommandId() },
);
await commands.send('decrement', pending);
```

`commandId` defaults to `crypto.randomUUID()`; inject `newCommandId` in the client options for tests or
a different id scheme. `sendNew` throws before returning an envelope, so recover the prepared value
from your own persistence or the recorded fake call when a dispatch fails. There is no client-side
expected-version or event-id retry: the module owns both. Command rejections propagate as the app's
own errors, such as `CMD_INVALID_COMMAND` or `CMD_UNAUTHORIZED`.

### 2.4 Decode and slice subscribed rows

```ts
import { streamId } from 'stdb-es';
import { decodeEvent, sliceRows } from 'stdb-es/client';
import { STREAM_PREFIXES_COUNTER } from './constants.js';
import { counterRegistry } from './registry.js';

const decoded = viewRows.map((row) => ({
  ...row,
  event: decodeEvent(counterRegistry, row),
}));
const current = sliceRows(decoded, {
  streamId: streamId(STREAM_PREFIXES_COUNTER.counter, '1'),
  fromVersion: 5,
  atVersion: 20,
  limit: 50,
});
```

`sliceRows` sorts by version. It filters rows the subscription already delivered; it is not a second
source of truth and does not fetch missing history.

### 2.5 Subscription queries and live rows

```ts
import { streamId } from 'stdb-es';
import { tableQuery, viewQuery } from 'stdb-es/client';
import { STREAM_PREFIXES_COUNTER, TABLES_COUNTER, VIEWS_COUNTER } from './constants.js';

const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

const queries = [
  tableQuery(TABLES_COUNTER.state),
  viewQuery(VIEWS_COUNTER.stream, [id]),
  viewQuery(VIEWS_COUNTER.summary),
];

viewQuery(VIEWS_COUNTER.stream, ["O'Brien"]); // strings are escaped by viewQuery
```

`viewQuery(name, args)` emits `SELECT * FROM name(args...)`, escaping strings and formatting
bigints/booleans/nulls. Identifiers are validated; they are not escaped as values.

To bind a query to a row handler, use the shipped subscription bridge:

```ts
import { subscribeEventRows } from 'stdb-es/client';

const subscription = subscribeEventRows({
  connection, // a generated DbConnection
  query: { view: VIEWS_COUNTER.stream, args: [id] },
  streamId: id,
  readRows: (ctx) => [...ctx.db.counterStream.iter()], // generated cache for the view
  onRows: (rows) => {
    currentRows = rows;
  },
  onError: (error) => {
    lastError = error;
  },
});

// When the screen/scene ends:
subscription.unsubscribe();
// At application shutdown: connection.disconnect();
```

`query` also accepts `{ table }` or `{ query: '<sql>' }`, so the builders above can be passed through
when needed. `readRows` extracts rows from the SDK context. With `streamId`, only rows for that stream
reach `onRows`; `rowStreamId` overrides the default `streamId` / `stream_id` row lookup. Callbacks are
registered once: SDK automatic reconnect replay invokes `onApplied` again without a second
`subscribe()`. Errors go to `onError`; without it they are rethrown, never swallowed.

For a screen that shows one stream at a time, `createStreamSubscription` keeps one active query:

```ts
import { createStreamSubscription } from 'stdb-es/client';

const streams = createStreamSubscription({
  connection,
  query: (streamId) => ({ view: VIEWS_COUNTER.stream, args: [streamId] }),
  readRows: (ctx) => [...ctx.db.counterStream.iter()],
  onRows: (rows, _ctx, streamId) => renderStream(streamId, rows),
  onError: (error) => report(error),
});

streams.select(id);
```

`select` unsubscribes the previous stream, ignores its late callbacks, and passes the selected id to
`onRows`. Call `unsubscribe()` when the screen is done.

### 2.6 Stream IDs

The shared `streamId(prefix, key)` helper from `stdb-es` builds ids of the form `<prefix>-<key>`. It is
safe to import from both module and client code, but its role differs by side:

```ts
// web: format an id for a view query or subscription only
import { streamId } from 'stdb-es';
import { STREAM_PREFIXES_ORDER } from './constants.js';

const id = streamId(STREAM_PREFIXES_ORDER.order, '42'); // 'order-42'

// spacetimedb: derive the same id inside a command reducer, then authorize it
import { t } from 'spacetimedb/server';
import { streamId as makeStreamId } from 'stdb-es';
import { appendToStream, streamVersion } from 'stdb-es/server';
import {
  EVENT_TYPES_ORDER,
  STREAM_PREFIXES_ORDER,
  STREAM_TYPES_ORDER,
} from './constants.js';

export const placeOrder = spacetimedb.reducer(
  { orderId: t.string(), commandId: t.string() },
  (ctx, command) => {
    const stream = makeStreamId(STREAM_PREFIXES_ORDER.order, command.orderId);
    // Check ownership/authorization for `stream` here before appending.
    appendToStream(ctx, {
      streamId: stream,
      streamType: STREAM_TYPES_ORDER.Order,
      expectedVersion: streamVersion(ctx, stream),
      events: [
        {
          // Derived from the caller's idempotency key, not generated in client code.
          eventId: `placed-${command.commandId}`,
          eventType: EVENT_TYPES_ORDER.Placed,
          data: JSON.stringify({ kind: EVENT_TYPES_ORDER.Placed, orderId: stream }),
        },
      ],
    });
  },
);
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
you. Client code may format an id for reads; only the module may decide which id a command writes.

#### Who derives the stream id?

| Source | Use when | Consequence |
| --- | --- | --- |
| **Module** | The id comes from `ctx.sender`, a server-side sequence, or other trusted domain rules | The client cannot know the id before the command; it discovers it through a view because reducers return `void` |
| **Hybrid (recommended default)** | The client supplies a stable business or correlation id and the module derives or validates the stream id | Avoids client-chosen privileged ids while keeping retry correlation simple |
| **Client (read-only)** | The client already knows the business id and needs a view query or subscription key | Use `streamId` for the query only; never send the id as a write field |

Use the same `STREAM_PREFIXES_*` value on both sides so read queries and derived write ids agree.
Event ids are a separate concern: command reducers derive them from `commandId` and pass them to
`appendToStream` or `Repository.save` as `eventIds`. Only server-side fixtures and non-command module
code should rely on generated ids.

---

## Part 3 — Testing

The complete standalone reference for this layer is the [Unit testing guide](unit%20testing.md).
The sections below keep the app-walkthrough examples in context.

Vitest `>=3 <4` is a required peer dependency; install it as a dev dependency in every workspace that
uses `stdb-es/testing`. Only the contract suite imports it at runtime, so the same command fakes and
module harness work in React, Phaser, vanilla TypeScript, and Node test projects. The integration kit
runs in Node/CLI processes only and is never imported by frontend code.

### 3.1 Test layers

| Layer | Where it runs | Tooling | Purpose |
| --- | --- | --- | --- |
| Core package tests | offline | `npm test` | Library maintainers verify every shipped export |
| Consumer module/client unit tests | offline | `stdb-es/testing` + Vitest | App code verifies command reducers, cache, projections, views, and command dispatch without a server |
| Consumer integration tests | real server | `stdb-es/testing/integration` | App code verifies publish, concurrency, subscriptions, and anonymous access end to end |
| Maintainer smoke | real server | `npm run smoke` | Publish the counter set and assert live behavior |
| Integration kit dogfood | real server | `npm run smoke:integration` | Verify the consumer kit's own lifecycle and CI path |

### 3.2 Core package tests

```bash
npm test        # offline; no server
npm run build
```

The suite uses SpacetimeDB's in-memory module harness. It covers append/concurrency/dedupe, reads and
time travel, aggregates and caches, projections, views, doctor helpers, and all stable `ES_*` error
codes.

### 3.3 App module unit tests

`stdb-es/testing` ships `createModuleTest`, `createFakeCommand`, `ids`, `expectAppendError`,
`withIndexRanges`, `wireEvent`, `wireEvents`, `versions`, and the contract suite. Call the app's real
command reducers and assert the facts the module derived from the intent. `createModuleTest` wraps
every context with `withIndexRanges`, working around a `Range` class mismatch in the module test
harness; the real host is unaffected.

```ts
// spacetimedb/src/domains/counter/reducers.test.ts
import { expect, it } from 'vitest';
import { streamId } from 'stdb-es';
import { readStream } from 'stdb-es/server';
import { createModuleTest } from 'stdb-es/testing';
import * as counterModule from '../../index.js';
import { EVENT_TYPES_COUNTER, STREAM_PREFIXES_COUNTER } from './constants.js';

const { default: spacetimedb } = counterModule;
const id = streamId(STREAM_PREFIXES_COUNTER.counter, '1');

it('derives one event from an increment command', () => {
  const test = createModuleTest(spacetimedb, counterModule);

  test.call('increment', { counterId: '1', by: 5, commandId: 'cmd-1' });

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

Calling the same command again with `commandId: 'cmd-1'` is how you test idempotent replay. For
server-side fixtures that append through a test seam, `wireEvents(prefix, pairs)` produces
deterministic ids `${prefix}-1`, `${prefix}-2`, and so on; it is not a client write API.

### 3.4 Contract tests for app code

```ts
// spacetimedb/src/domains/counter/contract.test.ts
import { expect } from 'vitest';
import { streamId } from 'stdb-es';
import { appendToStream, makeRepository, readStream, streamVersion } from 'stdb-es/server';
import { runEventStoreContractTests, wireEvents } from 'stdb-es/testing';
import {
  counterCache,
  counterDefinition,
  counterStream,
  increment,
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

const counterId = 'contract';
const contractStreamId = streamId(STREAM_PREFIXES_COUNTER.counter, counterId);

runEventStoreContractTests({
  name: 'Counter contract',
  spacetimedb,
  moduleExports: { increment },
  // Server-only seam for seeding store invariants. Not a client API.
  append: (ctx, args) => appendToStream(ctx, args),
  streamId: () => contractStreamId,
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
  // Exercises the client-facing boundary through the real command reducer.
  commands: {
    name: 'increment',
    command: (_id, commandId) => ({ counterId, by: 1, commandId }),
    authorize: (ctx, id) => ctx.db.counterOwner.insert({ streamId: id, owner: ctx.sender }),
    version: (ctx, id) => streamVersion(ctx, id),
  },
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
repair, projection rebuild parity, and view output. With `commands` set it also checks the
client-facing boundary: one append per `commandId`, replay on a repeated key, and rejection for a
caller without an ownership row. Each case uses a fresh harness.

### 3.5 Client unit tests without a server

The client's only side effect is a generated command reducer, so `createFakeCommand` is enough.

```ts
import { expect, it } from 'vitest';
import { createCommandClient } from 'stdb-es/client';
import { createFakeCommand } from 'stdb-es/testing';

type Commands = {
  increment: { counterId: string; by: number };
  reset: { counterId: string };
};

it('reuses the command envelope when a dispatch is retried', async () => {
  const increment = createFakeCommand<Commands['increment']>();
  const commands = createCommandClient<Commands>(
    { increment, reset: createFakeCommand<Commands['reset']>() },
    { newCommandId: () => 'cmd-1' },
  );

  const envelope = await commands.sendNew('increment', { counterId: '1', by: 1 });
  await commands.send('increment', envelope);

  expect(increment.calls).toHaveLength(2);
  expect(increment.calls[0]).toEqual(increment.calls[1]);
  expect(increment.lastCall).toEqual({ counterId: '1', by: 1, commandId: 'cmd-1' });
  for (const call of increment.calls) {
    expect(JSON.stringify(call)).not.toContain('streamId');
    expect(JSON.stringify(call)).not.toContain('event');
    expect(JSON.stringify(call)).not.toContain('expectedVersion');
  }
});
```

No append fake is shipped; clients have no append binding. For server-side fixture seams, use
`wireEvents`/`ids` with `appendToStream` instead. See the
[Unit testing guide](unit%20testing.md#5-client-tests-with-a-fake-command) for queued errors and
rejections, and [the API reference](API.md#41-module-and-client-helpers) for exact signatures.

### 3.6 Integration tests

The shipped smoke test proves the real-server path for the library:

```bash
spacetime start --in-memory --non-interactive
npm run smoke
```

It publishes the counter set, sends commands, rejects repeat command ids without duplicating an
event, deletes a cache row and verifies replay-based recovery, and queries the anonymous view.

For your own app, `stdb-es/testing/integration` ships the Node-only `createIntegrationEnv` kit. It
publishes to a disposable database, calls reducers, runs owner/anonymous SQL, connects clients, waits
for subscription convergence, and disposes the database. With `server: 'local'` it spawns and owns
`spacetime start --in-memory --non-interactive`, stopping that process in `dispose()`. With an
explicit URL it connects to that server without stopping a process it did not start.

```bash
npm install --save-dev stdb-es
```

```ts
import { createIntegrationEnv } from 'stdb-es/testing/integration';

const env = await createIntegrationEnv({ modulePath: 'spacetimedb' });
try {
  // Positional CLI args follow the reducer's declared field order.
  await env.call('increment', ['1', 1, 'cmd-1']);
  const rows = await env.sql('SELECT * FROM es_event');
  console.log(rows.rows);
} finally {
  await env.dispose();
}
```

The [Integration testing guide](integration%20testing.md#2-one-test-local-server) covers the full
lifecycle, external servers, subscription clients, anonymous views, and troubleshooting. The
repository also dogfoods the kit with `npm run smoke:integration` and the consumer-style
`npm run example:react-counter:test:integration` and `npm run example:phaser-counter:test:integration`
suites; all run in the CI gate.

---

## Part 4 — Simple React frontend

A runnable React version of this part lives in
[`examples/react-counter`](../examples/react-counter/README.md). Run
`npm run example:react-counter:start` from the repository root to publish the module and open it
with Vite.

The same module and `stdb-es` client API are used by
[`examples/phaser-counter`](../examples/phaser-counter/README.md). Run
`npm run example:phaser-counter:start` to open that Phaser reference on Vite port `5174`. Its
`web/src/connection.ts` shows the non-React lifecycle: build the connection, start the subscription
when connected, unsubscribe when it ends, remove row callbacks, then disconnect on scene shutdown or
page unload.

The `stdb-es` calls in this part are framework-neutral: only the provider, hooks, and components are
React-specific. A Phaser scene or vanilla TypeScript app supplies the same generated reducer callbacks
to `createCommandClient` and the same connection to the subscription helpers. In every frontend:

1. Create and own the generated `DbConnection` in framework/application setup.
2. Register views with `subscribeEventRows` or `createStreamSubscription` and retain the handle.
3. Call `unsubscribe()` (or `unsubscribeThen()`) when the screen or scene ends.
4. Call `connection.disconnect()` at application shutdown, or let the SDK provider do it.

Reconnect replay refreshes retained subscriptions; do not subscribe again on every reconnect. The
React provider shown below owns connection creation and disconnection for you.

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
  .withDatabaseName(import.meta.env.VITE_STDB_DATABASE ?? 'stdb-es-counter-with-frontend');

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
      api.ts             # generated commands -> createCommandClient
      registry.ts        # read-side decoder
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
import { viewQuery } from 'stdb-es/client';
import { reducers, tables } from '../../generated/index.js';
import { makeCounterCommands, type CounterCommands } from './api.js';
import { COUNTER_ID, COUNTER_STREAM_ID } from './ids.js';
import { VIEWS_COUNTER } from './constants.js';

export function CounterPanel() {
  const [rows, ready] = useTable(tables.counterSummary);
  const { getConnection } = useSpacetimeDB();
  const callIncrement = useSpacetimeReducer(reducers.increment);
  const callDecrement = useSpacetimeReducer(reducers.decrement);
  const callReset = useSpacetimeReducer(reducers.reset);
  const commands = useMemo(
    () =>
      makeCounterCommands({
        increment: callIncrement,
        decrement: callDecrement,
        reset: callReset,
      }),
    [callIncrement, callDecrement, callReset],
  );
  const [by, setBy] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const state = rows.find((row) => row.streamId === COUNTER_STREAM_ID);

  // Parameterized views are not covered by useTable's typed query builder;
  // subscribe through the connection with a literal query. Use subscribeEventRows
  // (§2.5) when you need to bind the query to a row handler yourself.
  useEffect(() => {
    const connection = getConnection();
    if (!connection) return;
    const handle = connection.subscribe([
      viewQuery(VIEWS_COUNTER.stream, [COUNTER_STREAM_ID]),
    ]);
    return () => handle.unsubscribe();
  }, [getConnection]);

  async function send<K extends keyof CounterCommands>(name: K, command: CounterCommands[K]) {
    setBusy(true);
    setError(null);
    try {
      // The returned envelope can be retried verbatim after a timeout.
      await commands.sendNew(name, command);
      // The reducer returns void. The new value arrives through the subscription;
      // do not assume a local version here.
    } catch (cause) {
      const detail = `${(cause as { message?: string })?.message ?? cause}`;
      setError(detail.includes('CMD_UNAUTHORIZED') ? 'Not the owner.' : 'Command rejected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Counter {COUNTER_STREAM_ID}</h2>
      <p>{ready ? `Value: ${state?.value.toString() ?? '0'}` : 'Loading…'}</p>
      <input
        aria-label="Increment by"
        type="number"
        value={by}
        onChange={(event) => setBy(Number(event.target.value))}
      />
      <button disabled={busy} onClick={() => send('increment', { counterId: COUNTER_ID, by })}>
        Increment
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
```

For a view row, `decodeEvent(counterRegistry, row)` accepts the minimal `StoredEventRow` shape
(`eventId`, `position`, `streamId`, `streamType`, `version`, `eventType`, `data`, optional `metadata`
and `createdAtMicros`). Use it when you want the domain event rather than raw row data.

### 4.5 UI guidance for the example sets

- Show the current version or status. Reducers return void, so "success" is observed through a
  subscription or a head view.
- Show `replayed` distinctly from `appended` in idempotency demos by reading the head view after a
  retry.
- For eventual consistency, show a pending state until the expected version arrives; do not claim a
  global commit from a local click.
- Keep one screen per set. Multi-domain sets use a shared connection (provider in React) and separate
  panels.
- Never subscribe to `es_event` directly. It is private; use an authorized view or a materialized read
  model.

---

## Checklist before shipping an app

- [ ] `esTables` is spread into exactly one module schema.
- [ ] App-owned stream types, prefixes, event types, table names, view names, and stable row keys come
      from per-domain `constants.ts` files; no duplicated literals in registries, views, or fixtures.
- [ ] Core tables remain private; no view exposes them without `authorize`.
- [ ] The client calls only public command reducers; no generic append binding is exported or used.
- [ ] Every command carries `commandId`, and the module derives event ids deterministically from it.
- [ ] Web code imports command payload types from `spacetime generate` output.
- [ ] Every state cache table has a `version` column and a replay-on-miss path.
- [ ] Every command reducer chooses an explicit `expectedVersion` (usually from `streamVersion`)
      when concurrent writers are possible.
- [ ] Event ids are stable across retries and fresh for new events.
- [ ] Projections are deterministic and have `reset` if rebuilds are needed.
- [ ] Old payloads have `upgrade` functions in the client registry.
- [ ] The contract suite and module unit tests run offline in CI.
- [ ] The frontend/client reads public views/materialized tables only.
