import { schema, t, table } from 'spacetimedb/server';
import { esTables, type CtxOf } from 'stdb-es/server';
import { TABLES_COUNTER } from './domains/counter/constants.js';

/** Private, app-owned state cache. `version` is the guard used by replay-on-miss. */
export const counterState = table(
  { name: TABLES_COUNTER.state },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

/**
 * Private ownership table. The first caller to use a counter owns it; command
 * reducers reject later commands from a different `ctx.sender`.
 */
export const counterOwner = table(
  { name: TABLES_COUNTER.owner },
  {
    streamId: t.string().primaryKey(),
    owner: t.identity(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState, counterOwner });
export type Context = CtxOf<typeof spacetimedb>;

export default spacetimedb;
