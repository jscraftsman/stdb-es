import type { EncodedEvent } from '../server/index.js';
import { ids } from './ids.js';

/** Builds one wire event with a JSON payload. */
export function wireEvent(eventId: string, eventType: string, payload: unknown): EncodedEvent {
  return { eventId, eventType, data: JSON.stringify(payload) };
}

/**
 * Builds a batch of wire events from `[eventType, payload]` pairs.
 *
 * Event ids are `${prefix}-1..n`, so retries of the same fixture are
 * deduplicated exactly as a real client retry would be.
 */
export function wireEvents(
  prefix: string,
  events: ReadonlyArray<readonly [eventType: string, payload: unknown]>,
): EncodedEvent[] {
  if (events.length === 0) return [];
  const eventIds = ids(prefix, events.length);
  return events.map(([eventType, payload], index) =>
    wireEvent(eventIds[index]!, eventType, payload),
  );
}

/** Versions in read order, for compact assertions. */
export function versions(rows: ReadonlyArray<{ version: number }>): number[] {
  return rows.map((row) => row.version);
}
