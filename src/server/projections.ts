import { Range } from 'spacetimedb/server';
import type { EsReadCtx, EventRow } from './tables.js';

/**
 * An inline projection handler.
 *
 * Runs inside the append transaction, so its writes are atomic with the events.
 * Keep it fast: transactions serialize per database, so a slow handler slows
 * every write in the module.
 *
 * `handle` must be a pure function of `(event, current table state)`. Never read
 * `ctx.timestamp` or `ctx.random` for business values: a rebuild would produce a
 * different result.
 */
export type InlineProjection<C extends EsReadCtx = EsReadCtx> = {
  /** Stable name, used in errors and rebuild reports. */
  name: string;
  /** Event types this projection consumes. Others are skipped. */
  handles: readonly string[];
  handle: (ctx: C, event: EventRow) => void;
  /**
   * Clears this projection's own tables. Required for `rebuildBatch({ reset })`.
   * Leave it out for append-only read models.
   */
  reset?: (ctx: C) => void;
};

export type RebuildOptions = {
  /** Start strictly after this global position. Omit to start at the beginning. */
  fromPosition?: bigint;
  /** Maximum rows in this transaction. Keep batches small; writes serialize. */
  limit?: number;
  /** Call each projection's `reset` before replaying. Use for a full rebuild. */
  reset?: boolean;
};

export type RebuildResult = {
  /** Number of event rows read (not handler invocations). */
  processed: number;
  /** Position of the last processed row, or null when nothing was read. */
  lastPosition: bigint | null;
  /** Projection names that ran. */
  projections: string[];
};

/** Runs the matching inline projections for a batch of appended events. */
export function applyInline<C extends EsReadCtx>(
  ctx: C,
  projections: readonly InlineProjection<C>[],
  rows: readonly EventRow[],
): void {
  for (const row of rows) {
    for (const projection of projections) {
      if (projection.handles.includes(row.eventType)) {
        projection.handle(ctx, row);
      }
    }
  }
}

/**
 * Replays committed events through materialized projections in bounded batches.
 *
 * Intended for an app-gated admin reducer, not as part of the write path. When a
 * handler throws, the whole transaction rolls back; the error names the
 * projection and event position so poison events are easy to find.
 */
export function rebuildBatch<C extends EsReadCtx>(
  ctx: C,
  projections: readonly InlineProjection<C>[],
  opts: RebuildOptions = {},
): RebuildResult {
  if (opts.reset) {
    for (const projection of projections) {
      if (!projection.reset) {
        throw new Error(`projection "${projection.name}" cannot be reset: no reset() provided`);
      }
      projection.reset(ctx);
    }
  }

  const range =
    opts.fromPosition === undefined
      ? new Range<bigint>({ tag: 'unbounded' }, { tag: 'unbounded' })
      : new Range<bigint>({ tag: 'excluded', value: opts.fromPosition }, { tag: 'unbounded' });

  const all = [...ctx.db.esEvent.byPosition.filter(range)];
  const rows = opts.limit === undefined ? all : all.slice(0, opts.limit);

  for (const row of rows) {
    for (const projection of projections) {
      if (!projection.handles.includes(row.eventType)) continue;
      try {
        projection.handle(ctx, row);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `projection "${projection.name}" failed at position ${row.position} (${row.eventType}): ${detail}`,
          { cause },
        );
      }
    }
  }

  return {
    processed: rows.length,
    lastPosition: rows.length > 0 ? rows[rows.length - 1]!.position : null,
    projections: projections.map((projection) => projection.name),
  };
}
