import { Identity } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import { createModuleTest } from 'stdb-es/testing';
import * as permissionsModule from '../../index.js';
import {
  eventsOf,
  googleAuth,
  identityOf,
  stateOf,
  stateRows,
  streamFor,
} from './test-support.js';

const { default: spacetimedb } = permissionsModule;
const GLOBAL_STREAM = streamFor('global', '');

describe('C1 global commands (offline)', () => {
  it('lets an anonymous sender increment, decrement, and reset the one stream', () => {
    const test = createModuleTest(spacetimedb, permissionsModule, {
      auth: TestAuth.internal(),
    });

    test.call('incrementGlobal', { by: 5, commandId: 'c1-inc' });
    test.call('decrementGlobal', { by: 2, commandId: 'c1-dec' });
    test.call('resetGlobal', { commandId: 'c1-reset' });

    expect(eventsOf(test, GLOBAL_STREAM)).toEqual([
      {
        eventId: `inc-${GLOBAL_STREAM}-c1-inc`,
        eventType: 'Incremented',
        version: 1,
        data: { kind: 'Incremented', by: 5 },
      },
      {
        eventId: `dec-${GLOBAL_STREAM}-c1-dec`,
        eventType: 'Decremented',
        version: 2,
        data: { kind: 'Decremented', by: 2 },
      },
      {
        eventId: `rst-${GLOBAL_STREAM}-c1-reset`,
        eventType: 'Reset',
        version: 3,
        data: { kind: 'Reset' },
      },
    ]);
    expect(stateOf(test, GLOBAL_STREAM)).toEqual({
      streamId: GLOBAL_STREAM,
      counterKind: 'global',
      version: 3,
      value: 0n,
      owner: undefined,
      ownerEmail: undefined,
    });
  });

  it('replays a repeated command id instead of appending twice', () => {
    const test = createModuleTest(spacetimedb, permissionsModule);
    const command = { by: 4, commandId: 'c1-retry' };

    test.call('incrementGlobal', command);
    test.call('incrementGlobal', command);

    expect(eventsOf(test, GLOBAL_STREAM)).toHaveLength(1);
    expect(stateOf(test, GLOBAL_STREAM)?.value).toBe(4n);
    expect(stateOf(test, GLOBAL_STREAM)?.version).toBe(1);
  });

  it('rejects invalid amounts and command ids before writing anything', () => {
    const test = createModuleTest(spacetimedb, permissionsModule);

    expect(() => test.call('incrementGlobal', { by: 0, commandId: 'zero' })).toThrow(
      /CMD_INVALID_COMMAND/,
    );
    expect(() => test.call('resetGlobal', { commandId: '' })).toThrow(/CMD_INVALID_COMMAND/);
    expect(() => test.call('resetGlobal', { commandId: 'bad id!' })).toThrow(
      /CMD_INVALID_COMMAND/,
    );
    expect(eventsOf(test, GLOBAL_STREAM)).toEqual([]);
    expect(stateRows(test)).toEqual([]);
  });
});

