#!/usr/bin/env node
/**
 * Live smoke test for the M7 consumer integration kit.
 *
 * Exercises the compiled public `stdb-es/testing/integration` entry against a
 * real local server: create/publish, owner and anonymous SQL, reducers,
 * subscriptions, concurrency, external URL mode, and teardown.
 *
 *   npm run smoke:integration
 */
import { viewQuery } from '../dist/client/index.js';
import {
  createIntegrationEnv,
  integrationDatabase,
} from '../dist/testing/integration/index.js';

const modulePath = 'examples/sets/counter-with-frontend/spacetimedb';
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`  ok  ${label}`);
}

function event(eventId, by) {
  return {
    event_id: eventId,
    event_type: 'Incremented',
    data: JSON.stringify({ kind: 'Incremented', by }),
    metadata: null,
  };
}

async function expectRejection(label, callback, needle) {
  try {
    await callback();
  } catch (error) {
    check(label, `${error?.message ?? error}`.includes(needle));
    return;
  }
  throw new Error(`${label} — call unexpectedly succeeded`);
}

async function append(env, streamId, eventId, by, expectedVersion = 0, options) {
  await env.call(
    'append_events',
    [streamId, 'Counter', expectedVersion, [event(eventId, by)], null],
    options,
  );
}

async function run() {
  const local = await createIntegrationEnv({ modulePath });
  let external;

  try {
    console.log('Local mode:');
    check('database name generated', /^stdb-es-test-[0-9a-f]{8}$/.test(local.database), local.database);
    check('server URL is HTTP', /^http:\/\/127\.0\.0\.1:\d+$/.test(local.server), local.server);

    // Anonymous CLI calls use distinct throwaway identities.
    await Promise.all([
      append(local, 'concurrent-1', 'smoke-c1-1', 1, 0, { anonymous: true }),
      append(local, 'concurrent-2', 'smoke-c2-1', 2, 0, { anonymous: true }),
      append(local, 'concurrent-3', 'smoke-c3-1', 3, 0, { anonymous: true }),
    ]);

    const ownerRows = (await local.sql('SELECT * FROM es_event')).rows;
    check('concurrent appends committed', ownerRows.length === 3, `${ownerRows.length} rows`);
    check(
      'concurrent appends used distinct identities',
      new Set(ownerRows.map((row) => JSON.stringify(row.created_by))).size === 3,
    );

    const client = await local.connect({
      anonymous: true,
      queries: ['SELECT * FROM counter_summary'],
    });
    await client.waitFor(
      (c) => c.rows('counter_summary').length === 3,
      { description: 'initial subscription rows' },
    );
    check('initial subscription rows delivered', client.rows('counter_summary').length === 3);

    await append(local, 'concurrent-1', 'smoke-c1-2', 4, 1);
    await client.waitFor(
      (c) =>
        c.rows('counter_summary').some(
          (row) => row.stream_id === 'concurrent-1' && row.value === 5,
        ),
      { description: 'subscription update after append' },
    );
    check('subscription received the update', true);

    await client.subscribe(viewQuery('stream_events', ['concurrent-1']));
    await client.waitFor((c) => c.rows('stream_events').length === 2, {
      description: 'parameterized view rows',
    });
    check('parameterized view subscription converged', true);

    await expectRejection(
      'stale expected version is rejected end to end',
      () => append(local, 'concurrent-1', 'smoke-stale', 100, 0),
      'EXPECTED_VERSION_MISMATCH',
    );
    check(
      'rejected append wrote nothing',
      (await local.sql('SELECT * FROM es_event')).rows.length === 4,
    );

    await local.sql("DELETE FROM counter_state WHERE stream_id = 'concurrent-1'");
    await append(local, 'concurrent-1', 'smoke-c1-3', 2, 2);
    const rebuilt = (await local.sql("SELECT * FROM counter_state WHERE stream_id = 'concurrent-1'"))
      .rows;
    check('lost cache is rebuilt by replay', rebuilt[0]?.value === 7, JSON.stringify(rebuilt));

    const anonymousRows = (await local.sql('SELECT * FROM counter_summary', { anonymous: true })).rows;
    check('anonymous SQL sees the public view', anonymousRows.length === 3, `${anonymousRows.length} rows`);
    check(
      'anonymous view reflects the replayed cache',
      anonymousRows.some((row) => row.stream_id === 'concurrent-1' && row.value === 7),
    );

    console.log('External URL mode:');

    external = await createIntegrationEnv({
      server: local.server,
      database: integrationDatabase('stdb-es-external'),
      modulePath,
    });
    await append(external, 'external-1', 'smoke-external-1', 9);
    const externalRows = (await external.sql('SELECT * FROM es_event')).rows;
    check('external env published and called a reducer', externalRows.length === 1);

    await external.dispose();
    external = undefined;
    const health = await fetch(`${local.server}/v1/health`);
    check('external disposal preserved the shared server', health.ok, `HTTP ${health.status}`);
  } finally {
    if (external) await external.dispose().catch(() => undefined);
    await local.dispose();
  }

  console.log(`\n${checks} integration-kit checks passed`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
