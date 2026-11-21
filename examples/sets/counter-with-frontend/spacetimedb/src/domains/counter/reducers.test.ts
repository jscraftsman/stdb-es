import { Identity } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { streamId } from 'stdb-es';
import { readStream } from 'stdb-es/server';
import { createModuleTest } from 'stdb-es/testing';
import * as counterModule from '../../index.js';
import {
  EVENT_TYPES_COUNTER,
  STREAM_PREFIXES_COUNTER,
} from './constants.js';

const { default: spacetimedb, counterSummary } = counterModule;
type Test = ReturnType<typeof createModuleTest<typeof spacetimedb>>;

function stream(name: string): string {
  return streamId(STREAM_PREFIXES_COUNTER.counter, name);
}

function state(test: Test, id: string) {
  return test.tx((ctx) => {
    const row = ctx.db.counterState.streamId.find(id);
    return { version: row?.version, value: row?.value };
  });
}

function events(test: Test, id: string) {
  return test.tx((ctx) =>
    readStream(ctx, id).map((row) => ({
      eventId: row.eventId,
      eventType: row.eventType,
      version: row.version,
      data: JSON.parse(row.data),
    })),
  );
}

describe('counter module commands (offline)', () => {
  it('derives the event from an increment command and publishes the summary', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const id = stream('unit-increment');

    test.call('increment', { counterId: 'unit-increment', by: 5, commandId: 'cmd-1' });

    expect(events(test, id)).toEqual([
      {
        eventId: 'inc-cmd-1',
        eventType: EVENT_TYPES_COUNTER.Incremented,
        version: 1,
        data: { kind: EVENT_TYPES_COUNTER.Incremented, by: 5 },
      },
    ]);
    expect(state(test, id)).toEqual({ version: 1, value: 5n });
    expect(test.anonymousView(counterSummary, undefined)).toEqual([
      { streamId: id, version: 1, value: 5n },
    ]);
  });

  it('replays a repeated command id instead of appending twice', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const command = { counterId: 'unit-retry', by: 4, commandId: 'cmd-retry' };

    test.call('increment', command);
    test.call('increment', command);

    expect(events(test, stream('unit-retry'))).toHaveLength(1);
    expect(state(test, stream('unit-retry'))).toEqual({ version: 1, value: 4n });
  });

  it('applies decrement and reset commands from the same owner', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const counterId = 'unit-flow';
    const id = stream(counterId);

    test.call('increment', { counterId, by: 5, commandId: 'flow-1' });
    test.call('decrement', { counterId, by: 2, commandId: 'flow-2' });
    test.call('reset', { counterId, commandId: 'flow-3' });

    expect(events(test, id).map((event) => event.eventId)).toEqual([
      'inc-flow-1',
      'dec-flow-2',
      'rst-flow-3',
    ]);
    expect(state(test, id)).toEqual({ version: 3, value: 0n });
  });

  it('rejects a command from a caller who does not own the counter', () => {
    const test = createModuleTest(spacetimedb, counterModule);
    const counterId = 'unit-ownership';
    const id = stream(counterId);
    const outsider = new Identity('11'.repeat(32));

    test.tx((ctx) => {
      ctx.db.counterOwner.insert({ streamId: id, owner: outsider });
    });

    expect(() =>
      test.call('increment', { counterId, by: 1, commandId: 'intruder' }),
    ).toThrow(/CMD_UNAUTHORIZED/);
    expect(events(test, id)).toHaveLength(0);
    expect(state(test, id)).toEqual({ version: undefined, value: undefined });
  });

  it('rejects empty ids and zero amounts before writing anything', () => {
    const test = createModuleTest(spacetimedb, counterModule);

    expect(() =>
      test.call('increment', { counterId: 'unit-invalid', by: 0, commandId: 'cmd-zero' }),
    ).toThrow(/CMD_INVALID_COMMAND/);
    expect(() =>
      test.call('reset', { counterId: 'unit-invalid', commandId: '' }),
    ).toThrow(/CMD_INVALID_COMMAND/);
    expect(events(test, stream('unit-invalid'))).toHaveLength(0);
    expect(test.tx((ctx) => [...ctx.db.counterOwner.iter()])).toHaveLength(0);
  });
});
