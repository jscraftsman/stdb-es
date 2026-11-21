import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { streamId } from 'stdb-es';
import { sqlLiteral, tableQuery, viewQuery } from 'stdb-es/client';
import {
  createIntegrationEnv,
  type IntegrationCallOptions,
  type IntegrationEnv,
  type IntegrationRow,
} from 'stdb-es/testing/integration';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
  TABLES_COUNTER,
} from '../spacetimedb/src/domains/counter/constants.js';

const exampleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let env: IntegrationEnv;

beforeAll(async () => {
  // One call owns the server, publishes the module, and creates the database.
  env = await createIntegrationEnv({
    cwd: exampleRoot,
    modulePath: 'spacetimedb',
  });
});

afterAll(async () => {
  await env?.dispose();
});

function stream(name: string): string {
  return streamId(STREAM_PREFIXES_COUNTER.counter, name);
}

function increment(
  counterId: string,
  commandId: string,
  by: number,
  options?: IntegrationCallOptions,
): Promise<void> {
  return env.call('increment', [counterId, by, commandId], options);
}

function decrement(
  counterId: string,
  commandId: string,
  by: number,
): Promise<void> {
  return env.call('decrement', [counterId, by, commandId]);
}

async function eventRows(id: string): Promise<readonly IntegrationRow[]> {
  const result = await env.sql(
    `SELECT event_id, version, event_type, created_by FROM es_event WHERE stream_id = ${sqlLiteral(id)}`,
  );
  return result.rows;
}

async function summaryRow(id: string): Promise<IntegrationRow | undefined> {
  const result = await env.sql(
    `${tableQuery(TABLES_COUNTER.summary)} WHERE stream_id = ${sqlLiteral(id)}`,
    { anonymous: true },
  );
  return result.rows[0];
}

describe('counter example set against a real server', () => {
  it('calls a command reducer and reads owner and anonymous views', async () => {
    const id = stream('publish');

    await increment('publish', 'integration-publish-1', 5, { anonymous: true });

    const events = await eventRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: 'inc-integration-publish-1',
      event_type: EVENT_TYPES_COUNTER.Incremented,
      version: 1,
    });
    expect(events[0]?.created_by).toBeDefined();

    expect(await summaryRow(id)).toMatchObject({
      stream_id: id,
      version: 1,
      value: 5,
    });
  });

  it('replays a repeated command id without appending twice', async () => {
    const id = stream('retry');

    await increment('retry', 'integration-retry-1', 2);
    await increment('retry', 'integration-retry-1', 2);

    const events = await eventRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_id).toBe('inc-integration-retry-1');
    expect(await summaryRow(id)).toMatchObject({ version: 1, value: 2 });
  });

  it('rejects a non-owner targeting another caller’s counter', async () => {
    const id = stream('ownership');
    await increment('ownership', 'integration-owner-1', 3);

    await expect(
      increment('ownership', 'integration-intruder-1', 99, { anonymous: true }),
    ).rejects.toThrow();

    expect(await eventRows(id)).toHaveLength(1);
    expect(await summaryRow(id)).toMatchObject({ value: 3 });
  });

  it('waits for the anonymous view and parameterized event view to converge', async () => {
    const id = stream('live');
    const client = await env.connect({
      anonymous: true,
      queries: [
        tableQuery(TABLES_COUNTER.summary),
        viewQuery(TABLES_COUNTER.streamEvents, [id]),
      ],
    });

    try {
      await increment('live', 'integration-live-1', 2);
      await client.waitFor(
        (c) =>
          c.rows(TABLES_COUNTER.summary).some(
            (row) => row.stream_id === id && row.value === 2,
          ),
        { description: 'first anonymous summary row' },
      );
      await client.waitFor((c) => c.rows(TABLES_COUNTER.streamEvents).length === 1, {
        description: 'first parameterized view row',
      });

      await decrement('live', 'integration-live-2', 3);
      await client.waitFor(
        (c) =>
          c.rows(TABLES_COUNTER.summary).some(
            (row) => row.stream_id === id && row.value === -1,
          ),
        { description: 'updated anonymous summary row' },
      );
      await client.waitFor((c) => c.rows(TABLES_COUNTER.streamEvents).length === 2, {
        description: 'second parameterized view row',
      });
    } finally {
      await client.close();
    }
  });

  it('can reuse an external server URL without owning the server process', async () => {
    const external = await createIntegrationEnv({
      server: env.server,
      cwd: exampleRoot,
      modulePath: 'spacetimedb',
    });

    try {
      await external.call('increment', ['external', 9, 'integration-external-1']);
      const id = stream('external');
      const result = await external.sql(
        `${tableQuery(TABLES_COUNTER.summary)} WHERE stream_id = ${sqlLiteral(id)}`,
        { anonymous: true },
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ stream_id: id, value: 9 });
    } finally {
      await external.dispose();
    }

    // The shared server belongs to the outer env and must still be alive.
    const health = await fetch(`${env.server}/v1/health`);
    expect(health.ok).toBe(true);
  });
});
