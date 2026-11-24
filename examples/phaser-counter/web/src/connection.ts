import { DATABASE_NAME, SPACETIMEDB_URI, readToken, writeToken } from './config.js';
import { DbConnection, tables, type SubscriptionHandle } from './generated/index.js';

export type SummaryRow = { streamId: string; version: number; value: bigint };
export type SummarySnapshot = { rows: readonly SummaryRow[]; ready: boolean };

/**
 * The example owns one SpacetimeDB connection. Framework code receives plain
 * callbacks and controls the subscribe/unsubscribe/disconnect lifecycle.
 */
export type CounterConnection = {
  connect: () => void;
  subscribeToSummary: () => void;
  unsubscribeFromSummary: () => void;
  disconnect: () => void;
  getDbConnection: () => DbConnection | undefined;
  onStatus: (listener: (status: string) => void) => () => void;
  onSummary: (listener: (snapshot: SummarySnapshot) => void) => () => void;
};

export function createCounterConnection(): CounterConnection {
  const statusListeners = new Set<(status: string) => void>();
  const summaryListeners = new Set<(snapshot: SummarySnapshot) => void>();
  let status = 'Connecting…';
  let ready = false;
  let connection: DbConnection | undefined;
  let subscription: SubscriptionHandle | undefined;
  let removeTableListeners: (() => void) | undefined;

  function publishStatus(next: string): void {
    status = next;
    for (const listener of statusListeners) listener(status);
  }

  function publishSummary(): void {
    const rows = connection
      ? (Array.from(connection.db.counterSummary.iter()) as SummaryRow[])
      : [];
    const snapshot: SummarySnapshot = { rows, ready };
    for (const listener of summaryListeners) listener(snapshot);
  }

  function onStatus(listener: (status: string) => void): () => void {
    statusListeners.add(listener);
    listener(status);
    return () => statusListeners.delete(listener);
  }

  function onSummary(listener: (snapshot: SummarySnapshot) => void): () => void {
    summaryListeners.add(listener);
    publishSummary();
    return () => summaryListeners.delete(listener);
  }

  function connect(): void {
    if (connection) return;

    connection = DbConnection.builder()
      .withUri(SPACETIMEDB_URI)
      .withDatabaseName(DATABASE_NAME)
      .withToken(readToken())
      .withAutomaticReconnect()
      .onConnect((_connection, _identity, token) => {
        writeToken(token);
        publishStatus(`Connected · ${DATABASE_NAME}`);
        subscribeToSummary();
      })
      .onAutomaticReconnect(() => {
        publishStatus(`Reconnected · ${DATABASE_NAME}`);
        subscribeToSummary();
      })
      .onDisconnect((_context, error, nextAttempt) => {
        subscription?.unsubscribe();
        subscription = undefined;
        ready = false;
        publishSummary();
        publishStatus(
          error
            ? `Disconnected: ${error.message}`
            : nextAttempt
              ? `Disconnected · retry ${nextAttempt} scheduled`
              : 'Disconnected',
        );
      })
      .onConnectError((_context, error) => publishStatus(`Connection error: ${error.message}`))
      .build();

    const table = connection.db.counterSummary;
    const refresh = (): void => publishSummary();
    table.onInsert(refresh);
    table.onDelete(refresh);
    table.onUpdate?.(refresh);
    removeTableListeners = () => {
      table.removeOnInsert(refresh);
      table.removeOnDelete(refresh);
      table.removeOnUpdate?.(refresh);
    };
  }

  function subscribeToSummary(): void {
    if (!connection || subscription) return;

    subscription = connection
      .subscriptionBuilder()
      .onApplied(() => {
        ready = true;
        publishSummary();
        publishStatus(`Connected · ${DATABASE_NAME} · view ready`);
      })
      .onError((context) => {
        ready = false;
        publishSummary();
        publishStatus(`Subscription error: ${context.event?.message ?? 'unknown error'}`);
      })
      .subscribe(tables.counterSummary);
  }

  function unsubscribeFromSummary(): void {
    subscription?.unsubscribe();
    subscription = undefined;
    ready = false;
    publishSummary();
  }

  function disconnect(): void {
    unsubscribeFromSummary();
    removeTableListeners?.();
    removeTableListeners = undefined;
    connection?.disconnect();
    connection = undefined;
    publishStatus('Disconnected');
  }

  return {
    connect,
    subscribeToSummary,
    unsubscribeFromSummary,
    disconnect,
    getDbConnection: () => connection,
    onStatus,
    onSummary,
  };
}
