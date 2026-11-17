import { Identity } from 'spacetimedb';
import { TestAuth, createModuleTestHarness } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import { ANY_VERSION, appendToStream } from '../src/server/index.js';
import { counterHead, counterOwner, counterStream, counterStreamAt, spacetimedb } from './fixture.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

const newHarness = (): Harness => createModuleTestHarness(spacetimedb, {});

function tx<T>(test: Harness, body: (ctx: any) => T): T {
  return test.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
}

const inc = (eventId: string, by: number) => ({
  eventId,
  eventType: 'Incremented',
  data: JSON.stringify({ kind: 'Incremented', by }),
});

/** Seeds three events at versions 1..3 without touching ownership. */
function seed(test: Harness, streamId = 'counter-1'): void {
  tx(test, (ctx) =>
    appendToStream(ctx, {
      streamId,
      streamType: 'Counter',
      expectedVersion: ANY_VERSION,
      events: [
        inc(`${streamId}-e1`, 5),
        inc(`${streamId}-e2`, 2),
        inc(`${streamId}-e3`, 1),
      ],
    }),
  );
}

function own(test: Harness, streamId = 'counter-1'): void {
  tx(test, (ctx) => ctx.db.counterOwner.insert({ streamId, owner: test.moduleIdentity }));
}

/** Calls a parameterized view body with a range-shimmed view context. */
function callView(test: Harness, view: any, params: object): any {
  return view(withIndexRanges(test.viewContext(TestAuth.internal())), params);
}

const versions = (rows: Array<{ version: number }>) => rows.map((row) => row.version);

describe('makeStreamView', () => {
  it('returns a stream ordered by version for an authorized caller', () => {
    const test = newHarness();
    seed(test);
    own(test);

    const rows = callView(test, counterStream, { streamId: 'counter-1' });

    expect(versions(rows)).toEqual([1, 2, 3]);
    expect(rows.map((row: any) => row.position)).toEqual([1n, 2n, 3n]);
  });

  it('returns nothing for a stream owned by somebody else', () => {
    const test = newHarness();
    seed(test);
    // No ownership row: the authorization predicate sees no owner.
    expect(callView(test, counterStream, { streamId: 'counter-1' })).toEqual([]);
  });

  it('returns nothing for an unknown stream', () => {
    const test = newHarness();
    expect(callView(test, counterStream, { streamId: 'missing' })).toEqual([]);
  });

  it('returns nothing when the ownership row names a different identity', () => {
    const test = newHarness();
    seed(test);
    tx(test, (ctx) =>
      ctx.db.counterOwner.insert({ streamId: 'counter-1', owner: new Identity(1n) }),
    );

    expect(callView(test, counterStream, { streamId: 'counter-1' })).toEqual([]);
  });
});

describe('makeStreamAtView', () => {
  it('returns events up to and including atVersion', () => {
    const test = newHarness();
    seed(test);
    own(test);

    expect(versions(callView(test, counterStreamAt, { streamId: 'counter-1', atVersion: 2 }))).toEqual(
      [1, 2],
    );
    expect(versions(callView(test, counterStreamAt, { streamId: 'counter-1', atVersion: 99 }))).toEqual(
      [1, 2, 3],
    );
  });

  it('returns nothing when unauthorized', () => {
    const test = newHarness();
    seed(test);
    expect(callView(test, counterStreamAt, { streamId: 'counter-1', atVersion: 2 })).toEqual([]);
  });
});

describe('makeStreamHeadView', () => {
  it('returns the concurrency token without event payloads', () => {
    const test = newHarness();
    seed(test);
    own(test);

    const head = callView(test, counterHead, { streamId: 'counter-1' });

    expect(head).toMatchObject({ streamId: 'counter-1', streamType: 'Counter', version: 3 });
    expect(head).not.toHaveProperty('data');
  });

  it('returns undefined for an authorized but unknown stream', () => {
    const test = newHarness();
    const missing = callView(test, counterHead, { streamId: 'missing' });
    expect(missing).toBeUndefined();
  });

  it('returns undefined when unauthorized', () => {
    const test = newHarness();
    seed(test);
    expect(callView(test, counterHead, { streamId: 'counter-1' })).toBeUndefined();
  });
});

describe('view output', () => {
  it('returns only the requested stream rows', () => {
    const test = newHarness();
    seed(test);
    seed(test, 'counter-2');
    own(test);

    const rows = callView(test, counterStream, { streamId: 'counter-1' });

    expect(rows).toHaveLength(3);
    expect(rows.every((row: any) => row.streamId === 'counter-1')).toBe(true);
  });
});
