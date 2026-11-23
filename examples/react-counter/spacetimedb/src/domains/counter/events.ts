import { EVENT_TYPES_COUNTER } from './constants.js';

/** Stored payloads; the `kind` literal is also the persisted event-type string. */
export type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };
