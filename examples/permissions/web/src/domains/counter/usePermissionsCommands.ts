import { useMemo } from 'react';
import { useReducer as useSpacetimeReducer } from 'spacetimedb/react';
import { reducers } from '../../generated/index.js';
import { makePermissionsCommands } from './api.js';

/** React binding: generated reducer calls -> one command client. */
export function usePermissionsCommands() {
  const incrementGlobal = useSpacetimeReducer(reducers.incrementGlobal);
  const decrementGlobal = useSpacetimeReducer(reducers.decrementGlobal);
  const resetGlobal = useSpacetimeReducer(reducers.resetGlobal);
  const incrementPublicMine = useSpacetimeReducer(reducers.incrementPublicMine);
  const decrementPublicMine = useSpacetimeReducer(reducers.decrementPublicMine);
  const resetPublicMine = useSpacetimeReducer(reducers.resetPublicMine);
  const incrementPrivateMine = useSpacetimeReducer(reducers.incrementPrivateMine);
  const decrementPrivateMine = useSpacetimeReducer(reducers.decrementPrivateMine);
  const resetPrivateMine = useSpacetimeReducer(reducers.resetPrivateMine);

  return useMemo(
    () =>
      makePermissionsCommands({
        incrementGlobal,
        decrementGlobal,
        resetGlobal,
        incrementPublicMine,
        decrementPublicMine,
        resetPublicMine,
        incrementPrivateMine,
        decrementPrivateMine,
        resetPrivateMine,
      }),
    [
      incrementGlobal,
      decrementGlobal,
      resetGlobal,
      incrementPublicMine,
      decrementPublicMine,
      resetPublicMine,
      incrementPrivateMine,
      decrementPrivateMine,
      resetPrivateMine,
    ],
  );
}
