import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  ANY_VERSION,
  ES_ERROR,
  appendToStream,
  makeRepository,
} from '../src/server/index.js';
import { counterCache, counterDefinition, counterEncoding } from './counter.js';
import { spacetimedb, type CounterEvent } from './fixture.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

const newHarness = (): Harness => createModuleTestHarness(spacetimedb, {});

function tx<T>(test: Harness, body: (ctx: any) => T): T {
  return test.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
}

const inc = (by: number): CounterEvent => ({ type: 'Incremented', by });
const dec = (by: number): CounterEvent => ({ type: 'Decremented', by });

function newRepository(decode = vi.fn(counterDefinition.decode), newEventId?: () => string) {
  return makeRepository(
    { ...counterDefinition, decode },
    {
      encode: counterEncoding.encode,
      cache: counterCache,
      ...(newEventId ? { newEventId } : {}),
    },
  );
}

/** Appends through the store only, leaving any state cache untouched. */
function appendDirectly(test: Harness, eventId: string, payload: object, expectedVersion = ANY_VERSION) {
  tx(test, (ctx) =>
    appendToStream(ctx, {
      streamId: 'counter-1',
      streamType: 'Counter',
      expectedVersion,
      events: [{ eventId, eventType: 'Incremented', data: JSON.stringify(payload) }],
    }),
  );
}

