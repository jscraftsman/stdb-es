import { schema, t, table } from 'spacetimedb/server';
import { esTables, makeAppendReducer, readStream, type CtxOf } from 'stdb-es/server';

/**
 * App-owned state cache. This is *not* the source of truth: `es_event` is.
 * It exists so commands do not have to replay a long stream on every write.
 *
 * The `version` column is the concurrency guard. A repository loads this row
 * and only trusts it when `version` equals `es_stream.version`; otherwise it
 * falls back to replaying the log.
 */
const counterState = table(
  { name: 'counter_state' },
  {
    streamId: t.string().primaryKey(),
    version: t.u32(),
    value: t.i64(),
  },
);

const spacetimedb = schema({ ...esTables, counterState });
export default spacetimedb;

/** Domain event payloads as they appear in the `data` column. */
type CounterEvent =
  | { kind: 'Incremented'; by: number }
  | { kind: 'Decremented'; by: number }
  | { kind: 'Reset' };

function evolve(value: bigint, payload: string): bigint {
  const event = JSON.parse(payload) as CounterEvent;
  switch (event.kind) {
    case 'Incremented':
      return value + BigInt(event.by);
    case 'Decremented':
      return value - BigInt(event.by);
    case 'Reset':
      return 0n;
  }
}

/** Full replay, used when the cache row is missing or cannot be trusted. */
function replayValue(ctx: CtxOf<typeof spacetimedb>, streamId: string): bigint {
  let value = 0n;
  for (const row of readStream(ctx, streamId)) value = evolve(value, row.data);
  return value;
}

export const appendEvents = makeAppendReducer(spacetimedb, {
  eventTypes: ['Incremented', 'Decremented', 'Reset'],

  // `ctx` is inferred from the schema above, so app tables are fully typed.
  // This runs inside the append transaction, after the events are written, and
  // only for genuinely new events (not idempotent replays).
  onAppended: (ctx, result) => {
    const { rows } = result;
    const streamId = rows[0]?.streamId;
    if (!streamId) return;

    const current = ctx.db.counterState.streamId.find(streamId);
    if (!current) {
      // A missing cache row means "replay", never "state is empty". `onAppended`
      // runs after the write, so this replay already includes the new rows.
      const value = replayValue(ctx, streamId);
      ctx.db.counterState.insert({ streamId, version: result.version, value });
      return;
    }

    let value = current.value;
    for (const row of rows) value = evolve(value, row.data);
    ctx.db.counterState.streamId.update({ streamId, version: result.version, value });
  },
});

/**
 * Anonymous read model: identical rows for every subscriber, computed once.
 * Only expose counters that are meant to be world-readable. For anything
 * scoped to a caller, use `spacetimedb.view` keyed on `ctx.sender` instead.
 */
export const counterSummary = spacetimedb.anonymousView(
  { name: 'counter_summary', public: true },
  t.array(counterState.rowType),
  (ctx) => [...ctx.db.counterState.iter()],
);
