/** App-owned literals. The reference client mirrors these values. */
export const COUNTER_KIND = {
  global: 'global',
  publicOwned: 'publicOwned',
  privateOwned: 'privateOwned',
} as const;

export type CounterKind = (typeof COUNTER_KIND)[keyof typeof COUNTER_KIND];

export const STREAM_PREFIXES = {
  global: 'global',
  publicOwned: 'public',
  privateOwned: 'private',
} as const;

export const STREAM_TYPES = {
  Global: 'Global',
  PublicOwned: 'PublicOwned',
  PrivateOwned: 'PrivateOwned',
} as const;

export const EVENT_TYPES = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;

export const TABLES = {
  state: 'counter_state',
  owner: 'counter_owner',
  publicSummary: 'counter_public_summary',
  privateSummary: 'counter_private_summary',
  publicEvents: 'counter_public_events',
  privateEvents: 'counter_private_events',
} as const;

/** Keeps derived event ids below the event-store's 128-character limit. */
export const MAX_COMMAND_ID_LENGTH = 40;
