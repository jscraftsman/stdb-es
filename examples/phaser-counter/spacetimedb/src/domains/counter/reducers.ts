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

function assertCommand(command: { commandId: string }): void {
  if (!command.commandId) throw new Error('CMD_INVALID_COMMAND: commandId is required');
}

/**
 * Derives the stream id from a validated counter id and checks `ctx.sender`.
 * The first caller owns the stream; later callers cannot take it over.
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

/** Runs inside the append transaction, after new events are written. */
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
      // The module chooses the version; the browser never sends one.
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

/** Backend-owned write surface. No generic `append_events` reducer is exported. */
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
