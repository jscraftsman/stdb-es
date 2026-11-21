import { schema, t, table } from 'spacetimedb/server';
import { streamId as makeStreamId } from '../src/stream-id.js';
import {
  appendToStream,
  applyInline,
  esTables,
  makeStreamAtView,
  makeStreamHeadView,
  makeStreamView,
  streamVersion,
  type AppendResult,
  type CtxOf,
  type EsCtx,
  type InlineProjection,
} from '../src/server/index.js';

/** Domain event union used by the fixture module. */
export type CounterEvent =
  | { type: 'Incremented'; by: number }
  | { type: 'Decremented'; by: number }
  | { type: 'Reset' };

/** Current-state cache, app-owned, private. */
export const counterState = table(
  { name: 'counter_state' },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

/** Materialized read model used to exercise inline projections. */
export const counterTotals = table(
  { name: 'counter_totals' },
  {
    id: t.string().primaryKey(),
    increments: t.u64(),
    decrements: t.u64(),
  },
);

/** Ownership table used to exercise authorization in the view factories. */
export const counterOwner = table(
  { name: 'counter_owner' },
  {
    streamId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState, counterTotals, counterOwner });

type AppCtx = CtxOf<typeof spacetimedb>;

export function decodeCounterEvent(row: { data: string }): CounterEvent {
  const raw = JSON.parse(row.data) as
    | { kind: 'Incremented'; by: number }
    | { kind: 'Decremented'; by: number }
    | { kind: 'Reset' };
  return raw.kind === 'Reset' ? { type: 'Reset' } : { type: raw.kind, by: raw.by };
}

const totalsProjection: InlineProjection<AppCtx> = {
  name: 'counter_totals',
  handles: ['Incremented', 'Decremented'],
  handle: (ctx, row) => {
    const current = ctx.db.counterTotals.id.find('global');
    const parsed = JSON.parse(row.data) as { kind: string; by: number };
    const next = {
      id: 'global',
      increments: (current?.increments ?? 0n) + (parsed.kind === 'Incremented' ? BigInt(parsed.by) : 0n),
      decrements: (current?.decrements ?? 0n) + (parsed.kind === 'Decremented' ? BigInt(parsed.by) : 0n),
    };
    if (current) ctx.db.counterTotals.id.update(next);
    else ctx.db.counterTotals.insert(next);
  },
  reset: (ctx) => {
    ctx.db.counterTotals.id.delete('global');
  },
};

export const projections = [totalsProjection];

type CounterAppendCtx = AppCtx & EsCtx;

/** Mirrors the module-owned stream-id derivation from a validated counter id. */
export function counterStreamId(counterId: string): string {
  return makeStreamId('counter', counterId);
}

const counterEventTypes = ['Incremented', 'Decremented', 'Reset'] as const;

function applyCounterAppended(ctx: CounterAppendCtx, result: AppendResult): void {
  const streamId = result.rows[0]?.streamId;
  if (!streamId) return;

  const current = ctx.db.counterState.streamId.find(streamId);
  let value = current?.value ?? 0n;
  for (const row of result.rows) {
    const event = decodeCounterEvent(row);
    if (event.type === 'Incremented') value += BigInt(event.by);
    else if (event.type === 'Decremented') value -= BigInt(event.by);
    else value = 0n;
  }

  const next = { streamId, version: result.version, value };
  if (current) ctx.db.counterState.streamId.update(next);
  else ctx.db.counterState.insert(next);

  applyInline(ctx, projections, result.rows);
}

/**
 * Test-only app reducer.
 *
 * The package no longer ships a generic append factory: real modules expose
 * command reducers that call `appendToStream` themselves. This fixture keeps one
 * generic target so the store's own tests and the published smoke module keep
 * working until the integration kit migrates to command reducers.
 */
export const appendEvents = spacetimedb.reducer(
  {
    streamId: t.string(),
    streamType: t.string(),
    expectedVersion: t.i32(),
    events: t.array(
      t.object('EsEncodedEvent', {
        eventId: t.string(),
        eventType: t.string(),
        data: t.string(),
        metadata: t.option(t.string()),
      }),
    ),
    metadata: t.option(t.string()),
  },
  (ctx, args) => {
    const appCtx = ctx as unknown as AppCtx & EsCtx;
    appendToStream(
      appCtx,
      {
        streamId: args.streamId,
        streamType: args.streamType,
        expectedVersion: args.expectedVersion,
        events: args.events,
        metadata: args.metadata ?? null,
      },
      {
        eventTypes: counterEventTypes,
        onAppended: applyCounterAppended,
      },
    );
  },
);

/**
 * Test-only command reducer.
 *
 * The browser sends only a counter id, an amount, and an idempotency key. This
 * reducer derives the stream id and event, checks `ctx.sender` against an
 * ownership row, and passes a server-chosen expected version to the store.
 */
export const increment = spacetimedb.reducer(
  {
    counterId: t.string(),
    by: t.u32(),
    commandId: t.string(),
  },
  (ctx, command) => {
    if (!command.commandId) throw new Error('CMD_INVALID_COMMAND: commandId is required');
    if (command.by === 0) throw new Error('CMD_INVALID_COMMAND: by must be greater than zero');

    const stream = counterStreamId(command.counterId);
    const owner = ctx.db.counterOwner.streamId.find(stream);
    if (!owner?.owner.equals(ctx.sender)) {
      throw new Error('CMD_UNAUTHORIZED: sender does not own this counter');
    }

    const appCtx = ctx as unknown as CounterAppendCtx;
    appendToStream(
      appCtx,
      {
        streamId: stream,
        streamType: 'Counter',
        expectedVersion: streamVersion(appCtx, stream),
        events: [
          {
            eventId: `inc-${command.commandId}`,
            eventType: 'Incremented',
            data: JSON.stringify({ kind: 'Incremented', by: command.by }),
          },
        ],
      },
      {
        eventTypes: counterEventTypes,
        onAppended: applyCounterAppended,
      },
    );
  },
);

export const counterStream = makeStreamView(spacetimedb, {
  name: 'counter_stream',
  authorize: (ctx, streamId) =>
    ctx.db.counterOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const counterStreamAt = makeStreamAtView(spacetimedb, {
  name: 'counter_stream_at',
  authorize: (ctx, streamId) =>
    ctx.db.counterOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});

export const counterHead = makeStreamHeadView(spacetimedb, {
  name: 'counter_head',
  authorize: (ctx, streamId) =>
    ctx.db.counterOwner.streamId.find(streamId)?.owner.equals(ctx.sender) ?? false,
});
