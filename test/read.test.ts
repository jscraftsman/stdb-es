import { TimeDuration } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import {
  ANY_VERSION,
  aggregateStream,
  appendToStream,
  foldEvents,
  getStreamState,
  listStreams,
  parsePayload,
  readStream,
  streamVersion,
} from '../src/server/index.js';
import { counterDefinition } from './counter.js';
import { decodeCounterEvent, spacetimedb } from './fixture.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

const newHarness = (): Harness => createModuleTestHarness(spacetimedb, {});

function tx<T>(test: Harness, body: (ctx: any) => T): T {
  return test.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
}

type WireEvent = { eventId: string; eventType: string; data: string };

const wire = (eventId: string, kind: string, payload: object = { kind }): WireEvent => ({
  eventId,
  eventType: kind,
  data: JSON.stringify(payload),
});

function append(
  ctx: any,
  streamId: string,
  events: WireEvent[],
  streamType = 'Counter',
): void {
  appendToStream(ctx, { streamId, streamType, events, expectedVersion: ANY_VERSION });
}

/** Three events at t=0, t=1000, t=2000: +5, -2, +10. */
function seed(test: Harness): void {
  tx(test, (ctx) => append(ctx, 'counter-1', [wire('e1', 'Incremented', { kind: 'Incremented', by: 5 })]));
  test.clock.advance(new TimeDuration(1_000n));
  tx(test, (ctx) => append(ctx, 'counter-1', [wire('e2', 'Decremented', { kind: 'Decremented', by: 2 })]));
  test.clock.advance(new TimeDuration(1_000n));
  tx(test, (ctx) => append(ctx, 'counter-1', [wire('e3', 'Incremented', { kind: 'Incremented', by: 10 })]));
}

const versions = (rows: Array<{ version: number }>) => rows.map((row) => row.version);

describe('readStream', () => {
  it('returns the whole stream ordered by version', () => {
    const test = newHarness();
    seed(test);

    const rows = tx(test, (ctx) => readStream(ctx, 'counter-1'));
    expect(versions(rows)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.position)).toEqual([1n, 2n, 3n]);
    expect(rows.map((row) => row.eventType)).toEqual([
      'Incremented',
      'Decremented',
      'Incremented',
    ]);
  });

  it('returns an empty array for an unknown stream', () => {
    const test = newHarness();
    expect(tx(test, (ctx) => readStream(ctx, 'missing'))).toEqual([]);
  });

  it('bounds by version on either side', () => {
    const test = newHarness();
    seed(test);

    expect(versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { fromVersion: 2 })))).toEqual([2, 3]);
    expect(versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { atVersion: 2 })))).toEqual([1, 2]);
    expect(
      versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { fromVersion: 2, atVersion: 2 }))),
    ).toEqual([2]);
  });

  it('treats a fromVersion past the end as empty', () => {
    const test = newHarness();
    seed(test);
    expect(tx(test, (ctx) => readStream(ctx, 'counter-1', { fromVersion: 99 }))).toEqual([]);
  });

  it('reads as of a timestamp', () => {
    const test = newHarness();
    seed(test);

    expect(versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { atTimestampMicros: 0n })))).toEqual([1]);
    expect(
      versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { atTimestampMicros: 1_000n }))),
    ).toEqual([1, 2]);
    expect(
      versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { atTimestampMicros: 2_000n }))),
    ).toEqual([1, 2, 3]);
  });

  it('intersects a timestamp bound with a version bound', () => {
    const test = newHarness();
    seed(test);

    const rows = tx(test, (ctx) =>
      readStream(ctx, 'counter-1', { atTimestampMicros: 1_000n, atVersion: 1 }),
    );
    expect(versions(rows)).toEqual([1]);
  });

  it('applies the limit after ordering', () => {
    const test = newHarness();
    seed(test);

    expect(versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { limit: 2 })))).toEqual([1, 2]);
    expect(
      versions(tx(test, (ctx) => readStream(ctx, 'counter-1', { fromVersion: 2, limit: 1 }))),
    ).toEqual([2]);
  });
});

describe('stream metadata', () => {
  it('returns null and version 0 for a missing stream', () => {
    const test = newHarness();
    const ctx = { db: test.db } as any;
    expect(getStreamState(ctx, 'missing')).toBeNull();
    expect(streamVersion(ctx, 'missing')).toBe(0);
  });

  it('lists streams, optionally by type', () => {
    const test = newHarness();
    tx(test, (ctx) => {
      append(ctx, 'counter-1', [wire('e1', 'Incremented', { kind: 'Incremented', by: 1 })]);
      append(ctx, 'counter-2', [wire('e2', 'Incremented', { kind: 'Incremented', by: 1 })]);
      append(ctx, 'order-1', [wire('e3', 'Incremented', { kind: 'Incremented', by: 1 })], 'Order');
    });

    expect(tx(test, (ctx) => listStreams(ctx)).map((row) => row.streamId).sort()).toEqual([
      'counter-1',
      'counter-2',
      'order-1',
    ]);
    expect(tx(test, (ctx) => listStreams(ctx, 'Counter')).map((row) => row.streamId).sort()).toEqual([
      'counter-1',
      'counter-2',
    ]);
  });
});

describe('aggregateStream and foldEvents', () => {
  it('returns null for a missing stream', () => {
    const test = newHarness();
    expect(tx(test, (ctx) => aggregateStream(ctx, 'missing', counterDefinition))).toBeNull();
  });

  it('folds the whole stream, honouring version bounds', () => {
    const test = newHarness();
    seed(test);

    const state = tx(test, (ctx) => aggregateStream(ctx, 'counter-1', counterDefinition));
    expect(state).toEqual({ value: 13n });

    const asOf = tx(test, (ctx) =>
      aggregateStream(ctx, 'counter-1', { ...counterDefinition, atVersion: 1 }),
    );
    expect(asOf).toEqual({ value: 5n });
  });

  it('folds rows with an explicit initial value', () => {
    const rows = [
      { eventType: 'Incremented', data: '{"kind":"Incremented","by":2}' },
    ] as never[];
    const state = foldEvents(rows, {
      initial: { value: 7n },
      decode: (row) => ({ eventType: row.eventType, data: decodeCounterEvent(row) }),
      evolve: (state, event) => counterDefinition.evolve(state, event.data, null as never),
    });
    expect(state).toEqual({ value: 9n });
  });
});

describe('parsePayload', () => {
  it('returns the event type and decoded payload', () => {
    const test = newHarness();
    seed(test);
    const [row] = tx(test, (ctx) => readStream(ctx, 'counter-1'));
    expect(parsePayload(row!)).toEqual({
      eventType: 'Incremented',
      data: { kind: 'Incremented', by: 5 },
    });
  });
});
