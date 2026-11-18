import { describe, expect, it } from 'vitest';
import { ES_ERROR, NO_STREAM, buildEsErrorMessage } from 'stdb-es';
import { createFakeAppend, expectAppendError, ids } from 'stdb-es/testing';
import { makeCounterStore } from './api.js';
import { EVENT_TYPES_COUNTER, STREAM_TYPES_COUNTER } from './constants.js';
import { COUNTER_STREAM_ID } from './ids.js';

/** Adapts a generated-binding fake to the app's `Promise<void>` reducer call. */
function callAppendFrom(fake: ReturnType<typeof createFakeAppend>) {
  return (args: Parameters<Parameters<typeof makeCounterStore>[0]>[0]) =>
    fake({
      ...args,
      metadata: args.metadata ?? null,
    }).then(() => undefined);
}

describe('counter client (offline)', () => {
  it('encodes events and forwards the expected version', async () => {
    const append = createFakeAppend();
    const store = makeCounterStore(callAppendFrom(append));
    const eventIds = ids('client', 2);
    let nextId = 0;

    await store.append(
      COUNTER_STREAM_ID,
      STREAM_TYPES_COUNTER.Counter,
      [
        { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 },
        { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 },
      ],
      {
        expectedVersion: NO_STREAM,
        newEventId: () => eventIds[nextId++]!,
      },
    );

    expect(append.calls).toHaveLength(1);
    expect(append.lastCall).toMatchObject({
      streamId: COUNTER_STREAM_ID,
      streamType: STREAM_TYPES_COUNTER.Counter,
      expectedVersion: NO_STREAM,
      metadata: null,
    });
    expect(append.lastCall?.events.map((event) => event.eventId)).toEqual([
      'client-1',
      'client-2',
    ]);
    expect(
      append.lastCall?.events.map((event) => [event.eventType, JSON.parse(event.data)]),
    ).toEqual([
      [EVENT_TYPES_COUNTER.Incremented, { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 }],
      [EVENT_TYPES_COUNTER.Decremented, { kind: EVENT_TYPES_COUNTER.Decremented, by: 2 }],
    ]);
  });

  it('retries the exact encoded batch after a timeout', async () => {
    const append = createFakeAppend();
    const store = makeCounterStore(callAppendFrom(append));
    const encoded = store.encode(
      [{ kind: EVENT_TYPES_COUNTER.Incremented, by: 1 }],
      { newEventId: () => ids('retry', 1)[0]! },
    );

    append.nextError(new Error('timeout')).nextResult(undefined);

    await expect(
      store.retry(COUNTER_STREAM_ID, STREAM_TYPES_COUNTER.Counter, encoded, {
        expectedVersion: NO_STREAM,
      }),
    ).rejects.toThrow('timeout');
    await expect(
      store.retry(COUNTER_STREAM_ID, STREAM_TYPES_COUNTER.Counter, encoded, {
        expectedVersion: NO_STREAM,
      }),
    ).resolves.toBeUndefined();

    expect(append.calls).toHaveLength(2);
    expect(append.calls[0]?.events).toEqual(append.calls[1]?.events);
    expect(append.calls[0]?.events[0]?.eventId).toBe('retry-1');
  });

  it('matches a stable append error from the generated binding', async () => {
    const append = createFakeAppend({
      error: new Error(
        buildEsErrorMessage(ES_ERROR.EXPECTED_VERSION_MISMATCH, 'someone updated first'),
      ),
    });
    const store = makeCounterStore(callAppendFrom(append));

    await expectAppendError(
      () =>
        store.append(
          COUNTER_STREAM_ID,
          STREAM_TYPES_COUNTER.Counter,
          [{ kind: EVENT_TYPES_COUNTER.Incremented, by: 1 }],
          { expectedVersion: 4 },
        ),
      ES_ERROR.EXPECTED_VERSION_MISMATCH,
    );

    expect(append.lastCall?.expectedVersion).toBe(4);
  });
});
