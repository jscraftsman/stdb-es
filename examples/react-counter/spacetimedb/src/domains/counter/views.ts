import { t } from 'spacetimedb/server';
import { makeStreamView } from 'stdb-es/server';
import { counterState, spacetimedb } from '../../schema.js';
import { TABLES_COUNTER } from './constants.js';

/** World-readable, materialized read model for the simple React UI. */
export const counterSummary = spacetimedb.anonymousView(
  { name: TABLES_COUNTER.summary, public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);

/**
 * Public parameterized audit view used by the consumer integration kit.
 * This demo intentionally exposes its counters; a real app should authorize
 * `streamId` against the caller instead of allowing every stream.
 */
export const streamEvents = makeStreamView(spacetimedb, {
  name: TABLES_COUNTER.streamEvents,
  authorize: () => true,
});
