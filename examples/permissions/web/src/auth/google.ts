export type GoogleProfile = {
  name?: string;
  email?: string;
  picture?: string;
};

/**
 * Reads display fields from a Google ID token. This is for the reference UI
 * only; the module validates the token and derives identity from its claims.
 */
export function decodeCredential(credential: string): GoogleProfile | null {
  const payload = credential.split('.')[1];
  if (!payload) return null;

  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      email: typeof parsed.email === 'string' ? parsed.email : undefined,
      picture: typeof parsed.picture === 'string' ? parsed.picture : undefined,
    };
  } catch {
    return null;
  }
}
