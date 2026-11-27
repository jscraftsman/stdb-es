import { useState } from 'react';
import type { Identity } from 'spacetimedb';

export type CounterRow = {
  streamId: string;
  counterKind: string;
  version: number;
  value: bigint;
  owner?: Identity;
  ownerEmail?: string;
};

export type CounterAccent = 'global' | 'publicOwned' | 'privateOwned';

type Props = {
  title: string;
  description: string;
  accent: CounterAccent;
  row: CounterRow | undefined;
  ready: boolean;
  onIncrement: (by: number) => Promise<unknown>;
  onDecrement: (by: number) => Promise<unknown>;
  onReset: () => Promise<unknown>;
  disabled?: boolean;
  readOnly?: boolean;
  note?: string;
};

function errorMessage(cause: unknown): string {
  const detail = `${(cause as { message?: string })?.message ?? cause}`;
  if (detail.includes('AUTH_UNAUTHENTICATED') || detail.includes('AUTH_INVALID_TOKEN')) {
    return 'Sign in with Google with this application’s client id, then try again.';
  }
  if (detail.includes('CMD_UNAUTHORIZED')) return 'Only this counter’s owner can change it.';
  if (detail.includes('CMD_INVALID_COMMAND')) return 'Enter a positive whole-number amount.';
  return `Command rejected: ${detail}`;
}

function ownerLabel(row: CounterRow | undefined): string {
  if (!row) return 'Owner pending';
  if (row.ownerEmail) return `Owner ${row.ownerEmail}`;
  if (row.owner) return `Owner ${row.owner.toHexString()}`;
  return 'Owner app-wide';
}

export function CounterPanel({
  title,
  description,
  accent,
  row,
  ready,
  onIncrement,
  onDecrement,
  onReset,
  disabled = false,
  readOnly = false,
  note,
}: Props) {
  const [by, setBy] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage('Command accepted. The view will refresh when the subscription applies.');
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`panel panel--${accent}`}>
      <h2>{title}</h2>
      <p className="description">{description}</p>
      <p className="value" aria-live="polite">
        {ready ? String(row?.value ?? 0n) : 'Loading…'}
      </p>
      <p className="meta">
        {ownerLabel(row)} · {row ? `version ${row.version}` : 'no state row yet'} · stream is
        module-derived
      </p>

      <label>
        Amount
        <input
          type="number"
          min={1}
          value={by}
          onChange={(event) => setBy(Number(event.target.value))}
        />
      </label>

      <div className="actions">
        <button
          disabled={busy || disabled || readOnly}
          onClick={() => run(() => onIncrement(by))}
        >
          Increment
        </button>
        <button
          disabled={busy || disabled || readOnly}
          onClick={() => run(() => onDecrement(by))}
        >
          Decrement
        </button>
        <button disabled={busy || disabled || readOnly} onClick={() => run(onReset)}>
          Reset
        </button>
      </div>

      {readOnly ? (
        <p className="note">Read-only: this counter belongs to another Google account.</p>
      ) : null}
      {note ? <p className="note">{note}</p> : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
