export const SPACETIMEDB_URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const DATABASE_NAME = import.meta.env.VITE_STDB_DATABASE ?? 'stdb-es-permissions';

/** Public OAuth client id. It must match the module's configured audience. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ??  '407348267584-b9dmdsvdbuiohlr5l459lbib0tkvbfed.apps.googleusercontent.com';

const STORAGE_PREFIX = `${SPACETIMEDB_URI}/${DATABASE_NAME}`;
const GOOGLE_CREDENTIAL_KEY = `${STORAGE_PREFIX}/google_credential`;
const ANONYMOUS_TOKEN_KEY = `${STORAGE_PREFIX}/anonymous_auth_token`;

/**
 * The Google ID token is the only credential that represents a signed-in user.
 * SpacetimeDB also issues a connection token for anonymous clients; keeping it
 * in a separate slot prevents an anonymous visit from looking like a sign-in.
 */
export function readGoogleCredential(): string | undefined {
  return localStorage.getItem(GOOGLE_CREDENTIAL_KEY) ?? undefined;
}

export function writeGoogleCredential(credential: string): void {
  localStorage.setItem(GOOGLE_CREDENTIAL_KEY, credential);
}

/** Reuses the anonymous identity across reloads while no Google account is signed in. */
export function readAnonymousToken(): string | undefined {
  return localStorage.getItem(ANONYMOUS_TOKEN_KEY) ?? undefined;
}

export function writeAnonymousToken(token: string): void {
  localStorage.setItem(ANONYMOUS_TOKEN_KEY, token);
}

export function clearAuthTokens(): void {
  localStorage.removeItem(GOOGLE_CREDENTIAL_KEY);
  localStorage.removeItem(ANONYMOUS_TOKEN_KEY);
}

/** Chooses the credential used to build the SpacetimeDB connection. */
export function selectConnectionToken(
  googleCredential: string | undefined,
  anonymousToken: string | undefined,
): string | undefined {
  return googleCredential ?? anonymousToken;
}

/** Only anonymous connections may persist the server-issued connection token. */
export function shouldPersistAnonymousToken(
  googleCredential: string | undefined,
): boolean {
  return googleCredential === undefined;
}
