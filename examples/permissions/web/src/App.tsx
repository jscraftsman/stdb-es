import { useMemo } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import type { Identity } from 'spacetimedb';
import { GoogleSignIn } from './auth/GoogleSignIn.js';
import { decodeCredential } from './auth/google.js';
import { readToken } from './config.js';
import { CounterPanel, type CounterRow } from './domains/counter/CounterPanel.js';
import { COUNTER_KIND } from './domains/counter/constants.js';
import { usePermissionsCommands } from './domains/counter/usePermissionsCommands.js';
import { tables } from './generated/index.js';

function owns(row: CounterRow, identity: Identity | undefined): boolean {
  return Boolean(identity && row.owner?.toHexString() === identity.toHexString());
}

export default function App() {
  const { isActive, identity } = useSpacetimeDB();
  const [publicRows, publicReady] = useTable(tables.publicSummary);
  const [privateRows, privateReady] = useTable(tables.privateSummary);
  const commands = usePermissionsCommands();

  const token = readToken();
  const signedIn = token !== undefined;
  const profile = useMemo(() => decodeCredential(token ?? ''), [token]);

  const globalRow = publicRows.find((row) => row.counterKind === COUNTER_KIND.global);
  const publicOwnedRows: (CounterRow | undefined)[] = publicRows.filter(
    (row) => row.counterKind === COUNTER_KIND.publicOwned,
  );
  if (publicOwnedRows.length === 0 && signedIn) publicOwnedRows.push(undefined);
  const privateRow = privateRows.find((row) => row.counterKind === COUNTER_KIND.privateOwned);
  const accountLabel = profile?.email ?? profile?.name ?? 'your Google account';

  return (
    <main>
      <header>
        <h1>stdb-es permissions</h1>
        <p>
          {isActive ? 'Connected' : 'Connecting…'} · identity{' '}
          {identity ? `${identity.toHexString().slice(0, 12)}…` : 'pending'}
        </p>
        <GoogleSignIn signedIn={signedIn} profile={profile} />
      </header>

      <div className="grid">
        <CounterPanel
          accent="global"
          title="C1 · Global public"
          description="One app-wide counter. Anyone, including anonymous visitors, can read and write."
          row={globalRow}
          ready={publicReady}
          disabled={!isActive}
          onIncrement={(by) => commands.sendNew('incrementGlobal', { by })}
          onDecrement={(by) => commands.sendNew('decrementGlobal', { by })}
          onReset={() => commands.sendNew('resetGlobal', {})}
          note="Public read · public write · exactly one instance · no sign-in required"
        />

        {signedIn
          ? publicOwnedRows.map((row) => {
              const mine = row === undefined || owns(row, identity);
              const owner = row?.ownerEmail ?? (mine ? accountLabel : 'another user');
              return (
                <CounterPanel
                  key={row?.streamId ?? 'c2-pending'}
                  accent="publicOwned"
                  title={`C2 · ${owner}`}
                  description={
                    mine
                      ? 'One counter per Google user. Everyone can read it; only its owner can write.'
                      : 'A public counter owned by another Google user. Reads are allowed; writes are not.'
                  }
                  row={row}
                  ready={publicReady}
                  disabled={!isActive}
                  readOnly={!mine}
                  onIncrement={(by) => commands.sendNew('incrementPublicMine', { by })}
                  onDecrement={(by) => commands.sendNew('decrementPublicMine', { by })}
                  onReset={() => commands.sendNew('resetPublicMine', {})}
                  note={
                    mine
                      ? 'Public read · owner-only write · visible to everyone'
                      : 'Public read · read-only for this account'
                  }
                />
              );
            })
          : null}

        {signedIn ? (
          <CounterPanel
            accent="privateOwned"
            title={`C3 · ${accountLabel}`}
            description="One counter per Google user. Only that user’s connection receives its row."
            row={privateRow}
            ready={privateReady}
            disabled={!isActive}
            onIncrement={(by) => commands.sendNew('incrementPrivateMine', { by })}
            onDecrement={(by) => commands.sendNew('decrementPrivateMine', { by })}
            onReset={() => commands.sendNew('resetPrivateMine', {})}
            note="Owner-only read · owner-only write · other streams are filtered by the view"
          />
        ) : null}
      </div>
    </main>
  );
}
