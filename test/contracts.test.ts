import { expect } from 'vitest';
import { makeRepository, streamVersion } from '../src/server/index.js';
import { runEventStoreContractTests, wireEvents } from '../src/testing/index.js';
import { counterCache, counterDefinition, counterEncoding, replayCounter } from './counter.js';
import {
  appendEvents,
  counterHead,
  counterStream,
  counterStreamId,
  increment as incrementCommand,
  projections,
  spacetimedb,
  type CounterEvent,
} from './fixture.js';

/**
 * Dogfoods `runEventStoreContractTests` against the same fixture module the
 * hand-written suites use. A regression here is a regression in the contract
 * suite that consumers will rely on.
 */

const counterRepository = makeRepository(counterDefinition, {
  encode: counterEncoding.encode,
  cache: counterCache,
});

const increment = (by: number): CounterEvent => ({ type: 'Incremented', by });
const decrement = (by: number): CounterEvent => ({ type: 'Decremented', by });

/** The same three events as wire rows and as domain values. */
const SAMPLE: ReadonlyArray<readonly [eventType: string, payload: unknown, domain: CounterEvent]> = [
  ['Incremented', { kind: 'Incremented', by: 5 }, increment(5)],
  ['Incremented', { kind: 'Incremented', by: 2 }, increment(2)],
  ['Decremented', { kind: 'Decremented', by: 3 }, decrement(3)],
];

runEventStoreContractTests({
  name: 'Event store contract (counter fixture)',
  spacetimedb,
  moduleExports: { appendEvents, increment: incrementCommand },
  append: (ctx, args) => appendEvents(ctx, args),
  commands: {
    name: 'increment',
    command: (streamId, commandId) => ({ counterId: streamId, by: 1, commandId }),
    authorize: (ctx, streamId) => {
      ctx.db.counterOwner.insert({ streamId: counterStreamId(streamId), owner: ctx.sender });
    },
    version: (ctx, streamId) => streamVersion(ctx, counterStreamId(streamId)),
  },
  streamId: () => 'counter-1',
  streams: [
    {
      streamType: 'Counter',
      repository: counterRepository,
      stateCache: counterCache,
      replay: replayCounter,
      sample: {
        wire: (streamId) =>
          wireEvents(
            streamId,
            SAMPLE.map(([eventType, payload]) => [eventType, payload] as const),
          ),
        domain: () => SAMPLE.map(([, , event]) => event),
        // +5, +2, -3
        expectedState: { value: 4n },
        corrupt: (state) => ({ value: state.value + 1_000n }),
      },
    },
  ],
  projections: {
    projections,
    snapshot: (ctx) => [...ctx.db.counterTotals.iter()],
  },
  views: [
    {
      name: 'counter_stream',
      view: counterStream,
      params: (streamId) => ({ streamId }),
      seed: (ctx, streamId) => {
        ctx.db.counterOwner.insert({ streamId, owner: ctx.sender });
      },
      check: (result, streamId) => {
        const rows = result as Array<{ streamId: string; version: number }>;
        expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
        expect(rows.every((row) => row.streamId === streamId)).toBe(true);
      },
    },
    {
      name: 'counter_head',
      view: counterHead,
      params: (streamId) => ({ streamId }),
      seed: (ctx, streamId) => {
        ctx.db.counterOwner.insert({ streamId, owner: ctx.sender });
      },
      check: (result, streamId) => {
        expect(result).toMatchObject({ streamId, streamType: 'Counter', version: 3 });
        expect(result).not.toHaveProperty('data');
      },
    },
  ],
});
