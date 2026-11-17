import type { Schema } from 'spacetimedb/server';
import { t } from 'spacetimedb/server';
import type { CtxOf } from './protocol.js';
import { esEvent, esStream, type EsDb, type EventRow } from './tables.js';

/**
 * Authorization predicate for a library-provided view factory.
 *
 * It is a required argument on purpose. Views are always public in SpacetimeDB,
 * so a factory that shipped an unchecked view would be a data leak. The app
 * decides who may see which stream.
 */
export type Authorize<C> = (ctx: C, streamId: string) => boolean;

export type StreamViewOptions<M extends Schema<any>> = {
  /** Database name of the view. Must be unique in the module. */
  name: string;
  authorize: Authorize<CtxOf<M>>;
};

/** The subset of a view context the library's view bodies actually read. */
type ViewBodyCtx = { readonly db: EsDb };

function sortByVersion(rows: Iterable<EventRow>): EventRow[] {
  return [...rows].sort((a, b) => a.version - b.version);
}

/**
 * A parameterized view exposing one stream's events.
 *
 * Parameterized views take SQL literals only, have no primary key, and share a
 * single client cache per view. Do not expose streams to every caller: pass an
 * `authorize` predicate that checks ownership.
 */
export function makeStreamView<M extends Schema<any>>(
  spacetimedb: M,
  opts: StreamViewOptions<M>,
) {
  return spacetimedb.view(
    { name: opts.name, public: true },
    { streamId: t.string() },
    t.array(esEvent.rowType),
    (ctx, params) => {
      if (!opts.authorize(ctx as unknown as CtxOf<M>, params.streamId)) return [];
      const { db } = ctx as unknown as ViewBodyCtx;
      return sortByVersion(db.esEvent.byStreamVersion.filter(params.streamId));
    },
  );
}

/**
 * A parameterized view exposing a stream as of a version.
 *
 * Same authorization and caching caveats as {@link makeStreamView}. Intended for
 * support/audit flows, not for hot client reads.
 */
export function makeStreamAtView<M extends Schema<any>>(
  spacetimedb: M,
  opts: StreamViewOptions<M>,
) {
  return spacetimedb.view(
    { name: opts.name, public: true },
    { streamId: t.string(), atVersion: t.u32() },
    t.array(esEvent.rowType),
    (ctx, params) => {
      if (!opts.authorize(ctx as unknown as CtxOf<M>, params.streamId)) return [];
      const { db } = ctx as unknown as ViewBodyCtx;
      return sortByVersion(db.esEvent.byStreamVersion.filter(params.streamId)).filter(
        (row) => row.version <= params.atVersion,
      );
    },
  );
}

/**
 * A parameterized view exposing only a stream's concurrency token and metadata.
 *
 * Cheaper than {@link makeStreamView} for clients that poll for the current
 * version, and it never exposes event payloads.
 */
export function makeStreamHeadView<M extends Schema<any>>(
  spacetimedb: M,
  opts: StreamViewOptions<M>,
) {
  return spacetimedb.view(
    { name: opts.name, public: true },
    { streamId: t.string() },
    t.option(esStream.rowType),
    (ctx, params) => {
      if (!opts.authorize(ctx as unknown as CtxOf<M>, params.streamId)) return undefined;
      const { db } = ctx as unknown as ViewBodyCtx;
      return db.esStream.streamId.find(params.streamId) ?? undefined;
    },
  );
}
