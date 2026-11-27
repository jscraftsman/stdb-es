import { describe, expect, it } from 'vitest';
import { schema } from 'spacetimedb/server';
import { esTables } from '../src/server/index.js';

/**
 * Cache policies the SDK emits, keyed by schema accessor. In SDK 2.16,
 * `required_in_memory` is the default, so only non-default policies appear.
 */
function emittedCachePolicies(): Record<string, string> {
  const { moduleDef } = schema(esTables);
  return Object.fromEntries(
    moduleDef.tableCachePolicies.map(({ tableName, policy }) => [tableName, policy.tag]),
  );
}

describe('library table cache policies', () => {
  it('allows the append-only event log to use tiered storage', () => {
    expect(emittedCachePolicies().esEvent).toBe('NoRequirement');
  });

  it('leaves the stream catalogue on the in-memory default', () => {
    expect(emittedCachePolicies().esStream).toBeUndefined();
  });

  it('leaves the global position counter on the in-memory default', () => {
    expect(emittedCachePolicies().esHead).toBeUndefined();
  });

  it('emits only the non-default library policy', () => {
    expect(emittedCachePolicies()).toEqual({ esEvent: 'NoRequirement' });
  });
});
