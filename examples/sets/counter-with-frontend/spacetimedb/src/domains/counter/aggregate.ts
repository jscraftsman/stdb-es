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
