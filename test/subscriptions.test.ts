import { describe, expect, it, vi } from 'vitest';
import {
  createStreamSubscription,
  subscribeEventRows,
  tableQuery,
  type SubscriptionBuilder,
  type SubscriptionConnection,
  viewQuery,
} from '../src/client/index.js';

type Row = { streamId: string; value: number };
type Ctx = { rows: Row[] };
type ErrorCtx = { event?: Error };

type BuilderState = {
  applied: Array<(ctx: Ctx) => void>;
  errors: Array<(ctx: ErrorCtx) => void>;
  queries: string[][];
  unsubscribes: number;
};

function fakeConnection() {
  const builders: BuilderState[] = [];

  const connection: SubscriptionConnection<Ctx, ErrorCtx> = {
    subscriptionBuilder() {
      const state: BuilderState = {
        applied: [],
        errors: [],
        queries: [],
        unsubscribes: 0,
      };
      builders.push(state);

      const handle = {
        unsubscribe() {
          state.unsubscribes += 1;
        },
        isActive() {
          return state.unsubscribes === 0;
        },
        isEnded() {
          return state.unsubscribes > 0;
        },
      };

      const builder: SubscriptionBuilder<Ctx, ErrorCtx> = {
        onApplied(cb) {
          state.applied.push(cb);
          return builder;
        },
        onError(cb) {
          state.errors.push(cb);
          return builder;
        },
        subscribe(query) {
          const queries = typeof query === 'string' ? [query] : [...query];
          state.queries.push(queries);
          return handle;
        },
      };

      return builder;
    },
  };

  return { connection, builders };
}

const row = (streamId: string, value: number): Row => ({ streamId, value });

describe('subscribeEventRows', () => {
  it('binds a view query to a pruned row handler', () => {
    const { connection, builders } = fakeConnection();
    const onRows = vi.fn();

    const subscription = subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { view: 'order_stream', args: ['order-1', 10n] },
      streamId: 'order-1',
      readRows: (ctx) => ctx.rows,
      onRows,
    });

    expect(subscription.queries).toEqual(["SELECT * FROM order_stream('order-1', 10)"]);
    expect(builders[0]!.queries).toEqual([subscription.queries]);

    const ctx: Ctx = { rows: [row('order-1', 1), row('order-2', 2)] };
    builders[0]!.applied[0]!(ctx);

    expect(onRows).toHaveBeenCalledWith([ctx.rows[0]], ctx);
  });

  it('accepts table queries and raw query arrays', () => {
    const { connection, builders } = fakeConnection();
    subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: {
        query: [tableQuery('counter_summary'), viewQuery('counter_stream', ['counter-1'])],
      },
      readRows: (ctx) => ctx.rows,
      onRows: () => undefined,
    });

    expect(builders[0]!.queries[0]).toEqual([
      'SELECT * FROM counter_summary',
      "SELECT * FROM counter_stream('counter-1')",
    ]);
  });

  it('reuses callbacks when the SDK replays a query after reconnect', () => {
    const { connection, builders } = fakeConnection();
    const onRows = vi.fn();
    subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { table: 'counter_summary' },
      readRows: (ctx) => ctx.rows,
      onRows,
    });

    const ctx: Ctx = { rows: [row('counter-1', 1)] };
    builders[0]!.applied[0]!(ctx);
    builders[0]!.applied[0]!(ctx);

    expect(onRows).toHaveBeenCalledTimes(2);
  });

  it('surfaces reducer errors through onError', () => {
    const { connection, builders } = fakeConnection();
    const onError = vi.fn();
    subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { table: 'counter_summary' },
      readRows: (ctx) => ctx.rows,
      onRows: () => undefined,
      onError,
    });

    const error = new Error('ES_EXPECTED_VERSION_MISMATCH: reducer failed');
    const ctx: ErrorCtx = { event: error };
    builders[0]!.errors[0]!(ctx);

    expect(onError).toHaveBeenCalledWith(error, ctx);
  });

  it('rethrows errors when no onError handler is supplied', () => {
    const { connection, builders } = fakeConnection();
    subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { table: 'counter_summary' },
      readRows: (ctx) => ctx.rows,
      onRows: () => undefined,
    });

    expect(() => builders[0]!.errors[0]!({ event: new Error('reducer failed') })).toThrow(
      'reducer failed',
    );
  });

  it('rejects pruned rows without a stream id', () => {
    const { connection, builders } = fakeConnection();
    subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { table: 'counter_summary' },
      streamId: 'counter-1',
      readRows: (ctx) => ctx.rows,
      onRows: () => undefined,
    });

    expect(() =>
      builders[0]!.applied[0]!({ rows: [{ value: 1 } as Row] }),
    ).toThrow('subscription row has no stream id');
  });

  it('unsubscribes the retained handle', () => {
    const { connection, builders } = fakeConnection();
    const subscription = subscribeEventRows<Row, Ctx, ErrorCtx>({
      connection,
      query: { table: 'counter_summary' },
      readRows: (ctx) => ctx.rows,
      onRows: () => undefined,
    });

    expect(subscription.isActive()).toBe(true);
    subscription.unsubscribe();

    expect(builders[0]!.unsubscribes).toBe(1);
    expect(subscription.isActive()).toBe(false);
    expect(subscription.isEnded()).toBe(true);
  });
});

describe('createStreamSubscription', () => {
  it('switches streams, prunes stale callbacks, and keeps one active query', () => {
    const { connection, builders } = fakeConnection();
    const onRows = vi.fn();
    const subscription = createStreamSubscription<Row, Ctx, ErrorCtx>({
      connection,
      query: (streamId) => ({ view: 'order_stream', args: [streamId] }),
      readRows: (ctx) => ctx.rows,
      onRows,
    });

    subscription.select('order-1');
    subscription.select('order-2');

    expect(builders[0]!.unsubscribes).toBe(1);
    expect(subscription.streamId).toBe('order-2');
    expect(builders[1]!.queries[0]).toEqual(["SELECT * FROM order_stream('order-2')"]);

    builders[0]!.applied[0]!({ rows: [row('order-1', 1)] });
    expect(onRows).not.toHaveBeenCalled();

    const ctx: Ctx = { rows: [row('order-1', 1), row('order-2', 2)] };
    builders[1]!.applied[0]!(ctx);
    expect(onRows).toHaveBeenCalledWith([ctx.rows[1]], ctx, 'order-2');

    subscription.select('order-2');
    expect(builders).toHaveLength(2);
  });
});
