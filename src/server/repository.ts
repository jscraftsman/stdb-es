import { ES_ERROR } from '../errors.js';
import type { AppendResult } from './protocol.js';
import { appendToStream } from './append.js';
import type { AggregateDefinition } from './aggregate.js';
import { esError } from './errors.js';
import { readStream } from './read.js';
import type { EsCtx, EventRow } from './tables.js';

/**
 * One row in an app-owned current-state table, as seen by the library.
 *
 * This is deliberately not a "snapshot": it is a live projection of the stream
 * that views and commands read. Deleting it costs a replay, not correctness.
 */
export type CachedState<TState> = {
  version: number;
  state: TState;
};

/**
 * Adapter over the app's typed state-cache table. The library never sees the
 * row shape, so the table stays private and app-owned.
 */
export type StateCache<TState, C extends EsCtx = EsCtx> = {
  /** Returns the cached state for a stream, or null when there is no row. */
  load: (ctx: C, streamId: string) => CachedState<TState> | null;
  /** Writes or replaces the cache row. Must run in the caller's transaction. */
  save: (ctx: C, streamId: string, version: number, state: TState) => void;
  /** Removes the cache row, forcing the next load to replay. */
  remove: (ctx: C, streamId: string) => void;
};

export type EncodedDomainEvent = {
  eventType: string;
  /** JSON-serializable payload. Stored as canonical JSON. */
  data: unknown;
  metadata?: string | null;
};

/**
 * Wire encoding for a domain event. Called once per appended event on the module
 * side; keep it deterministic so replay and rebuild agree with live folds.
 */
export type EventEncoder<TEvent> = (event: TEvent) => EncodedDomainEvent;

export type RepositoryOptions<TState, TEvent, C extends EsCtx = EsCtx> = {
  /** Stream type recorded in `es_stream` for this aggregate kind. */
  streamType: string;
  initial: () => TState;
  decode: (row: EventRow) => TEvent;
  evolve: (state: TState, event: TEvent, row: EventRow) => TState;
  encode: EventEncoder<TEvent>;
  /** Optional current-state cache. Strongly recommended for long streams. */
  cache?: StateCache<TState, C>;
  /**
   * Default event-id generator for repository-generated batches. Command reducers
   * should pass `SaveOptions.eventIds` derived from their `commandId` instead, so
   * a retry replays instead of appending new events.
   */
  newEventId?: (ctx: C) => string;
};

/** A loaded (or fresh) aggregate: state, version, and identity. */
export type LoadedAggregate<TState> = {
  id: string;
  /** Last version represented by `state`. 0 means "no events". */
  version: number;
  state: TState;
};

export type LoadOptions = {
  /** Replay only up to this version. Caches newer than this are ignored. */
  atVersion?: number;
  /** Replay only events at or before this processing time. */
  atTimestampMicros?: bigint;
};

export type SaveOptions = {
  /**
   * Optimistic-concurrency token. Defaults to the version the aggregate was
   * loaded at, which is almost always what you want.
   */
  expectedVersion?: number;
  metadata?: string | null;
  /**
   * Explicit event ids in the same order as `events`. A command reducer should
   * derive them from `commandId`; repeating the same ids makes `save` replay the
   * batch instead of appending duplicates.
   */
  eventIds?: readonly string[];
};

/**
 * Typed command-side access to one aggregate kind.
 *
 * `load` is cache-first but version-guarded: a stale or time-travelling cache
 * row is ignored and the tail is replayed, so a forgotten cache write degrades
 * performance instead of correctness.
 */
export class Repository<TState, TEvent, C extends EsCtx = EsCtx> {
  readonly streamType: string;
  readonly #opts: RepositoryOptions<TState, TEvent, C>;

  constructor(opts: RepositoryOptions<TState, TEvent, C>) {
    this.#opts = opts;
    this.streamType = opts.streamType;
  }

