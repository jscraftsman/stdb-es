import { t } from 'spacetimedb/server';
import {
  appendToStream,
  streamVersion,
  type AppendResult,
  type EsCtx,
} from 'stdb-es/server';
import { spacetimedb, type Context } from '../../schema.js';
import { evolve, replayValue } from './aggregate.js';
import { assertValidGoogleTokenIfPresent } from './auth.js';
import {
  COUNTER_KIND,
  EVENT_TYPES,
  MAX_COMMAND_ID_LENGTH,
  STREAM_TYPES,
  type CounterKind,
} from './constants.js';
import type { CounterEvent } from './events.js';
import { counterStream } from './streams.js';

type Ctx = Context & EsCtx;
type EventType = CounterEvent['kind'];

const EVENT_TYPE_VALUES = [
  EVENT_TYPES.Incremented,
  EVENT_TYPES.Decremented,
  EVENT_TYPES.Reset,
] as const;

const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

function assertCommand(command: { commandId: string }): void {
  if (
    command.commandId.length === 0 ||
    command.commandId.length > MAX_COMMAND_ID_LENGTH ||
    !COMMAND_ID_PATTERN.test(command.commandId)
  ) {
    throw new Error(
      `CMD_INVALID_COMMAND: commandId must be 1-${MAX_COMMAND_ID_LENGTH} safe characters`,
    );
  }
}

function eventData(eventType: EventType, by?: number): CounterEvent {
  if (eventType === EVENT_TYPES.Reset) return { kind: EVENT_TYPES.Reset };
  if (by === undefined) throw new Error('CMD_INVALID_COMMAND: amount is required');
  if (eventType === EVENT_TYPES.Decremented) {
    return { kind: EVENT_TYPES.Decremented, by };
  }
  return { kind: EVENT_TYPES.Incremented, by };
}

function ensureOwner(ctx: Ctx, stream: string, kind: CounterKind): void {
  const owner = ctx.db.counterOwner.streamId.find(stream);
  if (owner) {
    if (!owner.owner.equals(ctx.sender)) {
      throw new Error('CMD_UNAUTHORIZED: sender does not own this counter');
    }
    return;
  }

  ctx.db.counterOwner.insert({ streamId: stream, counterKind: kind, owner: ctx.sender });
}

/** Runs inside the append transaction, after the new events are visible. */
function updateState(ctx: Ctx, result: AppendResult, kind: CounterKind): void {
  const stream = result.rows[0]?.streamId;
  if (!stream) return;

  const current = ctx.db.counterState.streamId.find(stream);
  if (!current) {
    ctx.db.counterState.insert({
      streamId: stream,
      counterKind: kind,
      version: result.version,
      value: replayValue(ctx, stream),
    });
    return;
  }

  let value = current.value;
  for (const row of result.rows) value = evolve(value, JSON.parse(row.data) as CounterEvent);
  ctx.db.counterState.streamId.update({
    streamId: stream,
    counterKind: kind,
    version: result.version,
    value,
  });
}

function appendCommand(
  ctx: Ctx,
  kind: CounterKind,
  command: { commandId: string },
  eventType: EventType,
  eventIdPrefix: string,
  by?: number,
): void {
  assertCommand(command);
  const stream = counterStream(ctx, kind);
  if (kind !== COUNTER_KIND.global) ensureOwner(ctx, stream, kind);

  appendToStream(
    ctx,
    {
      streamId: stream,
      // The stream type is app metadata, not trusted client input.
      streamType:
        kind === COUNTER_KIND.global
          ? STREAM_TYPES.Global
          : kind === COUNTER_KIND.publicOwned
            ? STREAM_TYPES.PublicOwned
            : STREAM_TYPES.PrivateOwned,
      // The module chooses the version; the browser never sends one.
      expectedVersion: streamVersion(ctx, stream),
      events: [
        {
          // Stream-scoped so identical commandIds from different users cannot collide.
          eventId: `${eventIdPrefix}-${stream}-${command.commandId}`,
          eventType,
          data: JSON.stringify(eventData(eventType, by)),
        },
      ],
    },
    {
      eventTypes: EVENT_TYPE_VALUES,
      onAppended: (appendedCtx, result) => updateState(appendedCtx, result, kind),
    },
  );
}

function assertAmount(by: number): void {
  if (by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');
}

const amountCommand = { by: t.u32(), commandId: t.string() };
const plainCommand = { commandId: t.string() };

/** C1: one global stream; anonymous callers may write. */
export const incrementGlobal = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.global, command, EVENT_TYPES.Incremented, 'inc', command.by);
});

export const decrementGlobal = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.global, command, EVENT_TYPES.Decremented, 'dec', command.by);
});

export const resetGlobal = spacetimedb.reducer(plainCommand, (ctx, command) => {
  appendCommand(ctx, COUNTER_KIND.global, command, EVENT_TYPES.Reset, 'rst');
});

/** C2: one stream per Google user; public read, owner-only write. */
export const incrementPublicMine = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.publicOwned, command, EVENT_TYPES.Incremented, 'inc', command.by);
});

export const decrementPublicMine = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.publicOwned, command, EVENT_TYPES.Decremented, 'dec', command.by);
});

export const resetPublicMine = spacetimedb.reducer(plainCommand, (ctx, command) => {
  appendCommand(ctx, COUNTER_KIND.publicOwned, command, EVENT_TYPES.Reset, 'rst');
});

/** C3: one stream per Google user; owner-only read and write. */
export const incrementPrivateMine = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.privateOwned, command, EVENT_TYPES.Incremented, 'inc', command.by);
});

export const decrementPrivateMine = spacetimedb.reducer(amountCommand, (ctx, command) => {
  assertAmount(command.by);
  appendCommand(ctx, COUNTER_KIND.privateOwned, command, EVENT_TYPES.Decremented, 'dec', command.by);
});

export const resetPrivateMine = spacetimedb.reducer(plainCommand, (ctx, command) => {
  appendCommand(ctx, COUNTER_KIND.privateOwned, command, EVENT_TYPES.Reset, 'rst');
});

/**
 * Anonymous connections are allowed for C1 and C2 reads. If a client supplies
 * a token, it must be a Google ID token for this application.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  assertValidGoogleTokenIfPresent(ctx);
});
