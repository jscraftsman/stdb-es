import { esErrorCode, type EsErrorCode } from '../errors.js';

type MaybePromise<T> = T | PromiseLike<T>;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function failure(expected: EsErrorCode, error: unknown): Error {
  const actual = esErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  if (actual === null) {
    return new Error(`Expected append to throw ${expected}; got ${detail}`);
  }
  return new Error(`Expected append to throw ${expected}; got ${actual}: ${detail}`);
}

function noFailure(expected: EsErrorCode): Error {
  return new Error(`Expected append to throw ${expected}; it resolved successfully`);
}

function check(error: unknown, expected: EsErrorCode): void {
  if (esErrorCode(error) !== expected) throw failure(expected, error);
}

/**
 * Asserts that a reducer or append call fails with a specific stable `ES_*` code.
 *
 * The assertion is runner-agnostic: it throws a plain `Error` on failure, so it
 * works with Vitest, Node's test runner, or a plain script. It accepts both
 * synchronous reducer calls and asynchronous client calls.
 */
export function expectAppendError<T>(
  fn: () => PromiseLike<T>,
  expected: EsErrorCode,
): Promise<void>;
export function expectAppendError<T>(fn: () => T, expected: EsErrorCode): void;
export function expectAppendError<T>(
  fn: () => MaybePromise<T>,
  expected: EsErrorCode,
): void | Promise<void> {
  let result: MaybePromise<T>;
  try {
    result = fn();
  } catch (error) {
    check(error, expected);
    return;
  }

  if (isThenable(result)) {
    return Promise.resolve(result).then(
      () => {
        throw noFailure(expected);
      },
      (error: unknown) => {
        check(error, expected);
      },
    );
  }

  throw noFailure(expected);
}
