/** Mirrors `spacetimedb/src/domains/counter/constants.ts`. No server imports. */
export const COUNTER_KIND = {
  global: 'global',
  publicOwned: 'publicOwned',
  privateOwned: 'privateOwned',
} as const;

export const TABLES = {
  publicSummary: 'counter_public_summary',
  privateSummary: 'counter_private_summary',
  publicEvents: 'counter_public_events',
  privateEvents: 'counter_private_events',
} as const;
