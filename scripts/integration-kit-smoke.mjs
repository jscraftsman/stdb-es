#!/usr/bin/env node
/**
 * Live smoke test for the consumer integration kit.
 *
 * Exercises the compiled public `stdb-es/testing/integration` entry against a
 * real local server: create/publish, owner and anonymous SQL, command reducers,
 * idempotent retries, ownership rejection, subscriptions, external URL mode,
 * and teardown.
 *
 *   npm run smoke:integration
 */
import { streamId } from '../dist/index.js';
import { viewQuery } from '../dist/client/index.js';
import {
  createIntegrationEnv,
  integrationDatabase,
} from '../dist/testing/integration/index.js';

const modulePath = 'test/integration-module';
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (!condition) throw new Error(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
  console.log(`  ok  ${label}`);
}

async function expectRejection(label, callback, needle) {
  try {
    await callback();
  } catch (error) {
    const detail = `${error?.message ?? error}`;
    check(label, detail.includes(needle), detail);
    return;
  }
  throw new Error(`${label} — call unexpectedly succeeded`);
}

function counterStream(name) {
  return streamId('counter', name);
}

function claim(env, name, commandId, options) {
  return env.call('claim_counter', [name, commandId], options);
}

function increment(env, name, commandId, by, options) {
  return env.call('increment', [name, commandId, by], options);
}

async function run() {
  const local = await createIntegrationEnv({ modulePath });
  let external;

  try {
    console.log('Local mode:');
    check('database name generated', /^stdb-es-test-[0-9a-f]{8}$/.test(local.database), local.database);
    check('server URL is HTTP', /^http:\/\/127\.0\.0\.1:\d+$/.test(local.server), local.server);

    await Promise.all([
      claim(local, 'concurrent-1', 'smoke-c1-claim'),
      claim(local, 'concurrent-2', 'smoke-c2-claim'),
      claim(local, 'concurrent-3', 'smoke-c3-claim'),
    ]);
    await Promise.all([
      increment(local, 'concurrent-1', 'smoke-c1-1', 1),
      increment(local, 'concurrent-2', 'smoke-c2-1', 2),
      increment(local, 'concurrent-3', 'smoke-c3-1', 3),
    ]);

    const ownerRows = (await local.sql('SELECT * FROM es_event')).rows;
    check('concurrent commands committed', ownerRows.length === 3, `${ownerRows.length} rows`);
    check(
      'command ids produced distinct event ids',
      new Set(ownerRows.map((row) => row.event_id)).size === 3,
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

    await increment(local, 'concurrent-1', 'smoke-c1-2', 4);
    await client.waitFor(
      (c) =>
        c.rows('counter_summary').some(
          (row) => row.stream_id === counterStream('concurrent-1') && row.value === 5,
        ),
      { description: 'subscription update after command' },
    );
    check('subscription received the update', true);

    await client.subscribe(viewQuery('stream_events', [counterStream('concurrent-1')]));
    await client.waitFor((c) => c.rows('stream_events').length === 2, {
      description: 'parameterized view rows',
    });
    check('parameterized view subscription converged', true);

    await increment(local, 'concurrent-1', 'smoke-c1-2', 4);
    check(
      'replayed command wrote no extra event',
      (await local.sql('SELECT * FROM es_event')).rows.length === 4,
    );
    const afterReplay = (
      await local.sql(
        `SELECT * FROM counter_state WHERE stream_id = '${counterStream('concurrent-1')}'`,
      )
    ).rows;
    check('replayed command did not double-apply', afterReplay[0]?.value === 5, JSON.stringify(afterReplay));

    // The CLI masks reducer error text on throwaway identities; the assertion
    // below checks that no event was written.
    await expectRejection(
      'non-owner command is rejected',
      () => increment(local, 'concurrent-1', 'smoke-intruder', 1, { anonymous: true }),
      '',
    );
    check(
      'rejected command wrote nothing',
      (await local.sql('SELECT * FROM es_event')).rows.length === 4,
    );

    await local.sql(`DELETE FROM counter_state WHERE stream_id = '${counterStream('concurrent-1')}'`);
    await increment(local, 'concurrent-1', 'smoke-c1-3', 2);
    const rebuilt = (
      await local.sql(`SELECT * FROM counter_state WHERE stream_id = '${counterStream('concurrent-1')}'`)
    ).rows;
    check('lost cache is rebuilt by replay', rebuilt[0]?.value === 7, JSON.stringify(rebuilt));

    const anonymousRows = (await local.sql('SELECT * FROM counter_summary', { anonymous: true })).rows;
    check('anonymous SQL sees the public view', anonymousRows.length === 3, `${anonymousRows.length} rows`);
    check(
      'anonymous view reflects the replayed cache',
      anonymousRows.some((row) => row.stream_id === counterStream('concurrent-1') && row.value === 7),
    );

    console.log('Attached database mode:');

    const eventsBeforeAttach = (await local.sql('SELECT * FROM es_event')).rows.length;
    const attached = await createIntegrationEnv({
      server: local.server,
      database: local.database,
      modulePath,
      publish: false,
    });
    await attached.dispose();
    const eventsAfterAttach = (await local.sql('SELECT * FROM es_event')).rows.length;
    check(
      'attached env disposal preserved the existing database',
      eventsAfterAttach === eventsBeforeAttach,
      `${eventsBeforeAttach} before, ${eventsAfterAttach} after`,
    );

    console.log('Other command reducers:');

    await claim(local, 'decrement-1', 'smoke-dec-claim');
    await local.call('decrement', ['decrement-1', 'smoke-dec-1', 3]);
    await claim(local, 'reset-1', 'smoke-reset-claim');
    await local.call('reset', ['reset-1', 'smoke-reset-1']);
    const [decrementRows, resetRows] = await Promise.all([
      local.sql(
        `SELECT * FROM counter_state WHERE stream_id = '${counterStream('decrement-1')}'`,
      ),
      local.sql(`SELECT * FROM counter_state WHERE stream_id = '${counterStream('reset-1')}'`),
    ]);
    const commandRows = [...decrementRows.rows, ...resetRows.rows];
    check(
      'decrement and reset updated their streams',
      commandRows.length === 2 &&
        commandRows.some(
          (row) => row.stream_id === counterStream('decrement-1') && row.value === -3,
        ) &&
        commandRows.some((row) => row.stream_id === counterStream('reset-1') && row.value === 0),
      JSON.stringify(commandRows),
    );
    const [decrementEvents, resetEvents] = await Promise.all([
      local.sql(`SELECT event_type FROM es_event WHERE stream_id = '${counterStream('decrement-1')}'`),
      local.sql(`SELECT event_type FROM es_event WHERE stream_id = '${counterStream('reset-1')}'`),
    ]);
    const commandEventTypes = [...decrementEvents.rows, ...resetEvents.rows].map(
      (row) => row.event_type,
    );
    check(
      'decrement and reset derived their event types',
      commandEventTypes.includes('Decremented') && commandEventTypes.includes('Reset'),
      JSON.stringify(commandEventTypes),
    );

    console.log('External URL mode:');

    external = await createIntegrationEnv({
      server: local.server,
      database: integrationDatabase('stdb-es-external'),
      modulePath,
    });
    await claim(external, 'external-1', 'smoke-external-claim');
    await increment(external, 'external-1', 'smoke-external-1', 9);
    const externalRows = (await external.sql('SELECT * FROM es_event')).rows;
    check('external env published and called a command reducer', externalRows.length === 1);

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
