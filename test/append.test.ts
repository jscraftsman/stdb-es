import { describe, expect, it } from 'vitest';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import {
  ANY_VERSION,
  ES_ERROR,
  NO_STREAM,
  appendToStream,
  readStream,
  streamVersion,
} from '../src/server/index.js';
import { appendEvents, spacetimedb } from './fixture.js';
import { withIndexRanges } from './harness.js';

const auth = () => TestAuth.internal();

function newHarness() {
  return createModuleTestHarness(spacetimedb, { appendEvents });
}

/** Runs a transaction with the harness's broken range scans shimmed. */
function tx<T>(test: ReturnType<typeof newHarness>, body: (ctx: any) => T): T {
  return test.withReducerTx(auth(), (ctx) => body(withIndexRanges(ctx)));
}

function wire(eventId: string, eventType: string, payload: object) {
  return { eventId, eventType, data: JSON.stringify(payload) };
}

describe('appendToStream', () => {
  it('creates a stream row at version 1 and writes one event', () => {
    const test = newHarness();
    tx(test, (ctx) => {
      const result = appendToStream(
        ctx,
        {
          streamId: 'counter-1',
          streamType: 'Counter',
          expectedVersion: NO_STREAM,
          events: [wire('e1', 'Incremented', { kind: 'Incremented', by: 5 })],
        },
        { eventTypes: ['Incremented'] },
      );
      expect(result.status).toBe('appended');
      expect(result.version).toBe(1);
    });

    expect(test.db.esStream.count()).toBe(1n);
    expect(test.db.esStream.streamId.find('counter-1')?.version).toBe(1);
    expect(test.db.esEvent.count()).toBe(1n);
    expect(test.db.esHead.id.find('global')?.position).toBe(1n);
    expect(streamVersion({ db: test.db } as any, 'counter-1')).toBe(1);
  });

  it('appends a batch atomically with consecutive versions and positions', () => {
    const test = newHarness();
    tx(test, (ctx) =>
      appendToStream(ctx, {
        streamId: 'counter-1',
        streamType: 'Counter',
        expectedVersion: NO_STREAM,
        events: [
          wire('e1', 'Incremented', { kind: 'Incremented', by: 1 }),
          wire('e2', 'Incremented', { kind: 'Incremented', by: 2 }),
          wire('e3', 'Decremented', { kind: 'Decremented', by: 3 }),
        ],
      }),
    );

    const rows = tx(test, (ctx) => readStream(ctx, 'counter-1'));
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(rows.map((row) => row.position)).toEqual([1n, 2n, 3n]);
  });

  it('keeps global positions gapless across streams', () => {
    const test = newHarness();
    tx(test, (ctx) => {
      appendToStream(ctx, {
        streamId: 'a',
        streamType: 'Counter',
        expectedVersion: ANY_VERSION,
        events: [wire('a1', 'Incremented', { kind: 'Incremented', by: 1 })],
      });
      appendToStream(ctx, {
        streamId: 'b',
        streamType: 'Counter',
        expectedVersion: ANY_VERSION,
        events: [
          wire('b1', 'Incremented', { kind: 'Incremented', by: 1 }),
          wire('b2', 'Incremented', { kind: 'Incremented', by: 1 }),
        ],
      });
    });

    const positions = [...test.db.esEvent.iter()]
      .map((row) => row.position)
      .sort((x, y) => (x < y ? -1 : 1));
    expect(positions).toEqual([1n, 2n, 3n]);
  });

  it('rejects a stale expected version and writes nothing', () => {
    const test = newHarness();
    tx(test, (ctx) =>
      appendToStream(ctx, {
        streamId: 'counter-1',
        streamType: 'Counter',
        expectedVersion: NO_STREAM,
        events: [wire('e1', 'Incremented', { kind: 'Incremented', by: 1 })],
      }),
    );

    expect(() =>
      tx(test, (ctx) =>
        appendToStream(ctx, {
          streamId: 'counter-1',
          streamType: 'Counter',
          expectedVersion: 0,
          events: [wire('e2', 'Incremented', { kind: 'Incremented', by: 1 })],
        }),
      ),
    ).toThrow(new RegExp(ES_ERROR.EXPECTED_VERSION_MISMATCH));

    expect(test.db.esEvent.count()).toBe(1n);
    expect(test.db.esStream.streamId.find('counter-1')?.version).toBe(1);
  });

  it('replays an already committed batch without writing or re-projecting', () => {
    const test = newHarness();
    const args = {
      streamId: 'counter-1',
      streamType: 'Counter',
      expectedVersion: NO_STREAM,
      events: [wire('e1', 'Incremented', { kind: 'Incremented', by: 5 })],
    };

    tx(test, (ctx) => appendEvents(ctx, args as any));
    expect(test.db.counterState.streamId.find('counter-1')?.value).toBe(5n);

    tx(test, (ctx) => appendEvents(ctx, { ...args, expectedVersion: 1 } as any));

    expect(test.db.esEvent.count()).toBe(1n);
    expect(test.db.counterState.streamId.find('counter-1')?.value).toBe(5n);
    expect(test.db.counterTotals.id.find('global')?.increments).toBe(5n);
  });

  it('rejects a partially duplicated batch', () => {
    const test = newHarness();
    tx(test, (ctx) =>
      appendToStream(ctx, {
        streamId: 'counter-1',
        streamType: 'Counter',
        expectedVersion: NO_STREAM,
        events: [
          wire('e1', 'Incremented', { kind: 'Incremented', by: 1 }),
          wire('e2', 'Incremented', { kind: 'Incremented', by: 1 }),
        ],
      }),
    );

    expect(() =>
      tx(test, (ctx) =>
        appendToStream(ctx, {
          streamId: 'counter-1',
          streamType: 'Counter',
          expectedVersion: 2,
          events: [
            wire('e2', 'Incremented', { kind: 'Incremented', by: 1 }),
            wire('e3', 'Incremented', { kind: 'Incremented', by: 1 }),
          ],
        }),
      ),
    ).toThrow(new RegExp(ES_ERROR.PARTIAL_DUPLICATE));

    expect(test.db.esEvent.count()).toBe(2n);
  });

  it('rejects unregistered event types and invalid payloads', () => {
    const test = newHarness();
    expect(() =>
      tx(test, (ctx) =>
        appendToStream(
          ctx,
          {
            streamId: 'counter-1',
            streamType: 'Counter',
            expectedVersion: ANY_VERSION,
            events: [wire('e1', 'Nope', {})],
          },
          { eventTypes: ['Incremented'] },
        ),
      ),
    ).toThrow(new RegExp(ES_ERROR.UNKNOWN_EVENT_TYPE));

    expect(() =>
      tx(test, (ctx) =>
        appendToStream(ctx, {
          streamId: 'counter-1',
          streamType: 'Counter',
          expectedVersion: ANY_VERSION,
          events: [{ eventId: 'e2', eventType: 'Incremented', data: 'not json' }],
        }),
      ),
    ).toThrow(new RegExp(ES_ERROR.INVALID_PAYLOAD));

    expect(test.db.esEvent.count()).toBe(0n);
    expect(test.db.esHead.count()).toBe(0n);
  });

  it('rejects a stream type change', () => {
    const test = newHarness();
    tx(test, (ctx) =>
      appendToStream(ctx, {
        streamId: 'counter-1',
        streamType: 'Counter',
        expectedVersion: ANY_VERSION,
        events: [wire('e1', 'Incremented', { kind: 'Incremented', by: 1 })],
      }),
    );

    expect(() =>
      tx(test, (ctx) =>
        appendToStream(ctx, {
          streamId: 'counter-1',
          streamType: 'Other',
          expectedVersion: ANY_VERSION,
          events: [wire('e2', 'Incremented', { kind: 'Incremented', by: 1 })],
        }),
      ),
    ).toThrow(new RegExp(ES_ERROR.STREAM_TYPE_MISMATCH));
  });
});
