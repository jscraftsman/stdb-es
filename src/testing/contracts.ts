import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '../client/command.js';
import {
  ANY_VERSION,
  ES_ERROR,
  NO_STREAM,
  readStream,
  rebuildBatch,
  repairStream,
  streamVersion,
  verifyStreamIntegrity,
  verifyStreamState,
  type AppendArgs,
  type EncodedEvent,
  type InlineProjection,
  type Repository,
  type StateCache,
} from '../server/index.js';
import { withIndexRanges } from './harness.js';

type Harness = ReturnType<typeof createModuleTestHarness>;

/** One aggregate kind under contract. */
export type ContractStream<TState = any, TEvent = any> = {
  /** Recorded in `es_stream.streamType`. */
  streamType: string;
  /** Repository configured with this aggregate's state cache. */
  repository: Repository<TState, TEvent, any>;
  /** The same cache adapter the repository uses, for direct assertions. */
  stateCache: StateCache<TState, any>;
  /** Full replay that ignores the cache, usually `aggregateStream` without a cache. */
  replay: (ctx: any, streamId: string) => TState;
  sample: {
    /** Events as the append reducer receives them. Ids must be deterministic. */
    wire: (streamId: string) => EncodedEvent[];
    /** The same events as domain values, for `repository.save`. */
    domain: (streamId: string) => TEvent[];
    /** State after applying every sampled event. */
    expectedState: TState;
    /** Produces a different state with the same shape, to inject drift. */
    corrupt?: (state: TState) => TState;
  };
};

/** Optional check that incremental projections and a full rebuild converge. */
export type ContractProjections = {
  projections: readonly InlineProjection<any>[];
  /** Returns a snapshot of the projection's read-model tables, in stable order. */
  snapshot: (ctx: any) => unknown;
};

/** Optional check that an app-defined or library-factory view returns expected rows. */
export type ContractView = {
  name: string;
  view: (ctx: any, params: any) => unknown;
  params: (streamId: string) => Record<string, unknown>;
  /** Runs before the view call, for ownership rows and other fixtures. */
  seed?: (ctx: any, streamId: string) => void;
  /** Throwing assertions, usually with vitest's `expect`. */
  check: (result: unknown, streamId: string) => void;
};

/**
 * Optional command-boundary checks against the app's real command reducers.
 *
 * The store invariants above are seeded through a server-side write seam. These
 * checks cover the browser-facing boundary instead: a command is the only input,
 * a repeated `commandId` is idempotent, and a caller without an ownership row
 * cannot write to the stream.
 */
export type ContractCommands<TCommand extends object = any> = {
  /** Export name of the command reducer in `moduleExports`. */
  name: string;
  /** Builds the command payload for a stream and an explicit idempotency key. */
  command: (streamId: string, commandId: string) => CommandEnvelope<TCommand>;
  /** Seeds ownership for the default sender. Enables the negative check. */
  authorize?: (ctx: any, streamId: string) => void;
  /** Reads the stream version after a command. */
  version: (ctx: any, streamId: string) => number;
};

export type EventStoreContractOptions = {
  /** Suite name. Defaults to "Event store contract". */
  name?: string;
  /** The app module schema, used to build a fresh harness per case. */
  spacetimedb: any;
  /** Exports needed while describing the module. Include command reducers when set. */
  moduleExports?: Record<string, unknown>;
  /** The app's server-side write seam. Not a browser-facing API. */
  append: (ctx: any, args: AppendArgs) => void;
  streams: ContractStream[];
  projections?: ContractProjections;
  views?: ContractView[];
  /** Optional command-boundary checks. See §18 of the event-sourcing plan. */
  commands?: ContractCommands;
  /** Stream id per aggregate. Defaults to `contract-${streamType}`. */
  streamId?: (stream: ContractStream) => string;
};

/**
 * Runs the event-store contract against an app's real module.
 *
 * Call it from a vitest file; it registers `describe`/`it` cases. Each case
 * builds a fresh harness, so the checks do not share database state.
 *
 * Covered invariants: append/read ordering, gapless positions, optimistic
 * concurrency, idempotent replay, repository/cache agreement, structural
 * integrity, time travel, projection rebuild parity, and view output.
 */