describe('C2/C3 owned commands (offline)', () => {
  it('lets a Google owner write both of their counters', () => {
    const auth = googleAuth({ sub: 'alice', email: 'alice@example.com' });
    const test = createModuleTest(spacetimedb, permissionsModule, { auth });
    const owner = identityOf(auth);
    const publicStream = streamFor('publicOwned', owner);
    const privateStream = streamFor('privateOwned', owner);

    test.call('incrementPublicMine', { by: 5, commandId: 'p-inc' });
    test.call('decrementPublicMine', { by: 2, commandId: 'p-dec' });
    test.call('resetPublicMine', { commandId: 'p-reset' });
    test.call('incrementPrivateMine', { by: 3, commandId: 's-inc' });
    test.call('decrementPrivateMine', { by: 1, commandId: 's-dec' });
    test.call('resetPrivateMine', { commandId: 's-reset' });

    expect(eventsOf(test, publicStream).map((event) => event.eventId)).toEqual([
      `inc-${publicStream}-p-inc`,
      `dec-${publicStream}-p-dec`,
      `rst-${publicStream}-p-reset`,
    ]);
    expect(eventsOf(test, privateStream).map((event) => event.eventId)).toEqual([
      `inc-${privateStream}-s-inc`,
      `dec-${privateStream}-s-dec`,
      `rst-${privateStream}-s-reset`,
    ]);
    expect(stateOf(test, publicStream)).toEqual({
      streamId: publicStream,
      counterKind: 'publicOwned',
      version: 3,
      value: 0n,
      owner,
      ownerEmail: 'alice@example.com',
    });
    expect(stateOf(test, privateStream)).toEqual({
      streamId: privateStream,
      counterKind: 'privateOwned',
      version: 3,
      value: 0n,
      owner,
      ownerEmail: 'alice@example.com',
    });
  });

  it('rejects anonymous writes to both owned counters', () => {
    const test = createModuleTest(spacetimedb, permissionsModule, {
      auth: TestAuth.internal(),
    });

    expect(() =>
      test.call('incrementPublicMine', { by: 1, commandId: 'anon-public' }),
    ).toThrow(/AUTH_UNAUTHENTICATED/);
    expect(() =>
      test.call('incrementPrivateMine', { by: 1, commandId: 'anon-private' }),
    ).toThrow(/AUTH_UNAUTHENTICATED/);
    expect(stateRows(test)).toEqual([]);
  });

  it('rejects Google-shaped tokens with the wrong issuer or audience', () => {
    const test = createModuleTest(spacetimedb, permissionsModule);
    const wrongIssuer = googleAuth({
      sub: 'wrong-issuer',
      email: 'wrong@example.com',
      issuer: 'https://accounts.example.com',
    });
    const wrongAudience = googleAuth({
      sub: 'wrong-audience',
      email: 'wrong@example.com',
      audience: 'another-client.apps.googleusercontent.com',
    });

    expect(() =>
      test.call(
        'incrementPublicMine',
        { by: 1, commandId: 'bad-issuer' },
        wrongIssuer,
      ),
    ).toThrow(/AUTH_INVALID_TOKEN/);
    expect(() =>
      test.call(
        'incrementPrivateMine',
        { by: 1, commandId: 'bad-audience' },
        wrongAudience,
      ),
    ).toThrow(/AUTH_INVALID_TOKEN/);
    expect(stateRows(test)).toEqual([]);
  });

  it('enforces the owner row even when the derived stream already exists', () => {
    const auth = googleAuth({ sub: 'alice', email: 'alice@example.com' });
    const test = createModuleTest(spacetimedb, permissionsModule, { auth });
    const stream = streamFor('publicOwned', identityOf(auth));

    test.tx((ctx) => {
      ctx.db.counterOwner.insert({
        streamId: stream,
        counterKind: 'publicOwned',
        owner: new Identity('11'.repeat(32)),
      });
    });

    expect(() =>
      test.call('incrementPublicMine', { by: 1, commandId: 'owner-check' }),
    ).toThrow(/CMD_UNAUTHORIZED/);
    expect(eventsOf(test, stream)).toEqual([]);
    expect(stateOf(test, stream)).toBeUndefined();
  });

  it('keeps the same command id independent for different owners', () => {
    const alice = googleAuth({ sub: 'alice', email: 'alice@example.com' });
    const bob = googleAuth({ sub: 'bob', email: 'bob@example.com' });
    const test = createModuleTest(spacetimedb, permissionsModule);
    const aliceStream = streamFor('publicOwned', identityOf(alice));
    const bobStream = streamFor('publicOwned', identityOf(bob));
    const command = { by: 1, commandId: 'shared-command-id' };

    test.call('incrementPublicMine', command, alice);
    test.call('incrementPublicMine', command, bob);

    expect(aliceStream).not.toBe(bobStream);
    expect(eventsOf(test, aliceStream)).toHaveLength(1);
    expect(eventsOf(test, bobStream)).toHaveLength(1);
    expect(eventsOf(test, aliceStream)[0]?.eventId).toBe(
      `inc-${aliceStream}-shared-command-id`,
    );
    expect(eventsOf(test, bobStream)[0]?.eventId).toBe(
      `inc-${bobStream}-shared-command-id`,
    );
  });
});
