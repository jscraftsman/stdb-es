import { useMemo } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { GoogleSignIn } from './auth/GoogleSignIn.js';
import { decodeCredential } from './auth/google.js';
import { readToken } from './config.js';
import { CounterPanel } from './domains/counter/CounterPanel.js';
import { COUNTER_KIND } from './domains/counter/constants.js';
import { usePermissionsCommands } from './domains/counter/usePermissionsCommands.js';
import { tables } from './generated/index.js';

export default function App() {
  const { isActive, identity } = useSpacetimeDB();
  const [publicRows, publicReady] = useTable(tables.publicSummary);
  const [privateRows, privateReady] = useTable(tables.privateSummary);
  const commands = usePermissionsCommands();

  const signedIn = readToken() !== undefined;
  const profile = useMemo(() => decodeCredential(readToken() ?? ''), [signedIn]);

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
          title="C1 · Global public"
          description="One app-wide counter. Anyone, including anonymous visitors, can read and write."
          kind={COUNTER_KIND.global}
          rows={publicRows}
          ready={publicReady}
          onIncrement={(by) => commands.sendNew('incrementGlobal', { by })}
          onDecrement={(by) => commands.sendNew('decrementGlobal', { by })}
          onReset={() => commands.sendNew('resetGlobal', {})}
          note="Public read · public write · exactly one instance"
        />

        <CounterPanel
          title="C2 · Public read, private write"
          description="One counter per Google user. Everyone can read it; only its owner can write."
          kind={COUNTER_KIND.publicOwned}
          rows={publicRows}
          ready={publicReady}
          disabled={!signedIn}
          onIncrement={(by) => commands.sendNew('incrementPublicMine', { by })}
          onDecrement={(by) => commands.sendNew('decrementPublicMine', { by })}
          onReset={() => commands.sendNew('resetPublicMine', {})}
          note={signedIn ? 'Public read · owner-only write' : 'Sign in with Google to write your counter.'}
        />

        <CounterPanel
          title="C3 · Private read and write"
          description="One counter per Google user. Only that user’s connection receives its row."
          kind={COUNTER_KIND.privateOwned}
          rows={privateRows}
          ready={privateReady}
          disabled={!signedIn}
          onIncrement={(by) => commands.sendNew('incrementPrivateMine', { by })}
          onDecrement={(by) => commands.sendNew('decrementPrivateMine', { by })}
          onReset={() => commands.sendNew('resetPrivateMine', {})}
          note={
            signedIn
              ? 'Owner-only read · owner-only write · other streams are filtered by the view'
              : 'Sign in with Google to read and write your private counter.'
          }
        />
      </div>
    </main>
  );
}
