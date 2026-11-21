import type { CommandCall, CommandEnvelope } from '../client/command.js';

export type FakeCommandOptions = {
  /** Value every call resolves with unless a queued reply is available. */
  result?: unknown;
  /** Error every call rejects with unless a queued reply is available. */
  error?: unknown;
};

type QueuedReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/**
 * Stand-in for a generated command reducer binding from `spacetime generate`.
 *
 * It records the intent payload (including `commandId`) and resolves with the
 * configured reply. Unlike the old append fake, it never sees an event, stream
 * id, or expected version: those belong to the module.
 */
export type FakeCommand<TCommand extends object = Record<string, unknown>> =
  CommandCall<TCommand> & {
    /** One snapshot per call, in call order. */
    readonly calls: CommandEnvelope<TCommand>[];
    /** The most recent call, or `undefined` before the first call. */
    readonly lastCall: CommandEnvelope<TCommand> | undefined;
    /** Queues one successful reply for the next call. */
    nextResult(value: unknown): FakeCommand<TCommand>;
    /** Queues one rejected reply for the next call. */
    nextError(error: unknown): FakeCommand<TCommand>;
    /** Clears recorded calls; queued replies are left intact. */
    clear(): FakeCommand<TCommand>;
  };

function snapshot<TCommand extends object>(
  command: CommandEnvelope<TCommand>,
): CommandEnvelope<TCommand> {
  return { ...command };
}

/** Creates a fake generated command reducer for client unit tests. */
export function createFakeCommand<TCommand extends object = Record<string, unknown>>(
  options: FakeCommandOptions = {},
): FakeCommand<TCommand> {
  if (options.result !== undefined && options.error !== undefined) {
    throw new Error('createFakeCommand: provide result or error, not both');
  }

  const defaultReply: QueuedReply =
    options.error !== undefined
      ? { ok: false, error: options.error }
      : { ok: true, value: options.result };
  const queue: QueuedReply[] = [];
  const calls: CommandEnvelope<TCommand>[] = [];

  const fake = ((command: CommandEnvelope<TCommand>): Promise<unknown> => {
    calls.push(snapshot(command));
    const reply = queue.shift() ?? defaultReply;
    return reply.ok ? Promise.resolve(reply.value) : Promise.reject(reply.error);
  }) as FakeCommand<TCommand>;

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
