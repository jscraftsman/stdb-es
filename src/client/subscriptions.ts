import { tableQuery, viewQuery, type SqlLiteral } from './views.js';

/**
 * Structural types for the small part of the SpacetimeDB client SDK used here.
 *
 * A generated `DbConnection` satisfies `SubscriptionConnection` directly, so
 * this entry point does not need to import a generated module or pin a schema.
 */
export type SubscriptionHandleLike = {
  unsubscribe(): void;
  unsubscribeThen?(onEnd: (ctx: unknown) => void): void;
  isActive?(): boolean;
  isEnded?(): boolean;
};

export type SubscriptionBuilder<TContext = any, TErrorContext = any> = {
  onApplied(cb: (ctx: TContext) => void): SubscriptionBuilder<TContext, TErrorContext>;
  onError(cb: (ctx: TErrorContext) => void): SubscriptionBuilder<TContext, TErrorContext>;
  subscribe(query: string): SubscriptionHandleLike;
  subscribe(query: string[]): SubscriptionHandleLike;
};

export type SubscriptionConnection<TContext = any, TErrorContext = any> = {
  subscriptionBuilder(): SubscriptionBuilder<TContext, TErrorContext>;
};

/** Query forms accepted by the subscription helpers. */
export type SubscriptionQuery =
  | { view: string; args?: readonly SqlLiteral[] }
  | { table: string }
  | { query: string | readonly string[] };

/** A retained SDK subscription handle plus the queries it represents. */
export type EventSubscription = {
  readonly queries: readonly string[];
  unsubscribe(): void;
  unsubscribeThen(onEnd: (ctx: unknown) => void): void;
  isActive(): boolean;
  isEnded(): boolean;
};

export type EventSubscriptionOptions<TRow, TContext = any, TErrorContext = any> = {
  connection: SubscriptionConnection<TContext, TErrorContext>;
  query: SubscriptionQuery;
  /** Extracts the current rows from the SDK context; e.g. `ctx => [...ctx.db.summary.iter()]`. */
  readRows: (ctx: TContext) => Iterable<TRow>;
  onRows: (rows: readonly TRow[], ctx: TContext) => void;
  /**
   * Receives subscription and failed-reducer errors. When omitted, the bridge
   * throws. SpacetimeDB 2.16 catches callback throws and logs them, so supply
   * this handler when the app needs deterministic error handling.
   */
  onError?: (error: Error, ctx: TErrorContext) => void;
  /** Keeps only rows belonging to this stream. */
  streamId?: string;
  /** Override the default `streamId` / `stream_id` row lookup when pruning by stream. */
  rowStreamId?: (row: TRow) => string | undefined;
};

export type StreamSubscriptionOptions<TRow, TContext = any, TErrorContext = any> = Omit<
  EventSubscriptionOptions<TRow, TContext, TErrorContext>,
  'query' | 'streamId' | 'onRows'
> & {
  query: (streamId: string) => SubscriptionQuery;
  onRows: (rows: readonly TRow[], ctx: TContext, streamId: string) => void;
};

/** A switcher that keeps exactly one stream subscription active. */
export type StreamSubscription = {
  readonly streamId: string | undefined;
  readonly queries: readonly string[];
  select(streamId: string): EventSubscription;
  unsubscribe(): void;
  unsubscribeThen(onEnd: (ctx: unknown) => void): void;
  isActive(): boolean;
  isEnded(): boolean;
};

function queryStrings(query: SubscriptionQuery): string[] {
  if ('view' in query) return [viewQuery(query.view, query.args ?? [])];
  if ('table' in query) return [tableQuery(query.table)];
  const queries = typeof query.query === 'string' ? [query.query] : [...query.query];
  if (queries.length === 0) throw new Error('a subscription requires at least one query');
  return queries;
}

function errorFromContext(ctx: unknown, sdkError?: unknown): Error {
  if (sdkError instanceof Error) return sdkError;
  const event = (ctx as { event?: unknown } | null)?.event;
  if (event instanceof Error) return event;
  return new Error('Subscription failed', { cause: sdkError ?? event });
}

