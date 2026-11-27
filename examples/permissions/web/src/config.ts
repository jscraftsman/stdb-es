export const SPACETIMEDB_URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const DATABASE_NAME = import.meta.env.VITE_STDB_DATABASE ?? 'stdb-es-permissions';

/** Public OAuth client id. It must match the module's configured audience. */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ??  '407348267584-b9dmdsvdbuiohlr5l459lbib0tkvbfed.apps.googleusercontent.com';

const TOKEN_KEY = `${SPACETIMEDB_URI}/${DATABASE_NAME}/auth_token`;

export function readToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function writeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
