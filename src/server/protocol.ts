import type { InferSchema, ReducerCtx, Schema } from 'spacetimedb/server';
import type { AggregateDefinition } from './aggregate.js';
import type { EventRow, EsCtx } from './tables.js';

/** The context a module's reducers receive, inferred from its `schema()`. */
export type CtxOf<M extends Schema<any>> = ReducerCtx<InferSchema<M>>;

/**
 * Wire shape of an event as accepted by `appendToStream`. `data` is canonical
 * JSON; the store validates it and never interprets it.
 */
export type EncodedEvent = {
  eventId: string;
  eventType: string;
  data: string;
  metadata?: string | null;
};

/** Sentinels for `expectedVersion`. Versions are 1-based, so negatives are safe. */
export const ANY_VERSION = -1;
export const NO_STREAM = 0;
export const STREAM_EXISTS = -2;

export type ExpectedVersion = number;

export type AppendArgs = {
  streamId: string;
  streamType: string;
  events: readonly EncodedEvent[];
  expectedVersion: ExpectedVersion;
  metadata?: string | null;
};

export type AppendResult =
  | { status: 'appended'; version: number; rows: EventRow[] }
  /** The whole batch was already committed by an earlier attempt. */
  | { status: 'replayed'; version: number; rows: EventRow[] };

/**
 * Store configuration for one module.
 *
 * Generic over the module's reducer context so hooks receive the app's full
 * context, including its own state-cache and projection tables, not just store
 * tables. `makeAppendReducer` infers it from the schema.
 */
export type EventStoreConfig<C = EsCtx> = {
  /**
   * When set, appends reject event types outside this list. Strongly
   * recommended: it turns typos and unregistered event types into write-time
   * errors instead of silent garbage in the log.
   */
  eventTypes?: readonly string[];
  /** Maximum events per append. Default 100. */
  maxBatchSize?: number;
  /** Maximum payload length in characters. Default 64 KiB. */
  maxPayloadLength?: number;
  /**
   * Runs inside the append transaction after the events are written. Use it to
   * maintain state caches and inline projections atomically with the append.
   *
   * Never runs for an idempotent replay: those events were projected by the
   * transaction that first committed them.
   */
  onAppended?: (ctx: C, result: AppendResult) => void;
};

export type ReadStreamOptions = {
  /** First version to include. Default 1. */
  fromVersion?: number;
  /** Last version to include (inclusive). */
  atVersion?: number;
  /** Only events with `createdAtMicros <= this` (inclusive). */
  atTimestampMicros?: bigint;
  /** Maximum rows to return after ordering. */
  limit?: number;
};

export type DecodedEvent<TEvent = unknown> = {
  eventType: string;
  data: TEvent;
};

/**
 * Replay options: the same aggregate definition the repository uses, plus read
 * bounds. Sharing the definition means replay and cached state can never
 * disagree about how events become state.
 */
export type AggregateStreamOptions<TState, TEvent = unknown> = AggregateDefinition<
  TState,
  TEvent
> &
  ReadStreamOptions;

export type FoldOptions<TState, TEvent = unknown> = {
  initial: TState;
  decode: (row: EventRow) => DecodedEvent<TEvent>;
  evolve: (state: TState, event: DecodedEvent<TEvent>, row: EventRow) => TState;
};
