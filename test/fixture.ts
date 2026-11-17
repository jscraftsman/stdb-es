import { schema, t, table } from 'spacetimedb/server';
import {
  applyInline,
  esTables,
  makeAppendReducer,
  makeStreamAtView,
  makeStreamHeadView,
  makeStreamView,
  type CtxOf,
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

export const appendEvents = makeAppendReducer(spacetimedb, {
  eventTypes: ['Incremented', 'Decremented', 'Reset'],
  onAppended: (ctx, result) => {
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
  },
});

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
