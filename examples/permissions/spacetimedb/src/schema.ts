import { schema, t, table } from 'spacetimedb/server';
import { esTables, type CtxOf } from 'stdb-es/server';
import { TABLES } from './domains/counter/constants.js';

/**
 * Private, app-owned state cache. Clients read it only through views. Owner
 * metadata is duplicated here so the public read model can identify which user
 * owns each C2 row without exposing the private ownership table.
 */
export const counterState = table(
  {
    name: TABLES.state,
    indexes: [{ accessor: 'byKind', algorithm: 'btree', columns: ['counterKind'] }],
  },
  {
    streamId: t.string().primaryKey(),
    counterKind: t.string(),
    version: t.u32(),
    value: t.i64(),
    owner: t.option(t.identity()),
    ownerEmail: t.option(t.string()),
  },
);

/** Private ownership table for the two per-user counters. */
export const counterOwner = table(
  {
    name: TABLES.owner,
    indexes: [{ accessor: 'byOwner', algorithm: 'btree', columns: ['owner'] }],
  },
  {
    streamId: t.string().primaryKey(),
    counterKind: t.string(),
    owner: t.identity(),
  },
);

export const spacetimedb = schema({ ...esTables, counterState, counterOwner });
export type Context = CtxOf<typeof spacetimedb>;

export default spacetimedb;
