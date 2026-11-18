import type { ReducerCtx, Schema } from 'spacetimedb/server';
import {
  TestAuth,
  createModuleTestHarness,
  type ModuleTestHarness,
} from 'spacetimedb/server/test-utils';
import { withIndexRanges } from './harness.js';

type AnySchema = Schema<any>;
type HarnessOptions = NonNullable<Parameters<typeof createModuleTestHarness>[2]>;
type SchemaDef<S extends AnySchema> = S extends Schema<infer D> ? D : never;
type HarnessFor<S extends AnySchema> = ModuleTestHarness<SchemaDef<S>>;
type ReducerCtxFor<S extends AnySchema> = ReducerCtx<SchemaDef<S>>;

export type CreateModuleTestOptions = HarnessOptions & {
  /** Sender used by `tx`, `call`, and `view` when no per-call auth is given. */
  auth?: TestAuth;
};

/** Offline module-test wrapper with the 2.15 harness range shim applied. */
export type ModuleTest<S extends AnySchema> = {
  /** The underlying harness, for cases the convenience methods do not cover. */
  readonly harness: HarnessFor<S>;
  /** The default sender for transactions and views. */
  readonly auth: TestAuth;
  readonly moduleExports: Record<string, unknown>;
  /** Runs a body in a reducer transaction with a shimmed context. */
  tx<T>(body: (ctx: ReducerCtxFor<S>) => T, auth?: TestAuth): T;
  /** Calls a reducer exported by the app with a shimmed context. */
  call<T = void>(name: string, args?: unknown, auth?: TestAuth): T;
  /** Calls an authenticated view with a shimmed context. */
  view<TCtx extends { readonly db: unknown }, TParams, TResult>(
    view: (ctx: TCtx, params: TParams) => TResult,
    params: TParams,
    auth?: TestAuth,
  ): TResult;
  /** Calls an anonymous view with a shimmed context. */
  anonymousView<TCtx extends { readonly db: unknown }, TParams, TResult>(
    view: (ctx: TCtx, params: TParams) => TResult,
    params: TParams,
  ): TResult;
};

/**
 * Creates a fresh, in-memory test for one SpacetimeDB module.
 *
 * The wrapper mirrors `createModuleTestHarness(spacetimedb, moduleExports)` but
 * wraps every reducer and view context with `withIndexRanges`, so composite and
 * range index scans behave like the real host. No server or network is involved.
 */
export function createModuleTest<S extends AnySchema>(
  spacetimedb: S,
  moduleExports: Record<string, unknown>,
  options: CreateModuleTestOptions = {},
): ModuleTest<S> {
  const { auth: defaultAuth = TestAuth.internal(), ...harnessOptions } = options;
  const harness = createModuleTestHarness(
    spacetimedb,
    moduleExports,
    harnessOptions,
  ) as HarnessFor<S>;

  const tx = <T>(
    body: (ctx: ReducerCtxFor<S>) => T,
    auth: TestAuth = defaultAuth,
  ): T =>
    harness.withReducerTx(auth, (ctx) =>
      body(withIndexRanges(ctx as never) as ReducerCtxFor<S>),
    );

  const call = <T>(
    name: string,
    args?: unknown,
    auth?: TestAuth,
  ): T =>
    tx((ctx) => {
      const reducer = moduleExports[name];
      if (typeof reducer !== 'function') {
        throw new Error(
          `createModuleTest: no reducer named '${name}' in moduleExports`,
        );
      }
      return (reducer as (ctx: unknown, args?: unknown) => T)(ctx, args);
    }, auth);

  const view = <TCtx extends { readonly db: unknown }, TParams, TResult>(
    target: (ctx: TCtx, params: TParams) => TResult,
    params: TParams,
    auth: TestAuth = defaultAuth,
  ): TResult => {
    if (typeof target !== 'function') {
      throw new Error('createModuleTest: view must be a function');
    }
    const ctx = harness.viewContext(auth);
    return target(withIndexRanges(ctx as never) as TCtx, params);
  };

  const anonymousView = <TCtx extends { readonly db: unknown }, TParams, TResult>(
    target: (ctx: TCtx, params: TParams) => TResult,
    params: TParams,
  ): TResult => {
    if (typeof target !== 'function') {
      throw new Error('createModuleTest: view must be a function');
    }
    const ctx = harness.anonymousViewContext();
    return target(withIndexRanges(ctx as never) as TCtx, params);
  };

  return {
    harness,
    auth: defaultAuth,
    moduleExports,
    tx,
    call,
    view,
    anonymousView,
  };
}
