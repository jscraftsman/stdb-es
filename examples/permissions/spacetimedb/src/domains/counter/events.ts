import { EVENT_TYPES } from './constants.js';

/** Stored payloads; the `kind` literal is also the persisted event-type string. */
export type CounterEvent =
  | { kind: typeof EVENT_TYPES.Incremented; by: number }
  | { kind: typeof EVENT_TYPES.Decremented; by: number }
  | { kind: typeof EVENT_TYPES.Reset };
