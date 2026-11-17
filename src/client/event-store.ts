import { ANY_VERSION, type EncodedEvent } from '../server/protocol.js';
import {
  decodeEvent,
  encodeEvents,
  type DecodedEventRow,
  type EncodeOptions,
  type EventRegistry,
  type StoredEventRow,
} from './encode.js';

/** Arguments accepted by the app's generated `append_events` reducer binding. */
export type AppendCallArgs = {
  streamId: string;
  streamType: string;
  expectedVersion: number;
  events: EncodedEvent[];
  metadata: string | null;
};

/**
 * The generated reducer binding, passed in by the app.
 *
 * Typing this as a callback keeps the client free of generated-code imports:
 * `append: (args) => reducers.appendEvents(args)`.
 */
export type AppendCall = (args: AppendCallArgs) => Promise<unknown>;

export type EventStoreClientOptions<TEvent> = {
  append: AppendCall;
  registry: EventRegistry<TEvent>;
  newEventId?: () => string;
};

export type AppendOptions = {
  /**
   * What the caller believes is the current version. Defaults to `ANY_VERSION`,
   * which is only safe for single-writer or idempotent streams.
   */
  expectedVersion?: number;
  metadata?: string | null;
  newEventId?: () => string;
};

/**
 * Thin, opinionated wrapper over the app's append reducer.
 *
 * It owns no state. Event ids make retries safe: if a call times out but
 * committed, re-sending the same encoded batch is deduplicated by the store.
 */
export function createEventStoreClient<TEvent>(opts: EventStoreClientOptions<TEvent>) {
  const encodeOpts = (options: AppendOptions): EncodeOptions => ({
    newEventId: options.newEventId ?? opts.newEventId,
    metadata: options.metadata ?? null,
  });

  return {
    registry: opts.registry,

    /** Encodes without sending. Useful for retrying the exact same batch. */
    encode(events: readonly TEvent[], options: AppendOptions = {}): EncodedEvent[] {
      return encodeEvents(opts.registry, events, encodeOpts(options));
    },

    /** Sends one batch. Resolves when the reducer commits. */
    async append(
      streamId: string,
      streamType: string,
      events: readonly TEvent[],
      options: AppendOptions = {},
    ): Promise<void> {
      const encoded = this.encode(events, options);
      await opts.append({
        streamId,
        streamType,
        expectedVersion: options.expectedVersion ?? ANY_VERSION,
        events: encoded,
        metadata: options.metadata ?? null,
      });
    },

    /** Retries a previously encoded batch verbatim, event ids included. */
    async retry(
      streamId: string,
      streamType: string,
      encoded: readonly EncodedEvent[],
      options: AppendOptions = {},
    ): Promise<void> {
      await opts.append({
        streamId,
        streamType,
        expectedVersion: options.expectedVersion ?? ANY_VERSION,
        events: [...encoded],
        metadata: options.metadata ?? null,
      });
    },

    decode(row: StoredEventRow): DecodedEventRow<TEvent> {
      const { data: _data, ...envelope } = row;
      return { ...envelope, event: decodeEvent(opts.registry, row) };
    },

    decodeAll(rows: readonly StoredEventRow[]): DecodedEventRow<TEvent>[] {
      return rows.map((row) => this.decode(row));
    },
  };
}

export type EventStoreClient<TEvent> = ReturnType<typeof createEventStoreClient<TEvent>>;
