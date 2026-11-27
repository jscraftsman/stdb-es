import type {
  Infer,
  ReadonlyDbView,
  ReducerCtx,
  TablesToSchema,
} from 'spacetimedb/server';
import { table, t } from 'spacetimedb/server';

/**
 * Accessor for the single counter row that hands out gapless global positions.
 * `autoInc()` cannot be used for this: its values are allocated in batches, can
 * contain gaps, and consecutive inserts are not guaranteed to be ordered.
 */
export const GLOBAL_HEAD = 'global';

/**
 * Stream catalogue and optimistic-concurrency token. Private: clients read
 * through app-owned views and read models.
 */
export const esStream = table(
  {
    name: 'es_stream',
    // Every append reads this concurrency token; keep it resident.
    cachePolicy: 'required_in_memory',
    indexes: [
      { accessor: 'byType', algorithm: 'btree', columns: ['streamType'] },
    ],
  },
  {
    streamId: t.string().primaryKey(),
    streamType: t.string(),
    /** Last committed version. 0 means the stream exists but is empty. */
    version: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    metadata: t.option(t.string()),
  },
);

/**
 * Append-only event log. Private. Never updated or deleted by the library.
 *
 * `data` holds canonical JSON. The envelope is deliberately stable so that new
 * event types and payload changes never require a database migration.
 */
export const esEvent = table(
  {
    name: 'es_event',
    // Append-only history grows without bound; replay can read it from a deeper tier.
    cachePolicy: 'no_requirement',
    indexes: [
      { accessor: 'byPosition', algorithm: 'btree', columns: ['position'] },
      { accessor: 'byStreamVersion', algorithm: 'btree', columns: ['streamId', 'version'] },
      { accessor: 'byStreamTime', algorithm: 'btree', columns: ['streamId', 'createdAtMicros'] },
      { accessor: 'byType', algorithm: 'btree', columns: ['eventType'] },
    ],
  },
  {
    /** Module-derived id, usually from `commandId`. Primary key gives cross-stream dedupe. */
    eventId: t.string().primaryKey(),
    /** Gapless, commit-ordered global position from `esHead`. */
    position: t.u64(),
    streamId: t.string(),
    streamType: t.string(),
    /** 1-based version within the stream. */
    version: t.u32(),
    eventType: t.string(),
    data: t.string(),
    metadata: t.option(t.string()),
    createdAt: t.timestamp(),
    /** `Timestamp` is not indexable, so time travel uses this column. */
    createdAtMicros: t.u64(),
    createdBy: t.identity(),
  },
);

/** Single-row counter used for `esEvent.position`. */
export const esHead = table(
  // The global position counter is read and updated in every append.
  { name: 'es_head', cachePolicy: 'required_in_memory' },
  {
    id: t.string().primaryKey(),
    position: t.u64(),
  },
);

/** Spread into `schema({ ...esTables, ...appTables })`. */
export const esTables = { esStream, esEvent, esHead };

export type EsTables = typeof esTables;
export type EsSchemaDef = TablesToSchema<EsTables>;

/** Read-only database view containing only the event-store tables. */
export type EsDb = ReadonlyDbView<EsSchemaDef>;

/** Minimal context accepted by read helpers (works from reducers and views). */
export type EsReadCtx = { readonly db: EsDb };

/** Full context required by write helpers. */
export type EsCtx = ReducerCtx<EsSchemaDef>;

export type StreamRow = Infer<typeof esStream.rowType>;
export type EventRow = Infer<typeof esEvent.rowType>;
export type HeadRow = Infer<typeof esHead.rowType>;
