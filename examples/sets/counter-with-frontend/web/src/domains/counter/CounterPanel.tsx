import { useMemo, useState } from 'react';
import { useReducer as useSpacetimeReducer } from 'spacetimedb/react';
import { reducers } from '../../generated/index.js';
import { makeCounterCommands, type CounterCommands } from './api.js';
import { COUNTER_ID, COUNTER_STREAM_ID } from './ids.js';

type CounterRow = { streamId: string; version: number; value: bigint };

type Props = {
  rows: readonly CounterRow[];
  ready: boolean;
};

export function CounterPanel({ rows, ready }: Props) {
  const callIncrement = useSpacetimeReducer(reducers.increment);
  const callDecrement = useSpacetimeReducer(reducers.decrement);
  const callReset = useSpacetimeReducer(reducers.reset);
  const commands = useMemo(
    () =>
      makeCounterCommands({
        increment: callIncrement,
        decrement: callDecrement,
        reset: callReset,
      }),
    [callIncrement, callDecrement, callReset],
  );

  const [by, setBy] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const row = rows.find((candidate) => candidate.streamId === COUNTER_STREAM_ID);

  async function send<K extends keyof CounterCommands>(name: K, command: CounterCommands[K]) {
    setBusy(true);
    setMessage(null);
    try {
      // sendNew returns a retryable envelope; this demo does not persist it.
      await commands.sendNew(name, command);
      setMessage('Command accepted. The view will refresh when the subscription applies.');
    } catch (cause) {
      const detail = `${(cause as { message?: string })?.message ?? cause}`;
      setMessage(
        detail.includes('CMD_UNAUTHORIZED')
          ? 'Only this counter’s owner can change it.'
          : 'Command rejected.',
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
          onClick={() => send('increment', { counterId: COUNTER_ID, by })}
        >
          Increment
        </button>
        <button
          disabled={busy}
          onClick={() => send('decrement', { counterId: COUNTER_ID, by })}
        >
          Decrement
        </button>
        <button
          disabled={busy}
          onClick={() => send('reset', { counterId: COUNTER_ID })}
        >
          Reset
        </button>
      </div>

      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
