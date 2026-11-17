import {
  aggregateStream,
  type AggregateDefinition,
  type CtxOf,
  type Repository,
  type StateCache,
} from '../src/server/index.js';
import { decodeCounterEvent, spacetimedb, type CounterEvent } from './fixture.js';

/** Aggregate state for the fixture counter. */
export type CounterState = { value: bigint };

export const counterDefinition: AggregateDefinition<CounterState, CounterEvent> = {
  streamType: 'Counter',
  initial: () => ({ value: 0n }),
  decode: (row) => decodeCounterEvent(row),
  evolve: (state, event) => {
    switch (event.type) {
      case 'Incremented':
        return { value: state.value + BigInt(event.by) };
      case 'Decremented':
        return { value: state.value - BigInt(event.by) };
      case 'Reset':
        return { value: 0n };
    }
  },
};

export const counterEncoding = {
  encode: (event: CounterEvent) => ({
    eventType: event.type,
    data: event.type === 'Reset' ? { kind: 'Reset' } : { kind: event.type, by: event.by },
  }),
};

type AppCtx = CtxOf<typeof spacetimedb>;

/** Adapter over the app-owned `counter_state` cache table. */
export const counterCache: StateCache<CounterState, AppCtx> = {
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
  remove: (ctx, streamId) => {
    ctx.db.counterState.streamId.delete(streamId);
  },
};

/** Cache-free replay, used by doctor verification and repair. */
export function replayCounter(ctx: AppCtx, streamId: string): CounterState {
  return aggregateStream(ctx, streamId, counterDefinition)!;
}

export type CounterRepository = Repository<CounterState, CounterEvent, AppCtx>;
