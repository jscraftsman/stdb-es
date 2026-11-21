/**
 * Browser-facing write boundary.
 *
 * The client sends intent only. It never builds an event envelope: no stream id,
 * stream type, event type, event id, payload or expected version is chosen here.
 * Those are decided by the app's command reducers on the server, which are the
 * only code allowed to call `appendToStream`.
 */

/** A command payload plus its idempotency key. Contains intent, never event data. */
export type CommandEnvelope<TCommand> = TCommand & { commandId: string };

/** Callback shape of a generated command reducer binding from `spacetime generate`. */
export type CommandCall<TCommand> = (command: CommandEnvelope<TCommand>) => Promise<unknown>;

export type CommandIdOptions = {
  /** Overrides the default `crypto.randomUUID()` generator. */
  newCommandId?: () => string;
};

export type WithCommandIdOptions = CommandIdOptions & {
  /** Supplies a specific key, for example one persisted with a pending command. */
  commandId?: string;
};

function defaultCommandId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('no crypto.randomUUID available; pass newCommandId');
  }
  return globalThis.crypto.randomUUID();
}

/** Generates a fresh idempotency key for a command. */
export function newCommandId(): string {
  return defaultCommandId();
}

/**
 * Adds an idempotency key to a command without sending it.
 *
 * Keep the returned envelope to retry the same command verbatim after a timeout.
 * An existing string `commandId` on the payload is preserved, so an envelope can
 * safely be passed through this helper again.
 */
export function withCommandId<TCommand extends object>(
  command: TCommand,
  options: WithCommandIdOptions = {},
): CommandEnvelope<TCommand> {
  const prior = (command as { commandId?: unknown }).commandId;
  const commandId =
    options.commandId ??
    (typeof prior === 'string' && prior.length > 0
      ? prior
      : (options.newCommandId ?? defaultCommandId)());
  return { ...command, commandId };
}

/** One generated command reducer per command name. */
export type CommandCalls<TCommands extends Record<string, object>> = {
  [K in keyof TCommands]: CommandCall<TCommands[K]>;
};

/**
 * Binds generated command reducers into a typed dispatch helper.
 *
 * `sendNew` returns the envelope it sent so a caller can retry it unchanged;
 * `send` takes an envelope that was already prepared (or persisted). Neither
 * method accepts an event, a stream id, or an expected version.
 */
export function createCommandClient<TCommands extends Record<string, object>>(
  calls: CommandCalls<TCommands>,
  options: CommandIdOptions = {},
) {
  type Name = keyof TCommands;

  const prepare = <K extends Name>(
    name: K,
    command: TCommands[K],
    prepareOptions: WithCommandIdOptions = {},
  ): CommandEnvelope<TCommands[K]> =>
    withCommandId(command, { newCommandId: options.newCommandId, ...prepareOptions });

  const dispatch = async <K extends Name>(name: K, command: CommandEnvelope<TCommands[K]>) => {
    const call = calls[name] as (value: unknown) => Promise<unknown>;
    await call(command);
  };

  return {
    /** Adds an idempotency key without sending. */
    prepare,

    /** Sends an already-prepared command envelope. */
    send: dispatch,

    /** Prepares, sends, and returns the envelope for a verbatim retry. */
    async sendNew<K extends Name>(
      name: K,
      command: TCommands[K],
      sendOptions: WithCommandIdOptions = {},
    ): Promise<CommandEnvelope<TCommands[K]>> {
      const envelope = prepare(name, command, sendOptions);
      await dispatch(name, envelope);
      return envelope;
    },
  };
}

export type CommandClient<TCommands extends Record<string, object>> = ReturnType<
  typeof createCommandClient<TCommands>
>;
