import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAuthTokens,
  DATABASE_NAME,
  readAnonymousToken,
  readGoogleCredential,
  selectConnectionToken,
  shouldPersistAnonymousToken,
  SPACETIMEDB_URI,
  writeAnonymousToken,
  writeGoogleCredential,
} from './config.js';

class MemoryStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
});

describe('permissions auth token storage (offline)', () => {
  it('keeps the Google credential and anonymous token in separate keys', () => {
    writeGoogleCredential('google-id-token');
    writeAnonymousToken('spacetime-token');

    expect(readGoogleCredential()).toBe('google-id-token');
    expect(readAnonymousToken()).toBe('spacetime-token');

    const prefix = `${SPACETIMEDB_URI}/${DATABASE_NAME}`;
    const keys = [localStorage.key(0), localStorage.key(1)].sort();
    expect(keys).toEqual(
      [`${prefix}/anonymous_auth_token`, `${prefix}/google_credential`].sort(),
    );
  });

  it('does not treat a saved anonymous token as a sign-in', () => {
    writeAnonymousToken('spacetime-token');

    expect(readGoogleCredential()).toBeUndefined();
    expect(readAnonymousToken()).toBe('spacetime-token');
  });

  it('clears both tokens on sign-out', () => {
    writeGoogleCredential('google-id-token');
    writeAnonymousToken('spacetime-token');

    clearAuthTokens();

    expect(readGoogleCredential()).toBeUndefined();
    expect(readAnonymousToken()).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('selects the Google token first and persists connection tokens only while anonymous', () => {
    expect(selectConnectionToken('google-id-token', 'spacetime-token')).toBe(
      'google-id-token',
    );
    expect(selectConnectionToken(undefined, 'spacetime-token')).toBe('spacetime-token');
    expect(selectConnectionToken(undefined, undefined)).toBeUndefined();
    expect(shouldPersistAnonymousToken(undefined)).toBe(true);
    expect(shouldPersistAnonymousToken('google-id-token')).toBe(false);
  });
});
