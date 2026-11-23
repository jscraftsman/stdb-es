import {
  createCommandClient,
  type CommandCalls,
  type CommandClient,
  type CommandIdOptions,
} from 'stdb-es/client';
import type {
  DecrementParams,
  IncrementParams,
  ResetParams,
} from '../../generated/types/reducers.js';

/**
 * Intent-only command shapes. `commandId` is added by `createCommandClient`, so
 * web code never sends a stream id, event, or expected version.
 */
export type CounterCommands = {
  increment: Omit<IncrementParams, 'commandId'>;
  decrement: Omit<DecrementParams, 'commandId'>;
  reset: Omit<ResetParams, 'commandId'>;
};

export type CounterCommandClient = CommandClient<CounterCommands>;

/** Binds generated reducer hooks into one typed command dispatcher. */
export function makeCounterCommands(
  calls: CommandCalls<CounterCommands>,
  options: CommandIdOptions = {},
): CounterCommandClient {
  return createCommandClient(calls, options);
}
