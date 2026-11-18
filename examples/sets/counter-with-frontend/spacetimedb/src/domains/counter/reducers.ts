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
