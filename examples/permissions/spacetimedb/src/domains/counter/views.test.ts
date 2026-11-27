import { TestAuth } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import { createModuleTest } from 'stdb-es/testing';
import * as permissionsModule from '../../index.js';
import {
  googleAuth,
  identityOf,
  streamFor,
} from './test-support.js';

const {
  default: spacetimedb,
  publicSummary,
  privateSummary,
  publicEvents,
  privateEvents,
} = permissionsModule;
const GLOBAL_STREAM = streamFor('global', '');

function twoUsers() {
  const alice = googleAuth({ sub: 'alice', email: 'alice@example.com' });
  const bob = googleAuth({ sub: 'bob', email: 'bob@example.com' });
  const test = createModuleTest(spacetimedb, permissionsModule);
  const aliceIdentity = identityOf(alice);
  const bobIdentity = identityOf(bob);

  test.call('onConnect', undefined, alice);
  test.call('onConnect', undefined, bob);

  return {
    test,
    alice,
    bob,
    aliceIdentity,
    bobIdentity,
    alicePublic: streamFor('publicOwned', aliceIdentity),
    alicePrivate: streamFor('privateOwned', aliceIdentity),
    bobPrivate: streamFor('privateOwned', bobIdentity),
  };
}

describe('read-model views (offline)', () => {
  it('publishes C1 and every C2 row with owner email, but never C3', () => {
    const { test, alice, aliceIdentity, bobIdentity } = twoUsers();
    test.call('incrementPrivateMine', { by: 7, commandId: 'hidden-c3' }, alice);

    const rows = test
      .anonymousView(publicSummary, undefined)
      .map((row) => ({
        counterKind: row.counterKind,
        value: row.value,
        owner: row.owner?.toHexString(),
        ownerEmail: row.ownerEmail,
      }))
      .sort(
        (a, b) =>
          a.counterKind.localeCompare(b.counterKind) ||
          (a.ownerEmail ?? '').localeCompare(b.ownerEmail ?? ''),
      );

    expect(rows).toEqual([
      {
        counterKind: 'global',
        value: 0n,
        owner: undefined,
        ownerEmail: undefined,
      },
      {
        counterKind: 'publicOwned',
        value: 0n,
        owner: aliceIdentity,
        ownerEmail: 'alice@example.com',
      },
      {
        counterKind: 'publicOwned',
        value: 0n,
        owner: bobIdentity,
        ownerEmail: 'bob@example.com',
      },
    ]);
    expect(rows.some((row) => row.counterKind === 'privateOwned')).toBe(false);
  });

  it('returns only the caller’s C3 row from the private summary', () => {
    const { test, alice, bob, alicePrivate, bobPrivate } = twoUsers();

    const aliceRows = test.view(privateSummary, undefined, alice);
    const bobRows = test.view(privateSummary, undefined, bob);

    expect(aliceRows.map((row) => row.streamId)).toEqual([alicePrivate]);
    expect(aliceRows[0]?.ownerEmail).toBe('alice@example.com');
    expect(bobRows.map((row) => row.streamId)).toEqual([bobPrivate]);
    expect(bobRows[0]?.ownerEmail).toBe('bob@example.com');
  });

  it('allows public event history for C1/C2 but not for C3', () => {
    const { test, alice, alicePublic, alicePrivate } = twoUsers();
    test.call(
      'incrementGlobal',
      { by: 1, commandId: 'global-event' },
      TestAuth.internal(),
    );
    test.call('incrementPublicMine', { by: 2, commandId: 'public-event' }, alice);
    test.call('incrementPrivateMine', { by: 3, commandId: 'private-event' }, alice);

    expect(
      test.anonymousView(publicEvents, { streamId: GLOBAL_STREAM }).map((row) => row.version),
    ).toEqual([1]);
    expect(
      test.anonymousView(publicEvents, { streamId: alicePublic }).map((row) => row.version),
    ).toEqual([1]);
    expect(test.anonymousView(publicEvents, { streamId: alicePrivate })).toEqual([]);
  });

  it('allows private event history only for the owner’s C3 stream', () => {
    const { test, alice, bob, alicePrivate, bobPrivate } = twoUsers();
    test.call('incrementPrivateMine', { by: 3, commandId: 'owner-private-event' }, alice);

    expect(
      test.view(privateEvents, { streamId: alicePrivate }, alice).map((row) => row.version),
    ).toEqual([1]);
    expect(test.view(privateEvents, { streamId: alicePrivate }, bob)).toEqual([]);
    expect(test.view(privateEvents, { streamId: bobPrivate }, alice)).toEqual([]);
    expect(test.view(privateEvents, { streamId: GLOBAL_STREAM }, alice)).toEqual([]);
  });
});
