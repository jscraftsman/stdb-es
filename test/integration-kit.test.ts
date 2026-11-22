import { describe, expect, it } from 'vitest';
import { cliArgs, parseSqlResult } from '../src/testing/integration/cli.js';
import { CliIntegrationClient } from '../src/testing/integration/client.js';
import { integrationDatabase, shouldDeleteDatabase } from '../src/testing/integration/env.js';
import { waitFor } from '../src/testing/integration/util.js';

describe('integration database names', () => {
  it('normalizes prefixes and adds a random suffix', () => {
    const first = integrationDatabase('My App_01');
    const second = integrationDatabase('My App_01');

    expect(first).toMatch(/^my-app-01-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it('falls back for empty prefixes', () => {
    expect(integrationDatabase('!!')).toMatch(/^stdb-es-test-[0-9a-f]{8}$/);
  });
});

describe('integration database retention', () => {
  it('keeps an attached database unless deletion is explicit', () => {
    expect(shouldDeleteDatabase({ publish: false })).toBe(false);
    expect(shouldDeleteDatabase({ publish: false, keepDatabase: false })).toBe(true);
    expect(shouldDeleteDatabase({ publish: true })).toBe(true);
    expect(shouldDeleteDatabase({ keepDatabase: true })).toBe(false);
  });
});

describe('CLI formatting and SQL parsing', () => {
  it('serializes each positional argument separately', () => {
    expect(cliArgs(['stream', 0, { event_id: 'e1' }, null])).toEqual([
      '"stream"',
      '0',
      '{"event_id":"e1"}',
      'null',
    ]);
    expect(cliArgs(undefined)).toEqual([]);
  });

  it('serializes command payloads as positional CLI tokens', () => {
    expect(cliArgs(['counter-1', 'cmd-1', 2])).toEqual(['"counter-1"', '"cmd-1"', '2']);
    expect(cliArgs({ counterId: 'counter-1', by: 1, commandId: 'cmd-1' })).toEqual([
      '{"counterId":"counter-1","by":1,"commandId":"cmd-1"}',
    ]);
  });

  it('rejects positional values that cannot be serialized', () => {
    expect(() => cliArgs(['ok', undefined])).toThrow(/argument 1/);
  });

  it('maps CLI columns and rows into keyed objects', () => {
    const output = JSON.stringify([
      {
        schema: {
          elements: [
            { name: { some: 'stream_id' } },
            { name: { some: 'version' } },
          ],
        },
        rows: [['a', 1], ['b', 2]],
      },
      {
        schema: { elements: [{ name: { some: 'value' } }] },
        rows: [[7]],
      },
    ]);

    const result = parseSqlResult(output);
    expect(result.rows).toEqual([
      { stream_id: 'a', version: 1 },
      { stream_id: 'b', version: 2 },
    ]);
    expect(result.statements).toHaveLength(2);
    expect(result.statements[1]).toEqual({
      columns: ['value'],
      rows: [{ value: 7 }],
    });
  });
});

describe('integration waitFor', () => {
  it('resolves when the predicate succeeds', async () => {
    let calls = 0;
    await waitFor(
      () => ++calls >= 3,
      { intervalMs: 0, timeoutMs: 100 },
    );
    expect(calls).toBe(3);
  });

  it('reports the description on timeout', async () => {
    await expect(
      waitFor(() => false, { intervalMs: 0, timeoutMs: 5, description: 'row cache' }),
    ).rejects.toThrow(/row cache/);
  });
});

describe('subscription row cache', () => {
  function client() {
    return new CliIntegrationClient({
      serverArg: 'http://127.0.0.1:1',
      database: 'test',
      cwd: process.cwd(),
      timeoutMs: 100,
    });
  }

  function feed(target: CliIntegrationClient, line: string) {
    (target as unknown as { applyLine(line: string): void }).applyLine(line);
  }

  it('applies initial inserts, later inserts, deletes, and updates', () => {
    const target = client();
    expect(target.tables()).toEqual([]);

    feed(
      target,
      '{"counter_summary":{"inserts":[{"stream_id":"a","version":1,"value":3}]}}',
    );
    expect(target.rows('counter_summary')).toEqual([
      { stream_id: 'a', version: 1, value: 3 },
    ]);

    feed(
      target,
      '{"counter_summary":{"inserts":[{"stream_id":"b","version":1,"value":4}]}}',
    );
    expect(target.rows('counter_summary')).toHaveLength(2);

    feed(
      target,
      '{"counter_summary":{"deletes":[{"stream_id":"a","version":1,"value":3}],"inserts":[{"stream_id":"a","version":2,"value":5}]}}',
    );
    expect(target.rows('counter_summary')).toEqual([
      { stream_id: 'b', version: 1, value: 4 },
      { stream_id: 'a', version: 2, value: 5 },
    ]);

    feed(
      target,
      '{"counter_summary":{"updates":[[{"stream_id":"a","version":2,"value":5},{"stream_id":"a","version":3,"value":6}]]}}',
    );
    expect(target.rows('counter_summary')).toContainEqual({
      stream_id: 'a',
      version: 3,
      value: 6,
    });
  });

  it('ignores non-JSON lines without corrupting the cache', () => {
    const target = client();
    feed(target, 'not json');
    expect(target.tables()).toEqual([]);
  });
});
