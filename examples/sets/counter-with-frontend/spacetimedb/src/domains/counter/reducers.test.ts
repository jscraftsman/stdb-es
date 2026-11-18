import { describe, expect, it } from 'vitest';
import { ES_ERROR, NO_STREAM, streamId } from 'stdb-es';
import { readStream } from 'stdb-es/server';
import {
  createModuleTest,
  expectAppendError,
  ids,
  versions,
  wireEvent,
  wireEvents,
} from 'stdb-es/testing';
import * as counterModule from '../../index.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  STREAM_TYPES_COUNTER,
} from './constants.js';
import type { CounterEvent } from './events.js';

const { default: spacetimedb, counterSummary } = counterModule;

function testStreamId(suffix: string): string {
  return streamId(STREAM_PREFIXES_COUNTER.counter, suffix);
}

function incremented(by: number): CounterEvent {
  return { kind: EVENT_TYPES_COUNTER.Incremented, by };
}

function decremented(by: number): CounterEvent {
  return { kind: EVENT_TYPES_COUNTER.Decremented, by };
}

function appendArgs(
  id: string,
  expectedVersion: number,
  events: ReturnType<typeof wireEvents>,
) {
  return {
    streamId: id,
    streamType: STREAM_TYPES_COUNTER.Counter,
    expectedVersion,
    events,
    metadata: null,
  };
}

describe('counter module (offline)', () => {
  it('appends a batch and publishes the anonymous summary', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const id = testStreamId('unit-append');

    test.call(
      'appendEvents',
      appendArgs(
        id,
        NO_STREAM,
        wireEvents('append', [
          [EVENT_TYPES_COUNTER.Incremented, incremented(5)],
          [EVENT_TYPES_COUNTER.Decremented, decremented(2)],
        ]),
      ),
    );

    expect(test.tx((ctx) => versions(readStream(ctx, id)))).toEqual([1, 2]);
    expect(
      test.tx((ctx) => {
        const row = ctx.db.counterState.streamId.find(id);
        return { version: row?.version, value: row?.value };
      }),
    ).toEqual({ version: 2, value: 3n });
    expect(test.anonymousView(counterSummary, undefined)).toEqual([
      { streamId: id, version: 2, value: 3n },
    ]);
  });

  it('replays a retry that reuses deterministic event ids', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const id = testStreamId('unit-retry');
    const events = ids('retry', 2).map((eventId, index) =>
      index === 0
        ? wireEvent(eventId, EVENT_TYPES_COUNTER.Incremented, incremented(4))
        : wireEvent(eventId, EVENT_TYPES_COUNTER.Reset, { kind: EVENT_TYPES_COUNTER.Reset }),
    );
    const args = appendArgs(id, NO_STREAM, events);

    test.call('appendEvents', args);
    // Same batch, same ids, and the original expectedVersion: a real client retry.
    test.call('appendEvents', args);

    expect(test.tx((ctx) => versions(readStream(ctx, id)))).toEqual([1, 2]);
    expect(
      test.tx((ctx) => {
        const row = ctx.db.counterState.streamId.find(id);
        return { version: row?.version, value: row?.value };
      }),
    ).toEqual({ version: 2, value: 0n });
  });

  it('rejects a stale expected version with a stable error code', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const id = testStreamId('unit-conflict');

    test.call(
      'appendEvents',
      appendArgs(
        id,
        NO_STREAM,
        wireEvents('seed', [[EVENT_TYPES_COUNTER.Incremented, incremented(1)]]),
      ),
    );

    expectAppendError(
      () =>
        test.call(
          'appendEvents',
          appendArgs(
            id,
            0, // NO_STREAM is stale now that the stream exists.
            [wireEvent('stale-1', EVENT_TYPES_COUNTER.Incremented, incremented(1))],
          ),
        ),
      ES_ERROR.EXPECTED_VERSION_MISMATCH,
    );

    expect(test.tx((ctx) => versions(readStream(ctx, id)))).toEqual([1]);
  });
});
