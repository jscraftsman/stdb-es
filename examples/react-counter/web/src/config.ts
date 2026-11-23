export const SPACETIMEDB_URI = import.meta.env.VITE_STDB_URI ?? 'ws://localhost:3000';
export const DATABASE_NAME =
  import.meta.env.VITE_STDB_DATABASE ?? 'stdb-es-counter-with-frontend';

const TOKEN_KEY = `${SPACETIMEDB_URI}/${DATABASE_NAME}/auth_token`;

export function readToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined;
}

export function writeToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