describe('Repository', () => {
  it('creates a fresh aggregate for a stream that does not exist', () => {
    const test = newHarness();
    const repo = newRepository();
    const agg = tx(test, (ctx) => repo.loadOrCreate(ctx, 'counter-1'));
    expect(agg).toEqual({ id: 'counter-1', version: 0, state: { value: 0n } });
    expect(tx(test, (ctx) => repo.load(ctx, 'counter-1'))).toBeNull();
  });

  it('saves events, folds them into state, and writes the cache', () => {
    const test = newHarness();
    const repo = newRepository();

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      const result = repo.save(ctx, agg, [inc(5), dec(2)]);
      expect(result?.status).toBe('appended');
      expect(agg).toEqual({ id: 'counter-1', version: 2, state: { value: 3n } });
    });

    expect(test.db.counterState.streamId.find('counter-1')).toMatchObject({
      version: 2,
      value: 3n,
    });
  });

  it('serves a cache hit without replaying events', () => {
    const test = newHarness();
    const decode = vi.fn(counterDefinition.decode);
    const repo = newRepository(decode);

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      repo.save(ctx, agg, [inc(5)]);
    });
    decode.mockClear();

    const agg = tx(test, (ctx) => repo.load(ctx, 'counter-1'));
    expect(agg).toEqual({ id: 'counter-1', version: 1, state: { value: 5n } });
    expect(decode).not.toHaveBeenCalled();
  });

  it('ignores a stale cache and replays only the tail', () => {
    const test = newHarness();
    const decode = vi.fn(counterDefinition.decode);
    const repo = newRepository(decode);

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      repo.save(ctx, agg, [inc(5)]);
    });
    // A concurrent writer bypasses the repository, so the cache is now stale.
    appendDirectly(test, 'e2', { kind: 'Decremented', by: 2 }, 1);
    decode.mockClear();

    const agg = tx(test, (ctx) => repo.load(ctx, 'counter-1'));
    expect(agg).toEqual({ id: 'counter-1', version: 2, state: { value: 3n } });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('ignores a cache row newer than the stream', () => {
    const test = newHarness();
    const repo = newRepository();

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      const result = repo.save(ctx, agg, [inc(5)]);
      expect(result).not.toBeNull();
    });
    tx(test, (ctx) => {
      ctx.db.counterState.streamId.update({ streamId: 'counter-1', version: 99, value: 999n });
    });

    const agg = tx(test, (ctx) => repo.load(ctx, 'counter-1'));
    expect(agg).toEqual({ id: 'counter-1', version: 1, state: { value: 5n } });
  });

  it('ignores a cache newer than a time-travel version', () => {
    const test = newHarness();
    const repo = newRepository();

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      repo.save(ctx, agg, [inc(5)]);
    });
    tx(test, (ctx) => {
      const agg = repo.load(ctx, 'counter-1');
      repo.save(ctx, agg!, [dec(2)]);
    });

    const asOf = tx(test, (ctx) => repo.load(ctx, 'counter-1', { atVersion: 1 }));
    expect(asOf).toEqual({ id: 'counter-1', version: 1, state: { value: 5n } });
  });

  it('rejects a save from a stale aggregate and leaves the cache alone', () => {
    const test = newHarness();
    let nextId = 0;
    const repo = newRepository(vi.fn(counterDefinition.decode), () => `id-${++nextId}`);

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      repo.save(ctx, agg, [inc(5)]);
    });
    appendDirectly(test, 'other', { kind: 'Incremented', by: 1 }, 1);

    expect(() =>
      tx(test, (ctx) => {
        const stale = { id: 'counter-1', version: 1, state: { value: 5n } };
        repo.save(ctx, stale, [dec(2)]);
      }),
    ).toThrow(new RegExp(ES_ERROR.EXPECTED_VERSION_MISMATCH));

    expect(test.db.counterState.streamId.find('counter-1')).toMatchObject({
      version: 1,
      value: 5n,
    });
  });

  it('returns null when there is nothing to save', () => {
    const test = newHarness();
    const repo = newRepository();
    expect(tx(test, (ctx) => repo.save(ctx, repo.create('counter-1'), []))).toBeNull();
    expect(test.db.esEvent.count()).toBe(0n);
  });

  it('does not fold a replayed batch twice', () => {
    const test = newHarness();
    const repo = newRepository(vi.fn(counterDefinition.decode), () => 'fixed-id');

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      expect(repo.save(ctx, agg, [inc(5)])?.status).toBe('appended');
    });
    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      expect(repo.save(ctx, agg, [inc(5)])?.status).toBe('replayed');
      expect(agg.state).toEqual({ value: 5n });
      expect(agg.version).toBe(1);
    });

    expect(test.db.esEvent.count()).toBe(1n);
    expect(test.db.counterState.streamId.find('counter-1')).toMatchObject({
      version: 1,
      value: 5n,
    });
  });

  it('uses command-derived eventIds so a repeated save replays', () => {
    const test = newHarness();
    const repo = newRepository();

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      expect(repo.save(ctx, agg, [inc(5)], { eventIds: ['inc-cmd-retry'] })?.status).toBe(
        'appended',
      );
    });
    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      expect(repo.save(ctx, agg, [inc(5)], { eventIds: ['inc-cmd-retry'] })?.status).toBe(
        'replayed',
      );
      expect(agg.state).toEqual({ value: 5n });
      expect(agg.version).toBe(1);
    });

    expect(test.db.esEvent.count()).toBe(1n);
  });

  it('rejects eventIds that do not match the batch length', () => {
    const test = newHarness();
    const repo = newRepository();

    expect(() =>
      tx(test, (ctx) => {
        repo.save(ctx, repo.create('counter-1'), [inc(5)], { eventIds: [] });
      }),
    ).toThrow(new RegExp(ES_ERROR.INVALID_BATCH));
    expect(test.db.esEvent.count()).toBe(0n);
  });

  it('invalidate removes the cache row, forcing a replay', () => {
    const test = newHarness();
    const decode = vi.fn(counterDefinition.decode);
    const repo = newRepository(decode);

    tx(test, (ctx) => {
      const agg = repo.loadOrCreate(ctx, 'counter-1');
      repo.save(ctx, agg, [inc(5)]);
      repo.invalidate(ctx, 'counter-1');
      expect(ctx.db.counterState.streamId.find('counter-1')).toBeNull();
    });

    decode.mockClear();
    const agg = tx(test, (ctx) => repo.load(ctx, 'counter-1'));
    expect(agg).toEqual({ id: 'counter-1', version: 1, state: { value: 5n } });
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
