import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import {
  ANY_VERSION,
  findDrift,
  repairStream,
  verifyStreamIntegrity,
  verifyStreamState,
} from '../src/server/index.js';
import { counterCache, replayCounter } from './counter.js';
import { appendEvents, spacetimedb } from './fixture.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

const newHarness = (): Harness => createModuleTestHarness(spacetimedb, {});

function tx<T>(test: Harness, body: (ctx: any) => T): T {
  return test.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
}

const inc = (eventId: string, by: number) => ({
  eventId,
  eventType: 'Incremented',
  data: JSON.stringify({ kind: 'Incremented', by }),
});

/** Appends through the app reducer, which also writes the state cache. */
function append(test: Harness, events: ReturnType<typeof inc>[], streamId = 'counter-1'): void {
  tx(test, (ctx) =>
    appendEvents(ctx, {
      streamId,
      streamType: 'Counter',
      expectedVersion: ANY_VERSION,
      events,
      metadata: undefined,
    } as any),
  );
}

const integrity = (test: Harness, streamId = 'counter-1') =>
  tx(test, (ctx) => verifyStreamIntegrity(ctx, streamId));

const verifyState = (test: Harness, streamId = 'counter-1') =>
  tx(test, (ctx) =>
    verifyStreamState(ctx, streamId, { cache: counterCache, replay: replayCounter }),
  );

describe('verifyStreamIntegrity', () => {
  it('reports a clean stream as ok', () => {
    const test = newHarness();
    append(test, [inc('e1', 5), inc('e2', 2)]);

    expect(integrity(test)).toEqual({
      streamId: 'counter-1',
      streamType: 'Counter',
      eventCount: 2,
      problems: [],
      ok: true,
    });
  });

  it('treats a missing stream as ok and not existing', () => {
    const test = newHarness();
    expect(integrity(test, 'missing')).toEqual({
      streamId: 'missing',
      streamType: null,
      eventCount: 0,
      problems: [],
      ok: true,
    });
  });

  it('detects a stream version that disagrees with the log', () => {
    const test = newHarness();
    append(test, [inc('e1', 5), inc('e2', 2)]);
    tx(test, (ctx) => {
      const stream = ctx.db.esStream.streamId.find('counter-1');
      ctx.db.esStream.streamId.update({ ...stream, version: 9 });
    });

    const result = integrity(test);
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual({
      kind: 'stream-version-mismatch',
      streamVersion: 9,
      lastEventVersion: 2,
    });
  });

  it('detects a version gap', () => {
    const test = newHarness();
    append(test, [inc('e1', 1), inc('e2', 1), inc('e3', 1)]);
    tx(test, (ctx) => {
      const row = ctx.db.esEvent.eventId.find('e2');
      ctx.db.esEvent.eventId.update({ ...row, version: 7 });
    });

    const result = integrity(test);
    expect(result.problems).toContainEqual({ kind: 'version-gap', expected: 2, found: 3 });
  });

  it('detects duplicate versions', () => {
    const test = newHarness();
    append(test, [inc('e1', 1), inc('e2', 1)]);
    tx(test, (ctx) => {
      const row = ctx.db.esEvent.eventId.find('e2');
      ctx.db.esEvent.eventId.update({ ...row, version: 1 });
    });

    const result = integrity(test);
    expect(result.problems).toContainEqual({ kind: 'version-duplicate', version: 1 });
  });

  it('detects an event whose stream type differs from the stream row', () => {
    const test = newHarness();
    append(test, [inc('e1', 1)]);
    tx(test, (ctx) => {
      const row = ctx.db.esEvent.eventId.find('e1');
      ctx.db.esEvent.eventId.update({ ...row, streamType: 'Other' });
    });

    const result = integrity(test);
    expect(result.problems).toContainEqual({
      kind: 'stream-type-mismatch',
      version: 1,
      eventStreamType: 'Other',
      streamType: 'Counter',
    });
  });

  it('detects a stream row with no events', () => {
    const test = newHarness();
    tx(test, (ctx) =>
      ctx.db.esStream.insert({
        streamId: 'empty',
        streamType: 'Counter',
        version: 0,
        createdAt: ctx.timestamp,
        updatedAt: ctx.timestamp,
        metadata: undefined,
      }),
    );

    const result = integrity(test, 'empty');
    expect(result.problems).toContainEqual({ kind: 'empty-stream', streamVersion: 0 });
    expect(result.ok).toBe(false);
  });
});