export function runEventStoreContractTests(options: EventStoreContractOptions): void {
  const createHarness = (): Harness =>
    createModuleTestHarness(options.spacetimedb, options.moduleExports ?? {});
  const tx = <T>(harness: Harness, body: (ctx: any) => T): T =>
    harness.withReducerTx(TestAuth.internal(), (ctx) => body(withIndexRanges(ctx)));
  const txAs = <T>(harness: Harness, auth: TestAuth, body: (ctx: any) => T): T =>
    harness.withReducerTx(auth, (ctx) => body(withIndexRanges(ctx)));
  const idOf = options.streamId ?? ((stream: ContractStream) => `contract-${stream.streamType}`);
  const argsFor = (
    stream: ContractStream,
    streamId: string,
    expectedVersion: number,
  ): AppendArgs => ({
    streamId,
    streamType: stream.streamType,
    expectedVersion,
    events: stream.sample.wire(streamId),
    metadata: undefined,
  });
  /**
   * The sample events under fresh ids.
   *
   * Dedupe runs before the version check, so re-submitting the *same* ids is a
   * legitimate replay even when `expectedVersion` is stale. A stale-version test
   * needs genuinely new events, or it proves nothing.
   */
  const freshBatch = (stream: ContractStream, streamId: string): EncodedEvent[] =>
    stream.sample.wire(streamId).map((event) => ({
      ...event,
      eventId: `${event.eventId}-retry`,
    }));
  const seedRepository = (harness: Harness, stream: ContractStream, streamId: string): void => {
    const aggregate = tx(harness, (ctx) => stream.repository.loadOrCreate(ctx, streamId));
    tx(harness, (ctx) => {
      stream.repository.save(ctx, aggregate, stream.sample.domain(streamId));
    });
  };

  describe(options.name ?? 'Event store contract', () => {
    for (const stream of options.streams) {
      const streamId = idOf(stream);
      const wire = () => stream.sample.wire(streamId);
      const domain = () => stream.sample.domain(streamId);

      describe(stream.streamType, () => {
        it('appends a batch and reads it back in order', () => {
          const harness = createHarness();
          tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));

          const rows = tx(harness, (ctx) => readStream(ctx, streamId));
          const count = wire().length;
          expect(count).toBeGreaterThan(0);
          expect(rows.map((row) => row.version)).toEqual(
            Array.from({ length: count }, (_, index) => index + 1),
          );
          expect(rows.map((row) => row.eventType)).toEqual(wire().map((row) => row.eventType));
          expect(rows.map((row) => row.position)).toEqual(
            Array.from({ length: count }, (_, index) => BigInt(index + 1)),
          );
          expect(tx(harness, (ctx) => streamVersion(ctx, streamId))).toBe(count);
        });

        it('rejects a stale expected version and writes nothing', () => {
          const harness = createHarness();
          tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));

          expect(() =>
            tx(harness, (ctx) =>
              options.append(ctx, {
                ...argsFor(stream, streamId, NO_STREAM),
                events: freshBatch(stream, streamId),
              }),
            ),
          ).toThrow(new RegExp(ES_ERROR.EXPECTED_VERSION_MISMATCH));
          expect(harness.db.esEvent!.count()).toBe(BigInt(wire().length));
        });

        it('replays an identical batch without writing or changing the version', () => {
          const harness = createHarness();
          tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));
          const before = tx(harness, (ctx) => streamVersion(ctx, streamId));

          tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));

          expect(harness.db.esEvent!.count()).toBe(BigInt(wire().length));
          expect(tx(harness, (ctx) => streamVersion(ctx, streamId))).toBe(before);
        });

        it('saves through the repository and keeps the cache at the stream version', () => {
          const harness = createHarness();
          seedRepository(harness, stream, streamId);

          const cached = stream.stateCache.load({ db: harness.db } as any, streamId);
          expect(cached).not.toBeNull();
          expect(cached?.version).toBe(domain().length);
          expect(cached?.state).toEqual(stream.sample.expectedState);

          const loaded = tx(harness, (ctx) => stream.repository.load(ctx, streamId));
          expect(loaded?.version).toBe(domain().length);
          expect(loaded?.state).toEqual(stream.sample.expectedState);
        });

        it('agrees that a freshly written cache matches a full replay', () => {
          const harness = createHarness();
          seedRepository(harness, stream, streamId);

          const result = tx(harness, (ctx) =>
            verifyStreamState(ctx, streamId, {
              cache: stream.stateCache,
              replay: stream.replay,
            }),
          );

          expect(result.ok).toBe(true);
          expect(result.cachedState).toEqual(stream.sample.expectedState);
          expect(result.replayedState).toEqual(stream.sample.expectedState);
        });

        it('reports a clean stream as structurally valid', () => {
          const harness = createHarness();
          tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));

          expect(tx(harness, (ctx) => verifyStreamIntegrity(ctx, streamId))).toMatchObject({
            streamId,
            streamType: stream.streamType,
            eventCount: wire().length,
            problems: [],
            ok: true,
          });
        });

        if (stream.sample.corrupt) {
          it('detects and repairs same-version cache drift', () => {
            const harness = createHarness();
            seedRepository(harness, stream, streamId);
            tx(harness, (ctx) => {
              const cached = stream.stateCache.load(ctx, streamId);
              if (cached === null) throw new Error('seed did not write a cache row');
              stream.stateCache.save(
                ctx,
                streamId,
                cached.version,
                stream.sample.corrupt!(cached.state),
              );
            });

            expect(
              tx(harness, (ctx) =>
                verifyStreamState(ctx, streamId, {
                  cache: stream.stateCache,
                  replay: stream.replay,
                }),
              ).ok,
            ).toBe(false);

            expect(
              tx(harness, (ctx) =>
                repairStream(ctx, streamId, {
                  cache: stream.stateCache,
                  replay: stream.replay,
                }),
              ),
            ).toBe('repaired');

            expect(
              tx(harness, (ctx) =>
                verifyStreamState(ctx, streamId, {
                  cache: stream.stateCache,
                  replay: stream.replay,
                }),
              ).ok,
            ).toBe(true);
          });
        }

        if (wire().length >= 2) {
          it('reads a time-travel prefix', () => {
            const harness = createHarness();
            tx(harness, (ctx) => options.append(ctx, argsFor(stream, streamId, ANY_VERSION)));

            const rows = tx(harness, (ctx) => readStream(ctx, streamId, { atVersion: 1 }));

            expect(rows).toHaveLength(1);
            expect(rows[0]?.version).toBe(1);
          });
        }
      });
    }

    const first = options.streams[0];
    const firstId = first ? idOf(first) : 'contract';

    if (options.commands) {
      const { name, command, authorize, version } = options.commands;
      const commandId = `contract-${name}`;
      const call = (harness: Harness, auth: TestAuth = TestAuth.internal()): void => {
        const reducer = options.moduleExports?.[name];
        if (typeof reducer !== 'function') {
          throw new Error(`contract: no reducer named '${name}' in moduleExports`);
        }
        txAs(harness, auth, (ctx) =>
          (reducer as (ctx: unknown, args: unknown) => void)(ctx, command(firstId, commandId)),
        );
      };

      describe(`${name} command`, () => {
        it('appends once for a command id', () => {
          const harness = createHarness();
          tx(harness, (ctx) => authorize?.(ctx, firstId));

          call(harness);

          expect(tx(harness, (ctx) => version(ctx, firstId))).toBe(1);
        });

        it('replays a retried command id without appending again', () => {
          const harness = createHarness();
          tx(harness, (ctx) => authorize?.(ctx, firstId));

          call(harness);
          call(harness);

          expect(tx(harness, (ctx) => version(ctx, firstId))).toBe(1);
        });

        if (authorize) {
          it('rejects a caller without an ownership row', () => {
            const harness = createHarness();

            expect(() => call(harness)).toThrow();
            expect(tx(harness, (ctx) => version(ctx, firstId))).toBe(0);
          });
        }
      });
    }

    if (options.projections && first) {
      const { projections, snapshot } = options.projections;
      it('rebuilds projections to the same state as inline handling', () => {
        const harness = createHarness();
        tx(harness, (ctx) => options.append(ctx, argsFor(first, firstId, ANY_VERSION)));

        const inline = tx(harness, (ctx) => snapshot(ctx));
        tx(harness, (ctx) => {
          rebuildBatch(ctx, projections, { reset: true });
        });
        const rebuilt = tx(harness, (ctx) => snapshot(ctx));

        expect(rebuilt).toEqual(inline);
      });
    }

    for (const view of options.views ?? []) {
      if (!first) break;
      it(`exposes view ${view.name}`, () => {
        const harness = createHarness();
        tx(harness, (ctx) => options.append(ctx, argsFor(first, firstId, ANY_VERSION)));
        if (view.seed) tx(harness, (ctx) => view.seed!(ctx, firstId));

        const result = view.view(
          withIndexRanges(harness.viewContext(TestAuth.internal())),
          view.params(firstId),
        );
        view.check(result, firstId);
      });
    }
  });
}
