/** App-owned literals for the counter domain. Never exported from the library. */
export const STREAM_TYPES_COUNTER = {
  Counter: 'Counter',
} as const;

export const STREAM_PREFIXES_COUNTER = {
  counter: 'counter',
} as const;

export const EVENT_TYPES_COUNTER = {
  Incremented: 'Incremented',
  Decremented: 'Decremented',
  Reset: 'Reset',
} as const;

export const TABLES_COUNTER = {
  state: 'counter_state',
  owner: 'counter_owner',
  summary: 'counter_summary',
} as const;
