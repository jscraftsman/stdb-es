import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './generated/index.js';
import { CounterPanel } from './domains/counter/CounterPanel.js';
import { TABLES_COUNTER } from './domains/counter/constants.js';

export default function App() {
  const { isActive } = useSpacetimeDB();
  const [rows, ready] = useTable(tables.counterSummary);

  return (
    <main>
      <header>
        <h1>stdb-es counter set</h1>
        <p>
          {isActive ? 'Connected' : 'Connecting…'} ·{' '}
          {ready ? `${TABLES_COUNTER.summary} ready` : 'Waiting for the view'}
        </p>
      </header>
      <CounterPanel rows={rows} ready={ready} />
    </main>
  );
}
