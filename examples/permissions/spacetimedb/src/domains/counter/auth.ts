import type { Context } from '../../schema.js';
import { GOOGLE_CLIENT_ID, GOOGLE_ISSUER } from './config.js';

/**
 * SpacetimeDB validates the token signature and expiry, but it does not check
 * `aud`. Google identity is derived from `iss` + `sub`, so those two claims and
 * this application's client id are the authorization contract.
 */
function requireGoogleClaims(ctx: Context) {
  if (!ctx.senderAuth.hasJWT) {
    throw new Error('AUTH_UNAUTHENTICATED: Google sign-in is required');
  }

  const claims = ctx.senderAuth.jwt;
  if (
    !claims ||
    claims.issuer !== GOOGLE_ISSUER ||
    !claims.audience.includes(GOOGLE_CLIENT_ID) ||
    !claims.subject ||
    !claims.identity.equals(ctx.sender)
  ) {
    throw new Error('AUTH_INVALID_TOKEN: expected a Google ID token for this application');
  }

  return claims;
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

/** Anonymous connections stay allowed; a supplied token must still be correct. */
export function assertValidGoogleTokenIfPresent(ctx: Context): void {
  if (!ctx.senderAuth.hasJWT) return;
  requireGoogleClaims(ctx);
}
