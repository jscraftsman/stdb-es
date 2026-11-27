import { Identity } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import { createModuleTest } from 'stdb-es/testing';
import * as permissionsModule from '../../index.js';
import type { Context } from '../../schema.js';
import { GOOGLE_CLIENT_ID, GOOGLE_ISSUER } from './config.js';
import { hasGoogleIdentity } from './auth.js';
import {
  anonymousReconnectAuth,
  eventsOf,
  googleAuth,
  identityOf,
  stateRows,
  streamFor,
} from './test-support.js';

const { default: spacetimedb } = permissionsModule;

function authContext(overrides: {
  issuer?: string;
  audience?: string[];
  subject?: string;
  jwtIdentity?: Identity;
  sender?: Identity;
} = {}): Context {
  const sender = overrides.sender ?? new Identity('22'.repeat(32));
  return {
    sender,
    senderAuth: {
      hasJWT: true,
      jwt: {
        issuer: overrides.issuer ?? GOOGLE_ISSUER,
        audience: overrides.audience ?? [GOOGLE_CLIENT_ID],
        subject: overrides.subject ?? 'google-sub',
        identity: overrides.jwtIdentity ?? sender,
        fullPayload: {},
      },
    },
  } as unknown as Context;
}

describe('connection token validation (offline)', () => {
  it('allows a first anonymous connection and creates only the global row', () => {
    const test = createModuleTest(spacetimedb, permissionsModule, {
      auth: TestAuth.internal(),
    });

    test.call('onConnect');

    expect(stateRows(test)).toEqual([
      { counterKind: 'global', value: 0n, ownerEmail: undefined },
    ]);
    expect(eventsOf(test, 'global-all')).toHaveLength(0);
  });

  it('accepts a saved server-issued token as anonymous without owned rows', () => {
    const auth = anonymousReconnectAuth();
    const test = createModuleTest(spacetimedb, permissionsModule, { auth });

    expect(() => test.call('onConnect')).not.toThrow();
    expect(stateRows(test)).toEqual([
      { counterKind: 'global', value: 0n, ownerEmail: undefined },
    ]);
    expect(() =>
      test.call('incrementPublicMine', { by: 1, commandId: 'anon-owned-write' }),
    ).toThrow(/AUTH_INVALID_TOKEN/);
  });

  it('rejects a non-Google token that is not a saved anonymous token', () => {
    const test = createModuleTest(spacetimedb, permissionsModule);
    const badAuth = googleAuth({
      sub: 'intruder',
      email: 'intruder@example.com',
      issuer: 'https://accounts.example.com',
    });

    expect(() => test.call('onConnect', undefined, badAuth)).toThrow(/AUTH_INVALID_TOKEN/);
    expect(stateRows(test)).toEqual([]);
  });

  it('rejects a Google-shaped token for another OAuth client', () => {
    const test = createModuleTest(spacetimedb, permissionsModule);
    const badAuth = googleAuth({
      sub: 'wrong-audience',
      email: 'wrong@example.com',
      audience: 'another-client.apps.googleusercontent.com',
    });

    expect(() => test.call('onConnect', undefined, badAuth)).toThrow(/AUTH_INVALID_TOKEN/);
    expect(stateRows(test)).toEqual([]);
  });

  it('bootstraps zero-valued C2/C3 rows for a Google identity, idempotently', () => {
    const auth = googleAuth({ sub: 'alice', email: 'alice@example.com' });
    const test = createModuleTest(spacetimedb, permissionsModule, { auth });
    const owner = identityOf(auth);

    test.call('onConnect');
    test.call('onConnect');

    const rows = test.tx((ctx) =>
      [...ctx.db.counterState.iter()]
        .map((row) => ({
          counterKind: row.counterKind,
          version: row.version,
          value: row.value,
          owner: row.owner?.toHexString(),
          ownerEmail: row.ownerEmail,
        }))
        .sort((a, b) => a.counterKind.localeCompare(b.counterKind)),
    );
    expect(rows).toEqual([
      {
        counterKind: 'global',
        version: 0,
        value: 0n,
        owner: undefined,
        ownerEmail: undefined,
      },
      {
        counterKind: 'privateOwned',
        version: 0,
        value: 0n,
        owner,
        ownerEmail: 'alice@example.com',
      },
      {
        counterKind: 'publicOwned',
        version: 0,
        value: 0n,
        owner,
        ownerEmail: 'alice@example.com',
      },
    ]);
    expect(
      eventsOf(test, streamFor('privateOwned', owner)).length +
        eventsOf(test, streamFor('publicOwned', owner)).length,
    ).toBe(0);
  });

  it('requires a subject and a JWT identity matching the sender', () => {
    expect(hasGoogleIdentity(authContext())).toBe(true);
    expect(hasGoogleIdentity(authContext({ subject: '' }))).toBe(false);
    expect(
      hasGoogleIdentity(
        authContext({ jwtIdentity: new Identity('33'.repeat(32)) }),
      ),
    ).toBe(false);
  });
});
