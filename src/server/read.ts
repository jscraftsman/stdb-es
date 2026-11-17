import { Range } from 'spacetimedb/server';
import type {
  AggregateStreamOptions,
  DecodedEvent,
  FoldOptions,
  ReadStreamOptions,
} from './protocol.js';
import type { EsReadCtx, EventRow, StreamRow } from './tables.js';

const MAX_VERSION = 0xffff_ffff;

/**
 * Reads a stream, optionally bounded by version and/or time.
 *
 * Both bounds intersect. Version filtering uses the `(streamId, version)`
 * index; time filtering uses `(streamId, createdAtMicros)` because `Timestamp`
 * itself is not an indexable column type.
 */
export function readStream(
  ctx: EsReadCtx,
  streamId: string,
  opts: ReadStreamOptions = {},
): EventRow[] {
  const from = Math.max(opts.fromVersion ?? 1, 1);
  let rows: EventRow[];

  if (opts.atTimestampMicros !== undefined && opts.atVersion === undefined) {
    rows = [
      ...ctx.db.esEvent.byStreamTime.filter([
        streamId,
        new Range({ tag: 'unbounded' }, { tag: 'included', value: opts.atTimestampMicros }),
      ]),
    ];
  } else if (opts.atVersion !== undefined) {
    const to = Math.min(Math.max(opts.atVersion, 1), MAX_VERSION);
    rows = [
      ...ctx.db.esEvent.byStreamVersion.filter([
        streamId,
        new Range({ tag: 'included', value: from }, { tag: 'included', value: to }),
      ]),
    ];
  } else if (from > 1) {
    rows = [
      ...ctx.db.esEvent.byStreamVersion.filter([
        streamId,
        new Range({ tag: 'included', value: from }, { tag: 'unbounded' }),
      ]),
    ];
  } else {
    rows = [...ctx.db.esEvent.byStreamVersion.filter(streamId)];
  }

  if (opts.atTimestampMicros !== undefined && opts.atVersion !== undefined) {
    const cap = opts.atTimestampMicros;
    rows = rows.filter((row) => row.createdAtMicros <= cap);
  }

  // Events written in one transaction share a timestamp, so version is the
  // only stable order.
  rows.sort((a, b) => a.version - b.version);
  return opts.limit !== undefined ? rows.slice(0, opts.limit) : rows;
}

/** The stream row (concurrency token + catalogue entry), or null. */
export function getStreamState(ctx: EsReadCtx, streamId: string): StreamRow | null {
  return ctx.db.esStream.streamId.find(streamId);
}

/** Last committed version, or 0 when the stream does not exist yet. */
export function streamVersion(ctx: EsReadCtx, streamId: string): number {
  return ctx.db.esStream.streamId.find(streamId)?.version ?? 0;
}

/** Lists streams, optionally filtered by type. */
export function listStreams(ctx: EsReadCtx, streamType?: string): StreamRow[] {
  return streamType === undefined
    ? [...ctx.db.esStream.iter()]
    : [...ctx.db.esStream.byType.filter(streamType)];
}

/** Folds decoded events into a state value. */
export function foldEvents<TState, TEvent = unknown>(
  rows: readonly EventRow[],
  opts: FoldOptions<TState, TEvent>,
): TState {
  let state = opts.initial;
  for (const row of rows) {
    state = opts.evolve(state, opts.decode(row), row);
  }
  return state;
}

/**
 * Replays a stream into an aggregate state.
 *
 * This is the write-path read used by repositories: it runs on every command,
 * not just for debugging. Returns null when the stream does not exist.
 */
export function aggregateStream<TState, TEvent = unknown>(
  ctx: EsReadCtx,
  streamId: string,
  opts: AggregateStreamOptions<TState, TEvent>,
): TState | null {
  if (ctx.db.esStream.streamId.find(streamId) === null) return null;

  let state = opts.initial();
  for (const row of readStream(ctx, streamId, opts)) {
    state = opts.evolve(state, opts.decode(row), row);
  }
  return state;
}

/** Decodes the `data` column of an event row. */
export function parsePayload<TEvent = unknown>(
  row: EventRow,
  parse: (json: string) => TEvent = (json) => JSON.parse(json) as TEvent,
): DecodedEvent<TEvent> {
  return { eventType: row.eventType, data: parse(row.data) };
}
