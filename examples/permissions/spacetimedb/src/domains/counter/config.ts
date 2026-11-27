/**
 * Expected Google ID token claims.
 *
 * Replace `GOOGLE_CLIENT_ID` with the Web application OAuth client id created in
 * the Google Cloud Console. It is a public identifier, not a secret, and must
 * match `VITE_GOOGLE_CLIENT_ID` in the reference client.
 */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_CLIENT_ID = '407348267584-b9dmdsvdbuiohlr5l459lbib0tkvbfed.apps.googleusercontent.com';

/** Audience on SpacetimeDB's own tokens for anonymous client identities. */
export const SPACETIMEDB_TOKEN_AUDIENCE = 'spacetimedb';
