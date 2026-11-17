import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import {
  ANY_VERSION,
  appendToStream,
  applyInline,
  rebuildBatch,
  type InlineProjection,
} from '../src/server/index.js';
import { projections, spacetimedb } from './fixture.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

const newHarness = (): Harness => createModuleTestHarness(spacetimedb, {});

function tx<T>(test: Harness, body: (ctx: any) => T): T {
  return test.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
}

type WireEvent = { eventId: string; eventType: string; data: string };

const wire = (eventId: string, eventType: string, payload: object): WireEvent => ({
  eventId,
  eventType,
  data: JSON.stringify(payload),
});

/** Appends without running the fixture's projections, so a rebuild is needed. */
function appendDirect(test: Harness, events: WireEvent[], streamId = 'counter-1'): void {
  tx(test, (ctx) =>
    appendToStream(ctx, {
      streamId,
      streamType: 'Counter',
      expectedVersion: ANY_VERSION,
      events,
    }),
  );
}

const totals = (test: Harness) => test.db.counterTotals.id.find('global');

const inc = (eventId: string, by: number) =>
  wire(eventId, 'Incremented', { kind: 'Incremented', by });
const dec = (eventId: string, by: number) =>
  wire(eventId, 'Decremented', { kind: 'Decremented', by });

describe('applyInline', () => {
  it('runs only the projections that handle the event type', () => {
    const test = newHarness();
    const rows = [
      { eventType: 'Incremented', data: '{"kind":"Incremented","by":2}' },
      { eventType: 'Reset', data: '{"kind":"Reset"}' },
    ] as never[];

    tx(test, (ctx) => applyInline(ctx, projections, rows));

    expect(totals(test)).toMatchObject({ increments: 2n, decrements: 0n });
  });

  it('invokes the handler once per matching event row', () => {
    const test = newHarness();
    const rows = [
      { eventType: 'Incremented', data: '{"kind":"Incremented","by":1}' },
      { eventType: 'Incremented', data: '{"kind":"Incremented","by":2}' },
      { eventType: 'Decremented', data: '{"kind":"Decremented","by":3}' },
    ] as never[];

    tx(test, (ctx) => applyInline(ctx, projections, rows));

    expect(totals(test)).toMatchObject({ increments: 3n, decrements: 3n });
  });
});

describe('rebuildBatch', () => {
  it('replays the log through projections ordered by position', () => {
    const test = newHarness();
    appendDirect(test, [inc('e1', 5), dec('e2', 2), inc('e3', 1)]);
    expect(totals(test)).toBeNull();

    const result = tx(test, (ctx) => rebuildBatch(ctx, projections));

    expect(result).toEqual({
      processed: 3,
      lastPosition: 3n,
      projections: ['counter_totals'],
    });
    expect(totals(test)).toMatchObject({ increments: 6n, decrements: 2n });
  });

  it('starts strictly after fromPosition', () => {
    const test = newHarness();
    appendDirect(test, [inc('e1', 5), dec('e2', 2)]);

    const result = tx(test, (ctx) => rebuildBatch(ctx, projections, { fromPosition: 1n }));

    expect(result.processed).toBe(1);
    expect(result.lastPosition).toBe(2n);
    expect(totals(test)).toMatchObject({ increments: 0n, decrements: 2n });
  });

  it('processes at most limit rows and reports the last processed position', () => {
    const test = newHarness();
    appendDirect(test, [inc('e1', 5), inc('e2', 2), inc('e3', 1)]);

    const first = tx(test, (ctx) => rebuildBatch(ctx, projections, { limit: 1 }));
    expect(first).toEqual({ processed: 1, lastPosition: 1n, projections: ['counter_totals'] });
    expect(totals(test)).toMatchObject({ increments: 5n });

    const second = tx(test, (ctx) =>
      rebuildBatch(ctx, projections, { fromPosition: first.lastPosition!, limit: 1 }),
    );
    expect(second).toEqual({ processed: 1, lastPosition: 2n, projections: ['counter_totals'] });
    expect(totals(test)).toMatchObject({ increments: 7n });
  });

  it('returns an empty result when the log is empty', () => {
    const test = newHarness();
    const result = tx(test, (ctx) => rebuildBatch(ctx, projections));
    expect(result).toEqual({ processed: 0, lastPosition: null, projections: ['counter_totals'] });
  });

  it('resets projection state before replaying when asked', () => {
    const test = newHarness();
    appendDirect(test, [inc('e1', 5)]);
    tx(test, (ctx) => rebuildBatch(ctx, projections));
    // Simulate drift that a full rebuild is meant to erase.
    tx(test, (ctx) => ctx.db.counterTotals.id.update({ id: 'global', increments: 99n, decrements: 9n }));

    const result = tx(test, (ctx) => rebuildBatch(ctx, projections, { reset: true }));

    expect(result.processed).toBe(1);
    expect(totals(test)).toMatchObject({ increments: 5n, decrements: 0n });
  });

  it('refuses to reset a projection that cannot be reset', () => {
    const test = newHarness();
    const appendOnly: InlineProjection<any> = {
      name: 'append_only',
      handles: ['Incremented'],
      handle: () => {},
    };

    expect(() => tx(test, (ctx) => rebuildBatch(ctx, [appendOnly], { reset: true }))).toThrow(
      /append_only.*no reset/,
    );
  });

  it('wraps handler failures with the projection name and position', () => {
    const test = newHarness();
    appendDirect(test, [inc('e1', 5), inc('e2', 1)]);

    const poison: InlineProjection<any> = {
      name: 'poison',
      handles: ['Incremented'],
      handle: (_ctx, row) => {
        if (row.position === 2n) throw new Error('boom');
      },
    };

    expect(() => tx(test, (ctx) => rebuildBatch(ctx, [poison]))).toThrow(
      'projection "poison" failed at position 2 (Incremented): boom',
    );
  });
});