  /** Builds the empty aggregate for a stream that has never been written. */
  create(id: string): LoadedAggregate<TState> {
    return { id, version: 0, state: this.#opts.initial() };
  }

  /** Loads and replays a stream, or returns null when it does not exist. */
  load(ctx: C, id: string, opts: LoadOptions = {}): LoadedAggregate<TState> | null {
    const stream = ctx.db.esStream.streamId.find(id);
    if (!stream) return null;

    const aggregate = this.create(id);
    const cached = this.#opts.cache?.load(ctx, id) ?? null;

    const usable =
      cached !== null &&
      cached.version <= stream.version &&
      (opts.atVersion === undefined || cached.version <= opts.atVersion) &&
      // A timestamp bound cannot be compared with a cache version: the version
      // that corresponds to a time is exactly what the cache does not store.
      opts.atTimestampMicros === undefined;

    if (usable) {
      aggregate.state = cached.state;
      aggregate.version = cached.version;
    }

    const rows = readStream(ctx, id, {
      fromVersion: aggregate.version + 1,
      atVersion: opts.atVersion,
      atTimestampMicros: opts.atTimestampMicros,
    });

    for (const row of rows) {
      aggregate.state = this.#opts.evolve(aggregate.state, this.#opts.decode(row), row);
      aggregate.version = row.version;
    }

    return aggregate;
  }

  /** `load`, or a fresh aggregate when the stream does not exist. */
  loadOrCreate(ctx: C, id: string, opts: LoadOptions = {}): LoadedAggregate<TState> {
    return this.load(ctx, id, opts) ?? this.create(id);
  }

  /**
   * Appends new events and updates the cache in one transaction.
   *
   * Returns null when there is nothing to append. Pass `eventIds` derived from
   * the command's `commandId` for browser-facing writes: a retried command then
   * replays the same batch and is not re-applied to `aggregate.state`.
   */
  save(
    ctx: C,
    aggregate: LoadedAggregate<TState>,
    events: readonly TEvent[],
    opts: SaveOptions = {},
  ): AppendResult | null {
    if (events.length === 0) return null;
    if (opts.eventIds !== undefined && opts.eventIds.length !== events.length) {
      throw esError(
        ES_ERROR.INVALID_BATCH,
        `eventIds must match events length (${opts.eventIds.length} != ${events.length})`,
      );
    }

    const expectedVersion = opts.expectedVersion ?? aggregate.version;
    const encoded = events.map((event, index) => {
      const encodedEvent = this.#opts.encode(event);
      return {
        eventId:
          opts.eventIds?.[index] ?? this.#opts.newEventId?.(ctx) ?? ctx.newUuidV7().toString(),
        eventType: encodedEvent.eventType,
        data: JSON.stringify(encodedEvent.data),
        metadata: encodedEvent.metadata ?? opts.metadata ?? null,
      };
    });

    const result = appendToStream(ctx, {
      streamId: aggregate.id,
      streamType: this.streamType,
      events: encoded,
      expectedVersion,
      metadata: opts.metadata ?? null,
    });

    aggregate.version = result.version;

    // A replayed batch was already folded into the caller's state by the
    // transaction that committed it. Folding again would double-apply.
    if (result.status === 'appended') {
      for (const row of result.rows) {
        aggregate.state = this.#opts.evolve(aggregate.state, this.#opts.decode(row), row);
      }
    }

    this.#opts.cache?.save(ctx, aggregate.id, result.version, aggregate.state);
    return result;
  }

  /** Deletes the cache row so the next load replays from the log. */
  invalidate(ctx: C, streamId: string): void {
    this.#opts.cache?.remove(ctx, streamId);
  }
}

/** Builds a repository from an aggregate definition plus encoding. */
export function makeRepository<TState, TEvent, C extends EsCtx = EsCtx>(
  definition: AggregateDefinition<TState, TEvent>,
  opts: Omit<RepositoryOptions<TState, TEvent, C>, keyof AggregateDefinition<TState, TEvent>>,
): Repository<TState, TEvent, C> {
  return new Repository<TState, TEvent, C>({ ...definition, ...opts });
}
