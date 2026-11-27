import { ConnectionId } from 'spacetimedb';
import { TestAuth } from 'spacetimedb/server/test-utils';
import { readStream } from 'stdb-es/server';
import { streamId as makeStreamId } from 'stdb-es';
import { createModuleTest, type ModuleTest } from 'stdb-es/testing';
import { spacetimedb } from '../../schema.js';
import { GOOGLE_CLIENT_ID, GOOGLE_ISSUER } from './config.js';
import { STREAM_PREFIXES, type CounterKind } from './constants.js';

export type PermissionsTest = ModuleTest<typeof spacetimedb>;
export type EventRow = {
  eventId: string;
  eventType: string;
  version: number;
  data: Record<string, unknown>;
};

function connectionIdFor(seed: string): ConnectionId {
  let hash = 2166136261;
  for (const character of seed) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  }
  return new ConnectionId(BigInt(hash));
}

function authFromPayload(payload: Record<string, unknown>): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify(payload),
    connectionIdFor(String(payload.sub ?? 'unknown')),
  );
}

export type GoogleAuthOptions = {
  sub: string;
  email: string;
  issuer?: string;
  audience?: string | string[];
};

/** Builds the JWT payload the SDK uses to derive a Google sender identity. */
export function googleAuth(options: GoogleAuthOptions): TestAuth {
  return authFromPayload({
    iss: options.issuer ?? GOOGLE_ISSUER,
    sub: options.sub,
    aud: options.audience ?? GOOGLE_CLIENT_ID,
    email: options.email,
  });
}

/** Returns the identity the SDK derives from a payload's `iss` and `sub`. */
export function identityOf(auth: TestAuth): string {
  const probe = createModuleTest(spacetimedb, {}, { auth });
  return probe.tx((ctx) => ctx.sender.toHexString());
}

/**
 * SpacetimeDB's saved client token is server-issued: it has a `spacetimedb`
 * audience and a `hex_identity` matching the sender instead of Google claims.
 */
export function anonymousReconnectAuth(sub = 'anonymous-sub'): TestAuth {
  const base = { iss: 'localhost', sub };
  const hexIdentity = identityOf(authFromPayload(base));
  return authFromPayload({
    ...base,
    aud: ['spacetimedb'],
    hex_identity: hexIdentity,
  });
}

export function streamFor(kind: CounterKind, identityHex: string): string {
  return makeStreamId(
    STREAM_PREFIXES[kind],
    kind === 'global' ? 'all' : identityHex,
  );
}

export function stateOf(test: PermissionsTest, stream: string) {
  return test.tx((ctx) => {
    const row = ctx.db.counterState.streamId.find(stream);
    return row
      ? {
          streamId: row.streamId,
          counterKind: row.counterKind,
          version: row.version,
          value: row.value,
          owner: row.owner?.toHexString(),
          ownerEmail: row.ownerEmail,
        }
      : undefined;
  });
}

export function eventsOf(test: PermissionsTest, stream: string): EventRow[] {
  return test.tx((ctx) =>
    readStream(ctx, stream).map((row) => ({
      eventId: row.eventId,
      eventType: row.eventType,
      version: row.version,
      data: JSON.parse(row.data) as Record<string, unknown>,
    })),
  );
}

export function stateRows(test: PermissionsTest) {
  return test.tx((ctx) =>
    [...ctx.db.counterState.iter()]
      .map((row) => ({
        counterKind: row.counterKind,
        value: row.value,
        ownerEmail: row.ownerEmail,
      }))
      .sort((a, b) => a.counterKind.localeCompare(b.counterKind)),
  );
}
