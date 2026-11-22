/** Maximum event id length enforced by the event store. */
const MAX_EVENT_ID_LENGTH = 128;

/**
 * Builds deterministic event ids for fixtures and retry tests.
 *
 * `ids('evt', 3)` returns `['evt-1', 'evt-2', 'evt-3']`. The same inputs always
 * produce the same ids, so replaying a server-side fixture exercises the append
 * dedupe path.
 */
export function ids(prefix: string, count: number): string[] {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new Error('ids: prefix must be a non-empty string');
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('ids: count must be a positive safe integer');
  }

  const longest = `${prefix}-${count}`;
  if (longest.length > MAX_EVENT_ID_LENGTH) {
    throw new Error(`ids: generated event id exceeds ${MAX_EVENT_ID_LENGTH} characters`);
  }

  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}
