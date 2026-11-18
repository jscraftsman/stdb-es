import { t } from 'spacetimedb/server';
import { counterState, spacetimedb } from '../../schema.js';
import { TABLES_COUNTER } from './constants.js';

/** World-readable, materialized read model for the simple React UI. */
export const counterSummary = spacetimedb.anonymousView(
  { name: TABLES_COUNTER.summary, public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);