function defaultRowStreamId<TRow>(row: TRow): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const candidate = row as { streamId?: unknown; stream_id?: unknown };
  if (typeof candidate.streamId === 'string') return candidate.streamId;
  if (typeof candidate.stream_id === 'string') return candidate.stream_id;
  return undefined;
}

/**
 * Subscribes `query` and calls `onRows` whenever the SDK applies it.
 *
 * Callbacks are registered once. With automatic reconnect enabled, SpacetimeDB
 * replays the retained query and invokes `onApplied` again, so `onRows` receives
 * the refreshed rows without a second `subscribe()` call. Call `unsubscribe()`
 * when the view is obsolete; the SDK removes the query for this handle only.
 */
export function subscribeEventRows<TRow, TContext = any, TErrorContext = any>(
  options: EventSubscriptionOptions<TRow, TContext, TErrorContext>,
): EventSubscription {
  const queries = queryStrings(options.query);
  let closed = false;
  let handle: SubscriptionHandleLike | undefined;

  const builder = options.connection.subscriptionBuilder();

  builder.onApplied((ctx: TContext) => {
    // A retained SDK callback can still fire while an unsubscribe is in flight.
    if (closed) return;

    let rows = [...options.readRows(ctx)];
    if (options.streamId !== undefined) {
      const getStreamId = options.rowStreamId ?? defaultRowStreamId;
      rows = rows.filter((row) => {
        const rowId = getStreamId(row);
        if (rowId === undefined) {
          throw new Error('subscription row has no stream id; provide rowStreamId');
        }
        return rowId === options.streamId;
      });
    }
    options.onRows(rows, ctx);
  });

  builder.onError((ctx: TErrorContext, sdkError?: Error) => {
    const error = errorFromContext(ctx, sdkError);
    if (options.onError) {
      options.onError(error, ctx);
      return;
    }
    throw error;
  });

  handle = builder.subscribe(queries);

  return {
    queries: [...queries],

    unsubscribe(): void {
      closed = true;
      handle?.unsubscribe();
    },

    unsubscribeThen(onEnd: (ctx: unknown) => void): void {
      closed = true;
      if (handle?.unsubscribeThen) {
        handle.unsubscribeThen(onEnd);
      } else {
        handle?.unsubscribe();
        onEnd(undefined);
      }
    },

    isActive(): boolean {
      return !closed && (handle?.isActive?.() ?? false);
    },

    isEnded(): boolean {
      return closed || (handle?.isEnded?.() ?? false);
    },
  };
}

/**
 * Keeps one per-stream query active. `select(streamId)` unsubscribes the old
 * stream, builds the new query, and ignores any late callback from the old
 * query. Row handlers receive the selected stream id explicitly.
 */
export function createStreamSubscription<TRow, TContext = any, TErrorContext = any>(
  options: StreamSubscriptionOptions<TRow, TContext, TErrorContext>,
): StreamSubscription {
  let active: { streamId: string; subscription: EventSubscription } | undefined;

  return {
    get streamId(): string | undefined {
      return active?.streamId;
    },

    get queries(): readonly string[] {
      return active?.subscription.queries ?? [];
    },

    select(streamId: string): EventSubscription {
      if (active?.streamId === streamId && !active.subscription.isEnded()) {
        return active.subscription;
      }

      active?.subscription.unsubscribe();
      active = undefined;

      const subscription = subscribeEventRows<TRow, TContext, TErrorContext>({
        connection: options.connection,
        query: options.query(streamId),
        streamId,
        readRows: options.readRows,
        onRows: (rows, ctx) => options.onRows(rows, ctx, streamId),
        onError: options.onError,
        rowStreamId: options.rowStreamId,
      });
      active = { streamId, subscription };
      return subscription;
    },

    unsubscribe(): void {
      active?.subscription.unsubscribe();
      active = undefined;
    },

    unsubscribeThen(onEnd: (ctx: unknown) => void): void {
      active?.subscription.unsubscribeThen(onEnd);
      active = undefined;
    },

    isActive(): boolean {
      return active?.subscription.isActive() ?? false;
    },

    isEnded(): boolean {
      return active === undefined || active.subscription.isEnded();
    },
  };
}
