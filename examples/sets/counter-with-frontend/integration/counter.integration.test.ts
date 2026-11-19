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
  STREAM_TYPES_COUNTER,
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

function increment(eventId: string, by: number) {
  return {
    event_id: eventId,
    event_type: EVENT_TYPES_COUNTER.Incremented,
    data: JSON.stringify({ kind: EVENT_TYPES_COUNTER.Incremented, by }),
    metadata: null,
  };
}

function append(
  id: string,
  expectedVersion: number,
  events: readonly ReturnType<typeof increment>[],
  options?: IntegrationCallOptions,
): Promise<void> {
  return env.call(
    'append_events',
    [id, STREAM_TYPES_COUNTER.Counter, expectedVersion, events, null],
    options,
  );
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
  it('appends through the reducer and reads owner and anonymous views', async () => {
    const id = stream('publish');

    await append(id, 0, [increment('integration-publish-1', 5)], { anonymous: true });

    const events = await eventRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_id: 'integration-publish-1',
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

  it('rejects a stale expected version with a fresh event id', async () => {
    const id = stream('stale');
    await append(id, 0, [increment('integration-stale-1', 2)]);

    await expect(append(id, 0, [increment('integration-stale-2', 99)])).rejects.toThrow(
      /EXPECTED_VERSION_MISMATCH/,
    );

    const events = await eventRows(id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_id).toBe('integration-stale-1');
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
      await append(id, 0, [increment('integration-live-1', 2)]);
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

      await append(id, 1, [increment('integration-live-2', 3)]);
      await client.waitFor(
        (c) =>
          c.rows(TABLES_COUNTER.summary).some(
            (row) => row.stream_id === id && row.value === 5,
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
      const id = stream('external');
      await external.call('append_events', [
        id,
        STREAM_TYPES_COUNTER.Counter,
        0,
        [increment('integration-external-1', 9)],
        null,
      ]);

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
