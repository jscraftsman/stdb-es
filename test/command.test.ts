import { describe, expect, it } from 'vitest';
import {
  createCommandClient,
  newCommandId,
  withCommandId,
  type CommandEnvelope,
} from '../src/client/index.js';

type Commands = {
  increment: { counterId: string; by: number };
  reset: { counterId: string };
};

function bind() {
  const sent: Array<CommandEnvelope<Commands[keyof Commands]>> = [];
  const calls = {
    increment: async (command: CommandEnvelope<Commands['increment']>) => {
      sent.push(command);
    },
    reset: async (command: CommandEnvelope<Commands['reset']>) => {
      sent.push(command);
    },
  };
  return { calls, sent };
}

describe('newCommandId', () => {
  it('generates distinct idempotency keys', () => {
    expect(newCommandId()).not.toBe(newCommandId());
  });
});

describe('withCommandId', () => {
  it('adds a key without changing the command payload', () => {
    const command = { counterId: 'counter-1', by: 2 };
    const envelope = withCommandId(command, { commandId: 'cmd-1' });

    expect(envelope).toEqual({ counterId: 'counter-1', by: 2, commandId: 'cmd-1' });
    expect(command).toEqual({ counterId: 'counter-1', by: 2 });
  });

  it('preserves an existing key so a command can be retried verbatim', () => {
    const first = withCommandId({ counterId: 'counter-1' }, { commandId: 'cmd-1' });
    expect(withCommandId(first)).toEqual(first);
  });

  it('uses an injected generator when no key is supplied', () => {
    let next = 0;
    const envelope = withCommandId(
      { counterId: 'counter-1' },
      { newCommandId: () => `generated-${++next}` },
    );
    expect(envelope.commandId).toBe('generated-1');
  });
});

describe('createCommandClient', () => {
  it('sends intent only and returns the envelope for retries', async () => {
    const { calls, sent } = bind();
    const client = createCommandClient<Commands>(calls, {
      newCommandId: (() => {
        let next = 0;
        return () => `cmd-${++next}`;
      })(),
    });

    const envelope = await client.sendNew('increment', { counterId: 'counter-1', by: 3 });

    expect(envelope).toEqual({ counterId: 'counter-1', by: 3, commandId: 'cmd-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(envelope);

    await client.send('increment', envelope);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(envelope);
  });

  it('prepares without dispatching', async () => {
    const { calls, sent } = bind();
    const client = createCommandClient<Commands>(calls);

    const prepared = client.prepare('reset', { counterId: 'counter-2' }, { commandId: 'cmd-9' });

    expect(prepared.commandId).toBe('cmd-9');
    expect(sent).toHaveLength(0);
  });

  it('propagates reducer failures', async () => {
    const { calls } = bind();
    calls.reset = async () => {
      throw new Error('ES_EXPECTED_VERSION_MISMATCH');
    };
    const client = createCommandClient<Commands>(calls, { newCommandId: () => 'cmd-1' });

    await expect(client.sendNew('reset', { counterId: 'counter-2' })).rejects.toThrow(
      'ES_EXPECTED_VERSION_MISMATCH',
    );
  });
});