describe('verifyStreamState', () => {
  it('accepts a cache that matches a full replay', () => {
    const test = newHarness();
    append(test, [inc('e1', 5), inc('e2', 2)]);

    const result = verifyState(test);
    expect(result.ok).toBe(true);
    expect(result.exists).toBe(true);
    expect(result.streamVersion).toBe(2);
    expect(result.cachedVersion).toBe(2);
    expect(result.cachedState).toEqual({ value: 7n });
    expect(result.replayedState).toEqual({ value: 7n });
  });

  it('reports a missing stream without a cache row as ok', () => {
    const test = newHarness();
    const result = verifyState(test, 'missing');
    expect(result).toMatchObject({
      exists: false,
      streamVersion: null,
      cachedVersion: null,
      replayedState: null,
      ok: true,
    });
  });

  it('reports an orphan cache row as not ok', () => {
    const test = newHarness();
    tx(test, (ctx) => ctx.db.counterState.insert({ streamId: 'ghost', version: 1, value: 5n }));

    const result = verifyState(test, 'ghost');
    expect(result.exists).toBe(false);
    expect(result.cachedVersion).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('detects same-version state drift that the version guard cannot catch', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)]);
    tx(test, (ctx) => ctx.db.counterState.streamId.update({ streamId: 'counter-1', version: 1, value: 999n }));

    const result = verifyState(test);
    expect(result.streamVersion).toBe(result.cachedVersion);
    expect(result.cachedState).toEqual({ value: 999n });
    expect(result.replayedState).toEqual({ value: 5n });
    expect(result.ok).toBe(false);
  });

  it('detects a stale cache version', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)]);
    tx(test, (ctx) => ctx.db.counterState.streamId.update({ streamId: 'counter-1', version: 0, value: 5n }));

    const result = verifyState(test);
    expect(result.cachedVersion).toBe(0);
    expect(result.streamVersion).toBe(1);
    expect(result.ok).toBe(false);
  });
});

describe('findDrift', () => {
  it('returns only streams whose cache disagrees with the log', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)], 'counter-1');
    append(test, [inc('e2', 2)], 'counter-2');
    tx(test, (ctx) =>
      ctx.db.counterState.streamId.update({ streamId: 'counter-2', version: 1, value: 99n }),
    );

    const drifted = tx(test, (ctx) => findDrift(ctx, { cache: counterCache, replay: replayCounter }));

    expect(drifted.map((row) => row.streamId)).toEqual(['counter-2']);
    expect(drifted[0]?.replayedState).toEqual({ value: 2n });
  });

  it('filters by stream type', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)], 'counter-1');
    tx(test, (ctx) =>
      ctx.db.counterState.streamId.update({ streamId: 'counter-1', version: 1, value: 99n }),
    );

    const drifted = tx(test, (ctx) =>
      findDrift(ctx, { cache: counterCache, replay: replayCounter, streamType: 'Order' }),
    );
    expect(drifted).toEqual([]);
  });
});

describe('repairStream', () => {
  it('leaves a matching cache untouched', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)]);

    const action = tx(test, (ctx) =>
      repairStream(ctx, 'counter-1', { cache: counterCache, replay: replayCounter }),
    );

    expect(action).toBe('unchanged');
    expect(test.db.counterState.streamId.find('counter-1')).toMatchObject({ version: 1, value: 5n });
  });

  it('rewrites a drifted cache row from the log', () => {
    const test = newHarness();
    append(test, [inc('e1', 5)]);
    tx(test, (ctx) => ctx.db.counterState.streamId.update({ streamId: 'counter-1', version: 1, value: 999n }));

    const action = tx(test, (ctx) =>
      repairStream(ctx, 'counter-1', { cache: counterCache, replay: replayCounter }),
    );

    expect(action).toBe('repaired');
    expect(test.db.counterState.streamId.find('counter-1')).toMatchObject({ version: 1, value: 5n });
    expect(verifyState(test).ok).toBe(true);
  });

  it('removes an orphan cache row', () => {
    const test = newHarness();
    tx(test, (ctx) => ctx.db.counterState.insert({ streamId: 'ghost', version: 1, value: 5n }));

    const action = tx(test, (ctx) =>
      repairStream(ctx, 'ghost', { cache: counterCache, replay: replayCounter }),
    );

    expect(action).toBe('removed');
    expect(test.db.counterState.streamId.find('ghost')).toBeNull();
  });

  it('does nothing for an unknown stream with no cache row', () => {
    const test = newHarness();
    const action = tx(test, (ctx) =>
      repairStream(ctx, 'missing', { cache: counterCache, replay: replayCounter }),
    );
    expect(action).toBe('unchanged');
  });
});
