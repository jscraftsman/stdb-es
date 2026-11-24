import { describe, expect, it } from 'vitest';
import { createFakeCommand } from 'stdb-es/testing';
import { makeCounterCommands, type CounterCommands } from './api.js';
import { COUNTER_ID } from './ids.js';

function fakes() {
  return {
    increment: createFakeCommand<CounterCommands['increment']>(),
    decrement: createFakeCommand<CounterCommands['decrement']>(),
    reset: createFakeCommand<CounterCommands['reset']>(),
  };
}

describe('counter client (offline)', () => {
  it('sends intent only with a generated command id', async () => {
    const calls = fakes();
    const commands = makeCounterCommands(calls, { newCommandId: () => 'client-1' });

    await commands.sendNew('increment', { counterId: COUNTER_ID, by: 5 });
    await commands.sendNew('decrement', { counterId: COUNTER_ID, by: 2 });
    await commands.sendNew('reset', { counterId: COUNTER_ID }, { commandId: 'client-reset' });

    expect(calls.increment.lastCall).toEqual({
      counterId: COUNTER_ID,
      by: 5,
      commandId: 'client-1',
    });
    expect(calls.decrement.lastCall).toEqual({
      counterId: COUNTER_ID,
      by: 2,
      commandId: 'client-1',
    });
    expect(calls.reset.lastCall).toEqual({ counterId: COUNTER_ID, commandId: 'client-reset' });
    for (const fake of Object.values(calls)) {
      expect(JSON.stringify(fake.lastCall)).not.toContain('streamId');
      expect(JSON.stringify(fake.lastCall)).not.toContain('event');
      expect(JSON.stringify(fake.lastCall)).not.toContain('expectedVersion');
    }
  });

  it('retries the exact command envelope after a timeout', async () => {
    const calls = fakes();
    const commands = makeCounterCommands(calls, { newCommandId: () => 'retry-1' });

    calls.increment.nextError(new Error('timeout')).nextResult(undefined);

    const envelope = await commands.sendNew('increment', {
      counterId: COUNTER_ID,
      by: 3,
    }).catch((cause) => {
      expect(cause).toBeInstanceOf(Error);
      // `sendNew` throws before returning, so recover the prepared envelope
      // from the recorded call for a verbatim retry.
      return calls.increment.lastCall!;
    });

    await commands.send('increment', envelope);

    expect(calls.increment.calls).toHaveLength(2);
    expect(calls.increment.calls[0]).toEqual(calls.increment.calls[1]);
    expect(calls.increment.lastCall?.commandId).toBe('retry-1');
  });

  it('propagates a rejected command from the generated binding', async () => {
    const calls = fakes();
    calls.reset.nextError(new Error('CMD_UNAUTHORIZED: sender does not own this counter'));
    const commands = makeCounterCommands(calls);

    await expect(
      commands.sendNew('reset', { counterId: COUNTER_ID }, { commandId: 'rejected' }),
    ).rejects.toThrow(/CMD_UNAUTHORIZED/);
  });
});
