import type { EncodedEvent } from '../server/protocol.js';

/**
 * Test-only shapes for a generated append binding.
 *
 * These used to be imported from `stdb-es/client`, which no longer ships an
 * append API. Keeping them local preserves `createFakeAppend` while the unit
 * kit moves to command fakes in the next phase of the breaking change.
 */
export type AppendCallArgs = {
  streamId: string;
  streamType: string;
  expectedVersion: number;
  events: EncodedEvent[];
  metadata: string | null;
};

export type AppendCall = (args: AppendCallArgs) => Promise<unknown>;

export type FakeAppendOptions = {
  /** Value every call resolves with unless a queued reply is available. */
  result?: unknown;
  /** Error every call rejects with unless a queued reply is available. */
  error?: unknown;
};

type QueuedReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** Generated append-binding stand-in for client unit tests. */
export type FakeAppend = AppendCall & {
  /** One snapshot per call, in call order. */
  readonly calls: AppendCallArgs[];
  /** The most recent call, or `undefined` before the first call. */
  readonly lastCall: AppendCallArgs | undefined;
  /** Queues one successful reply for the next call. */
  nextResult(value: unknown): FakeAppend;
  /** Queues one rejected reply for the next call. */
  nextError(error: unknown): FakeAppend;
  /** Clears recorded calls; queued replies are left intact. */
  clear(): FakeAppend;
};

function snapshot(args: AppendCallArgs): AppendCallArgs {
  return { ...args, events: [...args.events] };
}

/**
 * Creates a fake generated `append` reducer binding.
 *
 * It records each call, including a copy of the encoded event array, and resolves
 * with the configured result. Use `nextResult`/`nextError` for sequences such as
 * a timeout followed by a successful retry.
 */
export function createFakeAppend(options: FakeAppendOptions = {}): FakeAppend {
  if (options.result !== undefined && options.error !== undefined) {
    throw new Error('createFakeAppend: provide result or error, not both');
  }

  const defaultReply: QueuedReply =
    options.error !== undefined
      ? { ok: false, error: options.error }
      : { ok: true, value: options.result };
  const queue: QueuedReply[] = [];
  const calls: AppendCallArgs[] = [];

  const fake = ((args: AppendCallArgs): Promise<unknown> => {
    calls.push(snapshot(args));
    const reply = queue.shift() ?? defaultReply;
    return reply.ok ? Promise.resolve(reply.value) : Promise.reject(reply.error);
  }) as FakeAppend;

  Object.defineProperties(fake, {
    calls: { value: calls },
    lastCall: { get: () => calls[calls.length - 1] },
  });

  fake.nextResult = (value: unknown) => {
    queue.push({ ok: true, value });
    return fake;
  };
  fake.nextError = (error: unknown) => {
    queue.push({ ok: false, error });
    return fake;
  };
  fake.clear = () => {
    calls.length = 0;
    return fake;
  };

  return fake;
}
