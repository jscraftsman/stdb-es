import { schema, t, table } from 'spacetimedb/server';
import { streamId as makeStreamId } from 'stdb-es';
import {
  appendToStream,
  esTables,
  readStream,
  streamVersion,
  type AppendResult,
  type CtxOf,
  type EsCtx,
} from 'stdb-es/server';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
  TABLES_COUNTER,
} from './domains/counter/constants.js';

/**
 * App-owned state cache. This is *not* the source of truth: `es_event` is.
 * It exists so commands do not have to replay a long stream on every write.
 *
 * The `version` column is the concurrency guard. A repository loads this row
 * and only trusts it when `version` equals `es_stream.version`; otherwise it
 * falls back to replaying the log.
 */
const counterState = table(
  { name: TABLES_COUNTER.state },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

/**
 * Private ownership table. The first caller to use a counter owns it; later
 * commands from a different `ctx.sender` are rejected before any append.
 */
const counterOwner = table(
  { name: TABLES_COUNTER.owner },
  {
    streamId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

const spacetimedb = schema({ ...esTables, counterState, counterOwner });
export default spacetimedb;

type Ctx = CtxOf<typeof spacetimedb> & EsCtx;
type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

const EVENT_TYPES = [
  EVENT_TYPES_COUNTER.Incremented,
  EVENT_TYPES_COUNTER.Decremented,
  EVENT_TYPES_COUNTER.Reset,
] as const;

function evolve(value: bigint, payload: string): bigint {
  const event = JSON.parse(payload) as CounterEvent;
  switch (event.kind) {
    case EVENT_TYPES_COUNTER.Incremented:
      return value + BigInt(event.by);
    case EVENT_TYPES_COUNTER.Decremented:
      return value - BigInt(event.by);
    case EVENT_TYPES_COUNTER.Reset:
      return 0n;
  }
}

/** Full replay, used when the cache row is missing or cannot be trusted. */
function replayValue(ctx: Ctx, stream: string): bigint {
  let value = 0n;
  for (const row of readStream(ctx, stream)) value = evolve(value, row.data);
  return value;
}

/** Runs inside the append transaction, before the reducer returns. */
function onAppended(ctx: Ctx, result: AppendResult): void {
  const stream = result.rows[0]?.streamId;
  if (!stream) return;

  const current = ctx.db.counterState.streamId.find(stream);
  if (!current) {
    // A missing cache row means "replay", never "state is empty". `onAppended`
    // runs after the write, so this replay already includes the new rows.
    ctx.db.counterState.insert({ streamId: stream, version: result.version, value: replayValue(ctx, stream) });
    return;
  }

  let value = current.value;
  for (const row of result.rows) value = evolve(value, row.data);
  ctx.db.counterState.streamId.update({ streamId: stream, version: result.version, value });
}

function assertCommand(command: { commandId: string }): void {
  if (!command.commandId) throw new Error('CMD_INVALID_COMMAND: commandId is required');
}

/**
 * Derives the stream id from the validated command and checks the caller.
 * The browser never supplies a stream id or an ownership claim.
 */
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

function appendCommand(
  ctx: Ctx,
  command: { counterId: string; commandId: string },
  eventType: (typeof EVENT_TYPES)[number],
  eventIdPrefix: string,
  by?: number,
): void {
  assertCommand(command);
  const stream = authorize(ctx, command.counterId);
  const data = by === undefined ? { kind: eventType } : { kind: eventType, by };

  appendToStream(
    ctx,
    {
      streamId: stream,
      streamType: STREAM_TYPES_COUNTER.Counter,
      expectedVersion: streamVersion(ctx, stream),
      events: [
        {
          // Deterministic from the command id: a retry is an idempotent replay.
          eventId: `${eventIdPrefix}-${command.commandId}`,
          eventType,
          data: JSON.stringify(data),
        },
      ],
    },
    { eventTypes: EVENT_TYPES, onAppended },
  );
}

/** Backend-owned write surface. There is no generic `append_events` reducer. */
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

/**
 * Anonymous read model: identical rows for every subscriber, computed once.
 * Only expose counters that are meant to be world-readable. For anything
 * scoped to a caller, use `spacetimedb.view` keyed on `ctx.sender` instead.
 */
export const counterSummary = spacetimedb.anonymousView(
  { name: TABLES_COUNTER.summary, public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);
