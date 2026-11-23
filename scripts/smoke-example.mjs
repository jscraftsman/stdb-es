#!/usr/bin/env node
/**
 * Publish smoke test.
 *
 * Runs after `example:set:counter:publish-clean`, against the live local server. It proves
 * the things the unit tests cannot: the module publishes with command reducers,
 * private tables are readable by the database owner, ownership and idempotency
 * hold on the real server, and the anonymous view reflects the state cache for
 * an unauthenticated caller.
 *
 *   npm run smoke
 *
 * Override with STDB_SERVER (default `local`) and STDB_DATABASE
 * (default `stdb-es-counter-with-frontend`).
 */
import { execFileSync } from 'node:child_process';

const SERVER = process.env.STDB_SERVER ?? 'local';
const DATABASE = process.env.STDB_DATABASE ?? 'stdb-es-counter-with-frontend';
const COUNTER_ID = 'smoke-counter';
const STREAM_ID = `counter-${COUNTER_ID}`;

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

/** Invokes a command reducer; throws on rejection, carrying the server message. */
function call(reducer, args, { anonymous = false } = {}) {
  const callArgs = ['call', DATABASE, reducer];
  if (anonymous) callArgs.push('--anonymous');
  return run([...callArgs, '--', ...args.map((arg) => JSON.stringify(arg))]);
}

function expectRejection(label, callback, needle = '') {
  checks += 1;
  try {
    callback();
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

const increment = (commandId, by, options) =>
  call('increment', [COUNTER_ID, by, commandId], options);
const decrement = (commandId, by) => call('decrement', [COUNTER_ID, by, commandId]);
const reset = (commandId) => call('reset', [COUNTER_ID, commandId]);

const streamVersion = () =>
  sql(`SELECT version FROM es_stream WHERE stream_id = '${STREAM_ID}'`)[0]?.version;
const state = () => sql(`SELECT version, value FROM counter_state WHERE stream_id = '${STREAM_ID}'`)[0];
const summary = () =>
  sql(`SELECT version, value FROM counter_summary WHERE stream_id = '${STREAM_ID}'`, {
    anonymous: true,
  })[0];
const events = () =>
  sql(`SELECT event_id, version, event_type FROM es_event WHERE stream_id = '${STREAM_ID}'`).sort(
    (a, b) => a.version - b.version,
  );

console.log(`Publish smoke test (${SERVER}/${DATABASE})`);

// Empty database: the module published and the private tables exist.
check('no stream before the first command', streamVersion() === undefined);

increment('smoke-1', 5);
check('first command commits version 1', streamVersion() === 1);
check('state cache matches the log', state()?.value === 5, JSON.stringify(state()));
check('anonymous view exposes the same state', summary()?.value === 5, JSON.stringify(summary()));
check(
  'event id is derived from the command id',
  events()[0]?.event_id === 'inc-smoke-1',
  JSON.stringify(events()),
);

// Idempotent retry: the same command id is a replay, not a duplicate.
increment('smoke-1', 5);
check('replayed command does not change the version', streamVersion() === 1);
check('replayed command does not duplicate events', events().length === 1, `${events().length} events`);

// A different sender cannot change a counter owned by the first caller.
expectRejection('non-owner command is rejected', () =>
  increment('smoke-intruder', 100, { anonymous: true }),
);
check('rejected command wrote nothing', streamVersion() === 1);

decrement('smoke-2', 2);
check('decrement commits version 2', streamVersion() === 2);
check('state cache follows the log', state()?.value === 3, JSON.stringify(state()));
check('anonymous view follows the cache', summary()?.value === 3, JSON.stringify(summary()));

reset('smoke-reset');
check('reset commits version 3', streamVersion() === 3);
check('reset clears the cached value', state()?.value === 0, JSON.stringify(state()));

// A deleted cache row must be rebuilt by replay, not treated as "state 0".
sql(`DELETE FROM counter_state WHERE stream_id = '${STREAM_ID}'`);
check('cache row can be deleted', state() === undefined);

increment('smoke-3', 1);
check('command after a lost cache commits version 4', streamVersion() === 4);
check(
  'lost cache is rebuilt from the full stream',
  state()?.value === 1,
  JSON.stringify(state()),
);
check('anonymous view follows the rebuilt cache', summary()?.value === 1, JSON.stringify(summary()));
check(
  'event versions stay contiguous',
  JSON.stringify(events().map((row) => row.version)) === '[1,2,3,4]',
  JSON.stringify(events().map((row) => row.version)),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks} checks failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nAll ${checks} checks passed.`);
