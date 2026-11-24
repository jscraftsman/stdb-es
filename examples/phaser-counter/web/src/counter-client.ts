import type { CounterConnection } from './connection.js';
import { makeCounterCommands, type CounterCommandClient } from './domains/counter/api.js';

/**
 * Binds the live generated reducer accessors to the same intent-only command
 * client used by the React reference UI. No Phaser API is involved.
 */
export function createSceneCommands(connection: CounterConnection): CounterCommandClient {
  function requireConnection() {
    const db = connection.getDbConnection();
    if (!db) throw new Error('Not connected to SpacetimeDB');
    return db;
  }

  return makeCounterCommands({
    increment: (command) => requireConnection().reducers.increment(command),
    decrement: (command) => requireConnection().reducers.decrement(command),
    reset: (command) => requireConnection().reducers.reset(command),
  });
}
