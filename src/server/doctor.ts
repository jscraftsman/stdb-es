import { listStreams, readStream } from './read.js';
import type { StateCache } from './repository.js';
import type { EsCtx, EsReadCtx } from './tables.js';

/** A structural problem in a stream's persisted rows. */
export type StreamProblem =
  /** `es_stream.version` disagrees with the last persisted event version. */
  | { kind: 'stream-version-mismatch'; streamVersion: number; lastEventVersion: number | null }
  /** Event versions are not contiguous starting at 1. */
  | { kind: 'version-gap'; expected: number; found: number }
  /** Two rows claim the same version. */
  | { kind: 'version-duplicate'; version: number }
  /** An event's `streamType` differs from its stream row. */
  | { kind: 'stream-type-mismatch'; version: number; eventStreamType: string; streamType: string }
  /** The stream row exists but has no events. */
  | { kind: 'empty-stream'; streamVersion: number };

export type StreamIntegrity = {
  streamId: string;
  /** Null when `es_stream` has no row for this id. */
  streamType: string | null;
  eventCount: number;
  problems: StreamProblem[];
  ok: boolean;
};

/**
 * Checks that a stream's rows are internally consistent.
 *
 * This catches interrupted/partial writes and manual SQL damage. It cannot
 * detect a changed `evolve` implementation, because the log itself is valid.
 */
export function verifyStreamIntegrity(ctx: EsReadCtx, streamId: string): StreamIntegrity {
  const stream = ctx.db.esStream.streamId.find(streamId);
  const problems: StreamProblem[] = [];

  if (!stream) {
    return { streamId, streamType: null, eventCount: 0, problems, ok: true };
  }

  const rows = readStream(ctx, streamId);
  let expected = 1;

  for (const row of rows) {
    if (row.version === expected - 1) {
      problems.push({ kind: 'version-duplicate', version: row.version });
      continue;
    }
    if (row.version !== expected) {
      problems.push({ kind: 'version-gap', expected, found: row.version });
      expected = row.version;
    }
    if (row.streamType !== stream.streamType) {
      problems.push({
        kind: 'stream-type-mismatch',
        version: row.version,
        eventStreamType: row.streamType,
        streamType: stream.streamType,
      });
    }
    expected += 1;
  }

  const lastEventVersion = rows.length > 0 ? rows[rows.length - 1]!.version : null;

  if (lastEventVersion === null) {
    problems.push({ kind: 'empty-stream', streamVersion: stream.version });
  } else if (lastEventVersion !== stream.version) {
    problems.push({
      kind: 'stream-version-mismatch',
      streamVersion: stream.version,
      lastEventVersion,
    });
  }

  return {
    streamId,
    streamType: stream.streamType,
    eventCount: rows.length,
    problems,
    ok: problems.length === 0,
  };
}

export type CacheVerification<TState> = {
  streamId: string;
  /** False when the stream does not exist. */
  exists: boolean;
  streamVersion: number | null;
  cachedVersion: number | null;
  cachedState: TState | null;
  replayedState: TState | null;
  ok: boolean;
};

export type VerifyCacheOptions<C extends EsCtx, TState> = {
  cache: StateCache<TState, C>;
  /** Full replay that ignores the cache, usually `repository.load` with no cache. */
  replay: (ctx: C, streamId: string) => TState;
  /**
   * Structural equality for state. Defaults to a bigint-safe, key-order-
   * independent comparison. Override it for Maps, Sets, or other non-plain
   * state values.
   */
  equal?: (a: TState, b: TState) => boolean;
};

/**
 * Structural equality for aggregate state.
 *
 * Handles `bigint` (which `JSON.stringify` rejects), ignores object key order,
 * and compares arrays element-wise. Apps whose state contains Maps, Sets, or
 * other non-plain values should pass their own `equal`.
 */
function defaultEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => defaultEqual(value, b[index]));
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) &&
      defaultEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Compares an app's state cache with a full replay.
 *
 * Detects: missing cache, stale cache version, and same-version state drift
 * (the case the version guard alone cannot catch).
 */
export function verifyStreamState<C extends EsCtx, TState>(
  ctx: C,
  streamId: string,
  opts: VerifyCacheOptions<C, TState>,
): CacheVerification<TState> {
  const stream = ctx.db.esStream.streamId.find(streamId);
  const cached = opts.cache.load(ctx, streamId);

  if (!stream) {
    return {
      streamId,
      exists: false,
      streamVersion: null,
      cachedVersion: cached?.version ?? null,
      cachedState: cached?.state ?? null,
      replayedState: null,
      ok: cached === null,
    };
  }

  const replayedState = opts.replay(ctx, streamId);
  const equal = opts.equal ?? defaultEqual;
  const ok =
    cached !== null && cached.version === stream.version && equal(cached.state, replayedState);

  return {
    streamId,
    exists: true,
    streamVersion: stream.version,
    cachedVersion: cached?.version ?? null,
    cachedState: cached?.state ?? null,
    replayedState,
    ok,
  };
}

/** Verifies every stream in the database and returns only the failing ones. */
export function findDrift<C extends EsCtx, TState>(
  ctx: C,
  opts: VerifyCacheOptions<C, TState> & { streamType?: string },
): CacheVerification<TState>[] {
  const drifted: CacheVerification<TState>[] = [];
  for (const stream of listStreams(ctx, opts.streamType)) {
    const result = verifyStreamState(ctx, stream.streamId, opts);
    if (!result.ok) drifted.push(result);
  }
  return drifted;
}

export type RepairAction = 'unchanged' | 'repaired' | 'removed';

export type RepairOptions<C extends EsCtx, TState> = {
  cache: StateCache<TState, C>;
  /** Full replay that ignores the cache. */
  replay: (ctx: C, streamId: string) => TState;
  /** Same comparison as `verifyStreamState`; used to detect same-version drift. */
  equal?: (a: TState, b: TState) => boolean;
};

/**
 * Rewrites one stream's cache row from the log, or removes an orphan row.
 *
 * A row with the right version is still rewritten when its state disagrees with
 * a replay: same-version drift is invisible to the version guard but not to
 * `verifyStreamState`.
 *
 * Expose it through an app-owned, authorization-gated admin reducer. The library
 * deliberately exports no reducer: repair is an operator decision.
 */
export function repairStream<C extends EsCtx, TState>(
  ctx: C,
  streamId: string,
  opts: RepairOptions<C, TState>,
): RepairAction {
  const stream = ctx.db.esStream.streamId.find(streamId);
  const cached = opts.cache.load(ctx, streamId);

  if (!stream) {
    if (cached === null) return 'unchanged';
    opts.cache.remove(ctx, streamId);
    return 'removed';
  }

  const equal = opts.equal ?? defaultEqual;
  const replayed = opts.replay(ctx, streamId);
  if (cached !== null && cached.version === stream.version && equal(cached.state, replayed)) {
    return 'unchanged';
  }

  opts.cache.save(ctx, streamId, stream.version, replayed);
  return 'repaired';
}
