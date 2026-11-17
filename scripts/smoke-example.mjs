#!/usr/bin/env node
/**
 * Publish smoke test.
 *
 * Runs after `example:publish:fresh`, against the live local server. It proves
 * the things the unit tests cannot: the module publishes, the generated
 * `append_events` reducer has the expected wire signature, private tables are
 * readable by the database owner, and the app's anonymous view reflects the
 * state cache for an unauthenticated caller.
 *
 *   npm run smoke
 *
 * Override with STDB_SERVER (default `local`) and STDB_DATABASE
 * (default `stdb-es-counter`).
 */
import { execFileSync } from 'node:child_process';

const SERVER = process.env.STDB_SERVER ?? 'local';
const DATABASE = process.env.STDB_DATABASE ?? 'stdb-es-counter';
const STREAM_ID = 'smoke-counter';

let checks = 0;
const failures = [];

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function run(args) {
  // `-s` must come before the subcommand's positional parts; in particular it
  // must not land after `call --`, which treats everything as reducer arguments.
  const [command, ...rest] = args;
  return execFileSync('spacetime', [command, '-s', SERVER, ...rest], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Runs one statement and returns its row arrays (snake_case keys are not mapped). */
function sql(query, { anonymous = false } = {}) {
  const args = ['sql', DATABASE, query, '--format', 'json'];
  if (anonymous) args.push('--anonymous');
  const output = run(args);
  const statements = JSON.parse(output);
  const rows = statements[0]?.rows ?? [];
  const names = (statements[0]?.schema?.elements ?? []).map((element) => element.name?.some);
  return rows.map((row) => Object.fromEntries(row.map((value, index) => [names[index], value])));
}

/** Invokes a reducer; throws on rejection, carrying the server message. */
function call(reducer, args) {
  return run(['call', DATABASE, reducer, '--', ...args.map((arg) => JSON.stringify(arg))]);
}

function expectRejection(label, reducer, args, needle) {
  checks += 1;
  try {
    call(reducer, args);
    failures.push(`${label} — reducer unexpectedly succeeded`);
    console.log(`  FAIL ${label} — reducer unexpectedly succeeded`);
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`;
    if (text.includes(needle)) {
      console.log(`  ok  ${label}`);
    } else {
      failures.push(`${label} — rejection did not mention ${needle}`);
      console.log(`  FAIL ${label} — rejection did not mention ${needle}`);
    }
  }
}

const event = (eventId, kind, by) => ({
  event_id: eventId,
  event_type: kind,
  data: JSON.stringify(by === undefined ? { kind } : { kind, by }),
  metadata: null,
});

const append = (expectedVersion, events) =>
  call('append_events', [STREAM_ID, 'Counter', expectedVersion, events, null]);

const streamVersion = () =>
  sql(`SELECT version FROM es_stream WHERE stream_id = '${STREAM_ID}'`)[0]?.version;
const state = () => sql(`SELECT version, value FROM counter_state WHERE stream_id = '${STREAM_ID}'`)[0];
const summary = () =>
  sql(`SELECT version, value FROM counter_summary WHERE stream_id = '${STREAM_ID}'`, {
    anonymous: true,
  })[0];
const events = () =>
  sql(`SELECT event_id, version FROM es_event WHERE stream_id = '${STREAM_ID}'`).sort(
    (a, b) => a.version - b.version,
  );

console.log(`Publish smoke test (${SERVER}/${DATABASE})`);

// Empty database: the module published and the private tables exist.
check('no stream before the first append', streamVersion() === undefined);

append(-1, [event('smoke-1', 'Incremented', 5)]);
check('first append commits version 1', streamVersion() === 1);
check('state cache matches the log', state()?.value === 5, JSON.stringify(state()));
check('anonymous view exposes the same state', summary()?.value === 5, JSON.stringify(summary()));

// Optimistic concurrency: a new event at a stale version must be rejected.
expectRejection('stale expected version is rejected', 'append_events', [
  STREAM_ID,
  'Counter',
  0,
  [event('smoke-2', 'Incremented', 100)],
  null,
], 'EXPECTED_VERSION_MISMATCH');
check('rejected append wrote nothing', streamVersion() === 1);

append(1, [event('smoke-2', 'Decremented', 2)]);
check('second append commits version 2', streamVersion() === 2);
check('state cache follows the log', state()?.value === 3, JSON.stringify(state()));
check('anonymous view follows the cache', summary()?.value === 3, JSON.stringify(summary()));

// Idempotent retry: the same event ids are a replay, not a duplicate.
append(-1, [event('smoke-1', 'Incremented', 5)]);
check('replayed batch does not change the version', streamVersion() === 2);
check('replayed batch does not duplicate events', events().length === 2, `${events().length} events`);
check(
  'event versions are contiguous',
  JSON.stringify(events().map((row) => row.version)) === '[1,2]',
  JSON.stringify(events().map((row) => row.version)),
);

// A deleted cache row must be rebuilt by replay, not treated as "state 0".
sql(`DELETE FROM counter_state WHERE stream_id = '${STREAM_ID}'`);
check('cache row can be deleted', state() === undefined);

append(2, [event('smoke-3', 'Incremented', 1)]);
check('append after a lost cache commits version 3', streamVersion() === 3);
check(
  'lost cache is rebuilt from the full stream',
  state()?.value === 4,
  JSON.stringify(state()),
);
check('anonymous view follows the rebuilt cache', summary()?.value === 4, JSON.stringify(summary()));
check(
  'event versions stay contiguous',
  JSON.stringify(events().map((row) => row.version)) === '[1,2,3]',
  JSON.stringify(events().map((row) => row.version)),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nAll ${checks} checks passed.`);
