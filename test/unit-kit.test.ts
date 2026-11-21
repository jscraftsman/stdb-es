import { describe, expect, it } from 'vitest';
import { ES_ERROR, NO_STREAM, buildEsErrorMessage } from '../src/index.js';
import { readStream } from '../src/server/index.js';
import {
  createFakeAppend,
  createModuleTest,
  expectAppendError,
  ids,
  type AppendCallArgs,
} from '../src/testing/index.js';
import { appendEvents, counterStream, spacetimedb } from './fixture.js';

function encoded(eventId: string) {
  return {
    eventId,
    eventType: 'Incremented',
    data: JSON.stringify({ kind: 'Incremented', by: 1 }),
  };
}

function appendArgs(streamId = 'counter-1'): AppendCallArgs {
  return {
    streamId,
    streamType: 'Counter',
    expectedVersion: NO_STREAM,
    events: ids('seed', 2).map(encoded),
    metadata: null,
  };
}

describe('ids', () => {
  it('builds stable, retry-safe event ids', () => {
    expect(ids('evt', 3)).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(ids('evt', 3)).toEqual(ids('evt', 3));
  });

  it('rejects unusable inputs', () => {
    expect(() => ids('', 1)).toThrow(/non-empty string/);
    expect(() => ids('evt', 0)).toThrow(/positive safe integer/);
    expect(() => ids('e'.repeat(128), 1)).toThrow(/exceeds 128/);
  });
});

describe('expectAppendError', () => {
  it('accepts a matching stable error code', () => {
    expect(() =>
      expectAppendError(
        () => {
          throw new Error(
            buildEsErrorMessage(ES_ERROR.EXPECTED_VERSION_MISMATCH, 'stale version'),
          );
        },
        ES_ERROR.EXPECTED_VERSION_MISMATCH,
      ),
    ).not.toThrow();
  });

  it('reports a missing error or the wrong code', () => {
    expect(() =>
      expectAppendError(() => undefined, ES_ERROR.EXPECTED_VERSION_MISMATCH),
    ).toThrow(/resolved successfully/);
    expect(() =>
      expectAppendError(
        () => {
          throw new Error(buildEsErrorMessage(ES_ERROR.INVALID_BATCH, 'bad batch'));
        },
        ES_ERROR.EXPECTED_VERSION_MISMATCH,
      ),
    ).toThrow(/got ES_INVALID_BATCH/);
  });

  it('awaits async append rejections', async () => {
    await expectAppendError(
      async () => {
        throw new Error(buildEsErrorMessage(ES_ERROR.PARTIAL_DUPLICATE, 'partial batch'));
      },
      ES_ERROR.PARTIAL_DUPLICATE,
    );
  });
});

describe('createFakeAppend', () => {
  it('records calls and returns the configured result', async () => {
    const args = appendArgs();
    const result = { status: 'appended', version: 2 };
    const fake = createFakeAppend({ result });

    await expect(fake(args)).resolves.toEqual(result);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).not.toBe(args);
    expect(fake.calls[0]?.events[0]?.eventId).toBe('seed-1');
    expect(fake.lastCall).toEqual(args);

    fake.clear();
    expect(fake.calls).toEqual([]);
  });

  it('rejects with the configured error', async () => {
    const fake = createFakeAppend({ error: new Error('timeout') });
    await expect(fake(appendArgs())).rejects.toThrow('timeout');
  });

  it('supports queued replies for retry sequences', async () => {
    const fake = createFakeAppend();
    fake.nextResult('ok').nextError(new Error('timeout'));

    await expect(fake(appendArgs())).resolves.toBe('ok');
    await expect(fake(appendArgs())).rejects.toThrow('timeout');
    await expect(fake(appendArgs())).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(3);
  });
});

describe('createModuleTest', () => {
  it('runs reducers and views without a server', () => {
    const test = createModuleTest(spacetimedb, { appendEvents });
    const streamId = 'counter-unit-kit';

    test.call('appendEvents', appendArgs(streamId));

    expect(test.tx((ctx) => readStream(ctx, streamId).map((row) => row.version))).toEqual([
      1, 2,
    ]);

    test.tx((ctx) => {
      ctx.db.counterOwner.insert({ streamId, owner: test.harness.moduleIdentity });
    });
    expect(test.view(counterStream, { streamId })).toHaveLength(2);
  });

  it('uses the default auth unless a call overrides it', () => {
    const test = createModuleTest(spacetimedb, { appendEvents });
    const seen: string[] = [];

    test.tx((ctx) => {
      seen.push(ctx.sender.toHexString());
    });
    test.tx((ctx) => {
      seen.push(ctx.sender.toHexString());
    }, test.auth);

    expect(seen[0]).toBe(seen[1]);
  });
});
