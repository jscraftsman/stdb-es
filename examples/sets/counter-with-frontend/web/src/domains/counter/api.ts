import { createEventStoreClient } from 'stdb-es/client';
import type { AppendEventsParams } from '../../generated/types/reducers.js';
import { counterRegistry } from './registry.js';

type EncodedEvents = AppendEventsParams['events'];

/** The typed `useReducer(reducers.appendEvents)` call. */
export type AppendCall = (params: AppendEventsParams) => Promise<void>;

export function makeCounterStore(callAppend: AppendCall) {
  return createEventStoreClient({
    registry: counterRegistry,
    // The client library produces one args object, which matches generated reducers.
    append: (args) =>
      callAppend({
        streamId: args.streamId,
        streamType: args.streamType,
        expectedVersion: args.expectedVersion,
        events: args.events as EncodedEvents,
        metadata: args.metadata ?? undefined,
      }),
  });
}
