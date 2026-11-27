import { t } from 'spacetimedb/server';
import { makeStreamView } from 'stdb-es/server';
import { counterState, spacetimedb, type Context } from '../../schema.js';
import { COUNTER_KIND, STREAM_TYPES, TABLES } from './constants.js';

/** World-readable C1 and C2 state; C2 rows carry owner identity and email. C3 is never included. */
export const publicSummary = spacetimedb.anonymousView(
  { name: TABLES.publicSummary, public: true },
  t.array(counterState.rowType),
  (ctx) =>
    [...ctx.db.counterState.iter()].filter(
      (row) => row.counterKind !== COUNTER_KIND.privateOwned,
    ),
);

/** Per-caller C3 state. The sender comes from the verified connection identity. */
export const privateSummary = spacetimedb.view(
  { name: TABLES.privateSummary, public: true },
  t.array(counterState.rowType),
  (ctx) => {
    const rows = [];
    for (const owner of ctx.db.counterOwner.byOwner.filter(ctx.sender)) {
      if (owner.counterKind !== COUNTER_KIND.privateOwned) continue;
      const state = ctx.db.counterState.streamId.find(owner.streamId);
      if (state) rows.push(state);
    }
    return rows;
  },
);

function isPublicStream(ctx: Context, streamId: string): boolean {
  const stream = ctx.db.esStream.streamId.find(streamId);
  return (
    stream !== null &&
    (stream.streamType === STREAM_TYPES.Global || stream.streamType === STREAM_TYPES.PublicOwned)
  );
}

function isOwnedPrivateStream(ctx: Context, streamId: string): boolean {
  const stream = ctx.db.esStream.streamId.find(streamId);
  if (stream?.streamType !== STREAM_TYPES.PrivateOwned) return false;
  const owner = ctx.db.counterOwner.streamId.find(streamId);
  return owner?.owner.equals(ctx.sender) ?? false;
}

/** Event history for C1 and only the public side of C2. */
export const publicEvents = makeStreamView(spacetimedb, {
  name: TABLES.publicEvents,
  authorize: (ctx, streamId) => isPublicStream(ctx, streamId),
});

/** Event history for the caller's own C3 stream only. */
export const privateEvents = makeStreamView(spacetimedb, {
  name: TABLES.privateEvents,
  authorize: (ctx, streamId) => isOwnedPrivateStream(ctx, streamId),
});
