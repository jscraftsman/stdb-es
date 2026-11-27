import { describe, expect, it } from 'vitest';
import { createFakeCommand } from 'stdb-es/testing';
import { makePermissionsCommands, type PermissionsCommands } from './api.js';

function fakes() {
  return {
    incrementGlobal: createFakeCommand<PermissionsCommands['incrementGlobal']>(),
    decrementGlobal: createFakeCommand<PermissionsCommands['decrementGlobal']>(),
    resetGlobal: createFakeCommand<PermissionsCommands['resetGlobal']>(),
    incrementPublicMine: createFakeCommand<PermissionsCommands['incrementPublicMine']>(),
    decrementPublicMine: createFakeCommand<PermissionsCommands['decrementPublicMine']>(),
    resetPublicMine: createFakeCommand<PermissionsCommands['resetPublicMine']>(),
    incrementPrivateMine: createFakeCommand<PermissionsCommands['incrementPrivateMine']>(),
    decrementPrivateMine: createFakeCommand<PermissionsCommands['decrementPrivateMine']>(),
    resetPrivateMine: createFakeCommand<PermissionsCommands['resetPrivateMine']>(),
  };
}

describe('permissions client commands (offline)', () => {
  it('sends intent-only payloads with generated ids for all nine reducers', async () => {
    const calls = fakes();
    let nextId = 0;
    const commands = makePermissionsCommands(calls, {
      newCommandId: () => `cmd-${++nextId}`,
    });

    await commands.sendNew('incrementGlobal', { by: 5 });
    await commands.sendNew('decrementGlobal', { by: 2 });
    await commands.sendNew('resetGlobal', {});
    await commands.sendNew('incrementPublicMine', { by: 3 });
    await commands.sendNew('decrementPublicMine', { by: 1 });
    await commands.sendNew('resetPublicMine', {});
    await commands.sendNew('incrementPrivateMine', { by: 7 });
    await commands.sendNew('decrementPrivateMine', { by: 4 });
    await commands.sendNew('resetPrivateMine', {});

    expect(calls.incrementGlobal.lastCall).toEqual({ by: 5, commandId: 'cmd-1' });
    expect(calls.decrementGlobal.lastCall).toEqual({ by: 2, commandId: 'cmd-2' });
    expect(calls.resetGlobal.lastCall).toEqual({ commandId: 'cmd-3' });
    expect(calls.incrementPublicMine.lastCall).toEqual({ by: 3, commandId: 'cmd-4' });
    expect(calls.decrementPublicMine.lastCall).toEqual({ by: 1, commandId: 'cmd-5' });
    expect(calls.resetPublicMine.lastCall).toEqual({ commandId: 'cmd-6' });
    expect(calls.incrementPrivateMine.lastCall).toEqual({ by: 7, commandId: 'cmd-7' });
    expect(calls.decrementPrivateMine.lastCall).toEqual({ by: 4, commandId: 'cmd-8' });
    expect(calls.resetPrivateMine.lastCall).toEqual({ commandId: 'cmd-9' });

    for (const fake of Object.values(calls)) {
      const payload = JSON.stringify(fake.lastCall);
      expect(payload).not.toContain('streamId');
      expect(payload).not.toContain('event');
      expect(payload).not.toContain('expectedVersion');
      expect(payload).not.toContain('owner');
    }
  });

  it('retries the exact envelope after a timeout', async () => {
    const calls = fakes();
    const commands = makePermissionsCommands(calls, {
      newCommandId: () => 'retry-1',
    });
    calls.incrementGlobal.nextError(new Error('timeout')).nextResult(undefined);

    const envelope = await commands
      .sendNew('incrementGlobal', { by: 3 })
      .catch((cause) => {
        expect(cause).toBeInstanceOf(Error);
        return calls.incrementGlobal.lastCall!;
      });

    await commands.send('incrementGlobal', envelope);

    expect(calls.incrementGlobal.calls).toHaveLength(2);
    expect(calls.incrementGlobal.calls[0]).toEqual(calls.incrementGlobal.calls[1]);
    expect(envelope.commandId).toBe('retry-1');
  });

  it('propagates a rejected command from the generated binding', async () => {
    const calls = fakes();
    calls.resetPublicMine.nextError(new Error('CMD_UNAUTHORIZED: not the owner'));
    const commands = makePermissionsCommands(calls);

    await expect(commands.sendNew('resetPublicMine', {})).rejects.toThrow(
      /CMD_UNAUTHORIZED/,
    );
  });
});
