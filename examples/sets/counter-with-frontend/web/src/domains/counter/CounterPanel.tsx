import { useMemo, useState } from 'react';
import { useReducer as useSpacetimeReducer } from 'spacetimedb/react';
import { ES_ERROR, NO_STREAM, esErrorCode } from 'stdb-es';
import { reducers } from '../../generated/index.js';
import { makeCounterStore } from './api.js';
import { EVENT_TYPES_COUNTER, STREAM_TYPES_COUNTER } from './constants.js';
import { COUNTER_STREAM_ID } from './ids.js';
import type { CounterEvent } from './registry.js';

type CounterRow = { streamId: string; version: number; value: bigint };

type Props = {
  rows: readonly CounterRow[];
  ready: boolean;
};

export function CounterPanel({ rows, ready }: Props) {
  const callAppend = useSpacetimeReducer(reducers.appendEvents);
  const store = useMemo(() => makeCounterStore(callAppend), [callAppend]);

  const [by, setBy] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const row = rows.find((candidate) => candidate.streamId === COUNTER_STREAM_ID);
  const version = row?.version ?? NO_STREAM;

  async function append(events: CounterEvent[]) {
    setBusy(true);
    setMessage(null);
    try {
      await store.append(COUNTER_STREAM_ID, STREAM_TYPES_COUNTER.Counter, events, {
        expectedVersion: version,
      });
      setMessage('Committed. The view will refresh when the subscription applies.');
    } catch (cause) {
      setMessage(
        esErrorCode(cause) === ES_ERROR.EXPECTED_VERSION_MISMATCH
          ? 'Someone updated the counter first. The view will refresh.'
          : 'Could not append the event.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>Counter</h2>
      <p className="value" aria-live="polite">
        {ready ? String(row?.value ?? 0n) : 'Loading…'}
      </p>
      <p className="meta">stream {COUNTER_STREAM_ID} · version {row?.version ?? 0}</p>

      <label>
        Amount
        <input
          type="number"
          value={by}
          onChange={(event) => setBy(Number(event.target.value))}
        />
      </label>

      <div className="actions">
        <button
          disabled={busy}
          onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Incremented, by }])}
        >
          Increment
        </button>
        <button
          disabled={busy}
          onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Decremented, by }])}
        >
          Decrement
        </button>
        <button disabled={busy} onClick={() => append([{ kind: EVENT_TYPES_COUNTER.Reset }])}>
          Reset
        </button>
      </div>

      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
