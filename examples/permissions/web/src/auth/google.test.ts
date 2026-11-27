import { describe, expect, it } from 'vitest';
import { decodeCredential } from './google.js';

function credential(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${encoded}.signature`;
}

describe('Google credential decoding (offline)', () => {
  it('reads only display fields from the ID token payload', () => {
    const profile = decodeCredential(
      credential({
        sub: 'google-sub',
        email: 'alice@example.com',
        name: 'Alice Example',
        picture: 'https://example.com/alice.png',
      }),
    );

    expect(profile).toEqual({
      name: 'Alice Example',
      email: 'alice@example.com',
      picture: 'https://example.com/alice.png',
    });
  });

  it('returns null for malformed or non-string display fields', () => {
    expect(decodeCredential('')).toBeNull();
    expect(decodeCredential('not-a-token')).toBeNull();
    expect(decodeCredential('header.%.signature')).toBeNull();
    expect(decodeCredential(credential({ email: 42 }))).toEqual({
      name: undefined,
      email: undefined,
      picture: undefined,
    });
  });
});
