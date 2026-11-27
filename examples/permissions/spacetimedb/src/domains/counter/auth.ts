import type { JwtClaims } from 'spacetimedb/server';
import type { Context } from '../../schema.js';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_ISSUER,
  SPACETIMEDB_TOKEN_AUDIENCE,
} from './config.js';

/**
 * SpacetimeDB validates the token signature and expiry, but it does not check
 * `aud`. Google identity is derived from `iss` + `sub`, so those two claims and
 * this application's client id are the authorization contract for owned data.
 */
export function hasGoogleIdentity(ctx: Context): boolean {
  const claims = ctx.senderAuth.jwt;
  return Boolean(
    ctx.senderAuth.hasJWT &&
      claims &&
      claims.issuer === GOOGLE_ISSUER &&
      claims.audience.includes(GOOGLE_CLIENT_ID) &&
      claims.subject &&
      claims.identity.equals(ctx.sender),
  );
}

function requireGoogleClaims(ctx: Context): JwtClaims {
  if (!ctx.senderAuth.hasJWT || !hasGoogleIdentity(ctx)) {
    if (!ctx.senderAuth.hasJWT) {
      throw new Error('AUTH_UNAUTHENTICATED: Google sign-in is required');
    }
    throw new Error('AUTH_INVALID_TOKEN: expected a Google ID token for this application');
  }
  return ctx.senderAuth.jwt!;
}

/**
 * Anonymous clients receive a SpacetimeDB server-issued token. It is not a
 * Google token, but it must be accepted on reconnect so anonymous identity is
 * stable. It carries `aud: ["spacetimedb"]` and the sender's hex identity.
 */
function isServerIssuedToken(ctx: Context): boolean {
  const claims = ctx.senderAuth.jwt;
  if (!claims || !claims.identity.equals(ctx.sender)) return false;
  if (!claims.audience.includes(SPACETIMEDB_TOKEN_AUDIENCE)) return false;
  const hexIdentity = claims.fullPayload.hex_identity;
  return typeof hexIdentity === 'string' && hexIdentity === ctx.sender.toHexString();
}

/** Requires a Google ID token for owned-counter writes. */
export function assertGoogleSender(ctx: Context): void {
  requireGoogleClaims(ctx);
}

/** Returns the verified token's email for display in the public read model. */
export function googleEmail(ctx: Context): string | undefined {
  const email = requireGoogleClaims(ctx).fullPayload.email;
  return typeof email === 'string' && email.length > 0 ? email : undefined;
}

/**
 * Allows first-time anonymous connections and saved server-issued anonymous
 * tokens. Any other supplied token must be a Google ID token for this app.
 */
export function assertValidConnectionToken(ctx: Context): void {
  if (!ctx.senderAuth.hasJWT) return;
  if (!ctx.senderAuth.jwt) {
    throw new Error('AUTH_INVALID_TOKEN: expected a Google ID token for this application');
  }
  if (isServerIssuedToken(ctx)) return;
  if (!hasGoogleIdentity(ctx)) {
    throw new Error('AUTH_INVALID_TOKEN: expected a Google ID token for this application');
  }
}
