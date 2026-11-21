import { schema, t, table } from 'spacetimedb/server';
import {
  appendToStream,
  esTables,
  makeStreamView,
  readStream,
  streamVersion,
  type AppendResult,
  type CtxOf,
  type EsCtx,
} from '../../../dist/server/index.js';
import { streamId as makeStreamId } from '../../../dist/index.js';

const STREAM_PREFIX = 'counter';
const STREAM_TYPE = 'Counter';
const EVENT_TYPES = ['Incremented', 'Decremented', 'Reset'] as const;

const counterState = table(
  { name: 'counter_state' },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

const counterOwner = table(
  { name: 'counter_owner' },
  {
    streamId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

const spacetimedb = schema({ ...esTables, counterState, counterOwner });

type Ctx = CtxOf<typeof spacetimedb> & EsCtx;
type Kind = (typeof EVENT_TYPES)[number];

function stream(counterId: string): string {
  return makeStreamId(STREAM_PREFIX, counterId);
}

function assertCommand(command: { commandId: string }): void {
  if (!command.commandId) throw new Error('CMD_INVALID_COMMAND: commandId is required');
}

function authorize(ctx: Ctx, counterId: string): string {
  const id = stream(counterId);
  const owner = ctx.db.counterOwner.streamId.find(id);
  if (!owner?.owner.equals(ctx.sender)) {
    throw new Error('CMD_UNAUTHORIZED: sender does not own this counter');
  }
  return id;
}

function evolve(value: bigint, event: { kind: Kind; by?: number }): bigint {
  if (event.kind === 'Incremented') return value + BigInt(event.by ?? 0);
  if (event.kind === 'Decremented') return value - BigInt(event.by ?? 0);
  return 0n;
}

function replayValue(ctx: Ctx, id: string): bigint {
  let value = 0n;
  for (const row of readStream(ctx, id)) {
    value = evolve(value, JSON.parse(row.data) as { kind: Kind; by?: number });
  }
  return value;
}

function onAppended(ctx: Ctx, result: AppendResult): void {
  const id = result.rows[0]?.streamId;
  if (!id) return;

  const current = ctx.db.counterState.streamId.find(id);
  if (!current) {
    ctx.db.counterState.insert({
      streamId: id,
      version: result.version,
      value: replayValue(ctx, id),
    });
    return;
  }

  let value = current.value;
  for (const row of result.rows) {
    value = evolve(value, JSON.parse(row.data) as { kind: Kind; by?: number });
  }
  ctx.db.counterState.streamId.update({ streamId: id, version: result.version, value });
}

function appendCommand(
  ctx: Ctx,
  command: { counterId: string; commandId: string },
  kind: Kind,
  by: number | undefined,
  prefix: string,
): void {
  assertCommand(command);
  const id = authorize(ctx, command.counterId);
  const data = by === undefined ? { kind } : { kind, by };

  appendToStream(
    ctx,
    {
      streamId: id,
      streamType: STREAM_TYPE,
      expectedVersion: streamVersion(ctx, id),
      events: [
        {
          eventId: `${prefix}-${command.commandId}`,
          eventType: kind,
          data: JSON.stringify(data),
        },
      ],
    },
    { eventTypes: EVENT_TYPES, onAppended },
  );
}

/**
 * Registers the caller as owner of a counter. This is test setup, not an event;
 * command reducers below refuse callers without a matching ownership row.
 */
export const claimCounter = spacetimedb.reducer(
  { counterId: t.string(), commandId: t.string() },
  (ctx, command) => {
    assertCommand(command);
    const id = stream(command.counterId);
    const existing = ctx.db.counterOwner.streamId.find(id);
    if (existing) {
      if (!existing.owner.equals(ctx.sender)) {
        throw new Error('CMD_UNAUTHORIZED: counter is owned by another sender');
      }
      return;
    }
    ctx.db.counterOwner.insert({ streamId: id, owner: ctx.sender });
  },
);

export const increment = spacetimedb.reducer(
  { counterId: t.string(), commandId: t.string(), by: t.u32() },
  (ctx, command) => {
    assertCommand(command);
    if (command.by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');
    appendCommand(ctx, command, 'Incremented', command.by, 'inc');
  },
);

export const decrement = spacetimedb.reducer(
  { counterId: t.string(), commandId: t.string(), by: t.u32() },
  (ctx, command) => {
    assertCommand(command);
    if (command.by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');
    appendCommand(ctx, command, 'Decremented', command.by, 'dec');
  },
);

export const reset = spacetimedb.reducer(
  { counterId: t.string(), commandId: t.string() },
  (ctx, command) => {
    appendCommand(ctx, command, 'Reset', undefined, 'rst');
  },
);

export const counterSummary = spacetimedb.anonymousView(
  { name: 'counter_summary', public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);

/** Public parameterized audit view used by the integration smoke. */
export const streamEvents = makeStreamView(spacetimedb, {
  name: 'stream_events',
  authorize: () => true,
});

export default spacetimedb;
