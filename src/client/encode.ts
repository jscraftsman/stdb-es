import { ES_ERROR } from '../errors.js';
import type { EncodedEvent } from '../server/protocol.js';

/** Minimal client-side view of an `es_event` row delivered by a view. */
export type StoredEventRow = {
  eventId: string;
  position: bigint;
  streamId: string;
  streamType: string;
  version: number;
  eventType: string;
  data: string;
  metadata?: string | null;
  createdAtMicros?: bigint;
};

/** A decoded event row: the envelope plus the rehydrated domain event. */
export type DecodedEventRow<TEvent> = Omit<StoredEventRow, 'data'> & {
  event: TEvent;
};

/**
 * Codec for one event type.
 *
 * `upgrade` is the escape hatch for schema evolution: old rows are upgraded to
 * the current storage shape before `decode` runs, so the domain union stays
 * clean and old events never crash a client.
 */
export type EventDefinition<TEvent, TPayload = unknown> = {
  encode: (event: TEvent) => TPayload;
  decode: (payload: TPayload) => TEvent;
  upgrade?: (payload: unknown) => TPayload;
};

export type EventRegistry<TEvent> = {
  /** Returns the event type stored in `es_event.event_type`. */
  typeOf: (event: TEvent) => string;
  definitions: Readonly<Record<string, EventDefinition<TEvent, any>>>;
};

/**
 * Builds an event registry.
 *
 * The registry is client-side only: the server treats payloads as opaque JSON,
 * so adding an event type never requires a migration. What it does buy is a
 * single place to encode, upgrade and decode, shared by every client.
 */
export function createEventRegistry<TEvent>(input: {
  typeOf: (event: TEvent) => string;
  events: Record<string, EventDefinition<TEvent, any>>;
}): EventRegistry<TEvent> {
  return { typeOf: input.typeOf, definitions: input.events };
}

export type EncodeOptions = {
  /** Defaults to `crypto.randomUUID()`. */
  newEventId?: () => string;
  metadata?: string | null;
};

function defaultEventId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('no crypto.randomUUID available; pass newEventId');
  }
  return globalThis.crypto.randomUUID();
}

/** Encodes domain events into the wire shape accepted by `append_events`. */
export function encodeEvents<TEvent>(
  registry: EventRegistry<TEvent>,
  events: readonly TEvent[],
  opts: EncodeOptions = {},
): EncodedEvent[] {
  return events.map((event) => {
    const eventType = registry.typeOf(event);
    const definition = registry.definitions[eventType];
    if (!definition) {
      throw new Error(`${ES_ERROR.UNKNOWN_EVENT_TYPE}: ${eventType}`);
    }
    return {
      eventId: (opts.newEventId ?? defaultEventId)(),
      eventType,
      data: JSON.stringify(definition.encode(event)),
      metadata: opts.metadata ?? null,
    };
  });
}

/** Decodes one stored row into its domain event. */
export function decodeEvent<TEvent>(
  registry: EventRegistry<TEvent>,
  row: StoredEventRow,
): TEvent {
  const definition = registry.definitions[row.eventType];
  if (!definition) {
    throw new Error(`${ES_ERROR.UNKNOWN_EVENT_TYPE}: ${row.eventType}`);
  }
  const stored = JSON.parse(row.data) as unknown;
  const payload = definition.upgrade ? definition.upgrade(stored) : stored;
  return definition.decode(payload);
}

export type ReadRowsOptions = {
  /** Only rows for this stream. Omit to keep all rows in the cache. */
  streamId?: string;
  fromVersion?: number;
  atVersion?: number;
  atTimestampMicros?: bigint;
  limit?: number;
};

/**
 * Slices the client's own subscribed rows.
 *
 * This is not a second source of truth: it reads what the subscription already
 * delivered. Sort by version, never by timestamp, because events appended in one
 * transaction share a timestamp.
 */
export function sliceRows<TEvent>(
  rows: readonly DecodedEventRow<TEvent>[],
  opts: ReadRowsOptions = {},
): DecodedEventRow<TEvent>[] {
  let result = rows;

  if (opts.streamId !== undefined) {
    result = result.filter((row) => row.streamId === opts.streamId);
  }
  if (opts.fromVersion !== undefined) {
    const from = opts.fromVersion;
    result = result.filter((row) => row.version >= from);
  }
  if (opts.atVersion !== undefined) {
    const at = opts.atVersion;
    result = result.filter((row) => row.version <= at);
  }
  if (opts.atTimestampMicros !== undefined) {
    const at = opts.atTimestampMicros;
    result = result.filter((row) => row.createdAtMicros !== undefined && row.createdAtMicros <= at);
  }

  const sorted = [...result].sort((a, b) => a.version - b.version);
  return opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
}
