import { describe, expect, it } from 'vitest';
import { ES_ERROR, buildEsErrorMessage } from '../src/index.js';
import { readStream } from '../src/server/index.js';
import * as testing from '../src/testing/index.js';
import {
  createFakeCommand,
  createModuleTest,
  expectAppendError,
  ids,
} from '../src/testing/index.js';
import { counterStream, counterStreamId, increment, spacetimedb } from './fixture.js';

describe('stdb-es/testing exports', () => {
  it('does not export the deprecated append fake', () => {
    expect(testing).not.toHaveProperty('createFakeAppend');
    expect(testing.createFakeCommand).toBeTypeOf('function');
  });
});

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

describe('createFakeCommand', () => {
  type Increment = { counterId: string; by: number; commandId: string };

  it('records intent-only calls and returns the configured result', async () => {
    const command: Increment = { counterId: 'counter-1', by: 2, commandId: 'cmd-1' };
    const fake = createFakeCommand<Increment>({ result: { ok: true } });

    await expect(fake(command)).resolves.toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).not.toBe(command);
    expect(fake.calls[0]).toEqual(command);
    expect(fake.calls[0]).not.toHaveProperty('streamId');
    expect(fake.calls[0]).not.toHaveProperty('events');
    expect(fake.lastCall).toEqual(command);

    fake.clear();
    expect(fake.calls).toEqual([]);
  });

  it('rejects with the configured error', async () => {
    const fake = createFakeCommand<Increment>({ error: new Error('timeout') });
    await expect(fake({ counterId: 'counter-1', by: 1, commandId: 'cmd-2' })).rejects.toThrow(
      'timeout',
    );
  });

  it('supports queued replies and rejects conflicting defaults', async () => {
    const fake = createFakeCommand<Increment>();
    fake.nextResult('ok').nextError(new Error('retry failed'));

    await expect(fake({ counterId: 'counter-1', by: 1, commandId: 'cmd-3' })).resolves.toBe('ok');
    await expect(fake({ counterId: 'counter-1', by: 1, commandId: 'cmd-3' })).rejects.toThrow(
      'retry failed',
    );

    expect(() => createFakeCommand({ result: 'ok', error: new Error('no') })).toThrow(
      /provide result or error/,
    );
  });
});

describe('createModuleTest', () => {
  it('runs a command reducer and a view without a server', () => {
    const test = createModuleTest(spacetimedb, { increment });
    const counterId = 'counter-unit-kit';
    const streamId = counterStreamId(counterId);

    test.tx((ctx) => {
      ctx.db.counterOwner.insert({ streamId, owner: ctx.sender });
    });

    test.call('increment', { counterId, by: 2, commandId: 'cmd-unit-kit' });

    expect(test.tx((ctx) => readStream(ctx, streamId).map((row) => row.version))).toEqual([1]);
    expect(test.tx((ctx) => readStream(ctx, streamId).map((row) => row.eventId))).toEqual([
      'inc-cmd-unit-kit',
    ]);
    expect(test.view(counterStream, { streamId })).toHaveLength(1);
  });

  it('uses the default auth unless a call overrides it', () => {
    const test = createModuleTest(spacetimedb, { increment });
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
