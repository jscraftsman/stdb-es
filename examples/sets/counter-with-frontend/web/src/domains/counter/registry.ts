import { createEventRegistry, type EventDefinition } from 'stdb-es/client';
import { EVENT_TYPES_COUNTER } from './constants.js';

export type CounterEvent =
  | { kind: typeof EVENT_TYPES_COUNTER.Incremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Decremented; by: number }
  | { kind: typeof EVENT_TYPES_COUNTER.Reset };

/** Identity codec: the domain object is already the persisted JSON payload. */
const definitions: Record<string, EventDefinition<CounterEvent, any>> = {
  [EVENT_TYPES_COUNTER.Incremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Incremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Decremented]: {
    encode: (event) => event,
    decode: (payload) => ({ kind: EVENT_TYPES_COUNTER.Decremented, by: payload.by }),
  },
  [EVENT_TYPES_COUNTER.Reset]: {
    encode: (event) => event,
    decode: () => ({ kind: EVENT_TYPES_COUNTER.Reset }),
  },
};

export const counterRegistry = createEventRegistry<CounterEvent>({
  typeOf: (event) => EVENT_TYPES_COUNTER[event.kind],
  events: definitions,
});
