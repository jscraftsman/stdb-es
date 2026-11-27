import {
  createCommandClient,
  type CommandCalls,
  type CommandClient,
  type CommandIdOptions,
} from 'stdb-es/client';
import type {
  DecrementGlobalParams,
  DecrementPrivateMineParams,
  DecrementPublicMineParams,
  IncrementGlobalParams,
  IncrementPrivateMineParams,
  IncrementPublicMineParams,
  ResetGlobalParams,
  ResetPrivateMineParams,
  ResetPublicMineParams,
} from '../../generated/types/reducers.js';

/**
 * Intent-only command shapes. `commandId` is added by `createCommandClient`;
 * the browser never sends a stream id, event id, payload, or version.
 */
export type PermissionsCommands = {
  incrementGlobal: Omit<IncrementGlobalParams, 'commandId'>;
  decrementGlobal: Omit<DecrementGlobalParams, 'commandId'>;
  resetGlobal: Omit<ResetGlobalParams, 'commandId'>;
  incrementPublicMine: Omit<IncrementPublicMineParams, 'commandId'>;
  decrementPublicMine: Omit<DecrementPublicMineParams, 'commandId'>;
  resetPublicMine: Omit<ResetPublicMineParams, 'commandId'>;
  incrementPrivateMine: Omit<IncrementPrivateMineParams, 'commandId'>;
  decrementPrivateMine: Omit<DecrementPrivateMineParams, 'commandId'>;
  resetPrivateMine: Omit<ResetPrivateMineParams, 'commandId'>;
};

export type PermissionsCommandClient = CommandClient<PermissionsCommands>;

/** Binds generated reducer calls into one typed command dispatcher. */
export function makePermissionsCommands(
  calls: CommandCalls<PermissionsCommands>,
  options: CommandIdOptions = {},
): PermissionsCommandClient {
  return createCommandClient(calls, options);
}
