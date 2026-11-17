import { describe, expect, it } from 'vitest';
import { ES_ERROR, esErrorCode, streamId } from '../src/index.js';

describe('streamId', () => {
  it('builds ids from string, number, and bigint keys', () => {
    expect(streamId('order', '42')).toBe('order-42');
    expect(streamId('order', 42)).toBe('order-42');
    expect(streamId('account', 123n)).toBe('account-123');
  });

  it('accepts common opaque id shapes', () => {
    expect(streamId('order', '018f3f0c-2b6a-7c11-8f4a-9b0d5c2e1a44')).toBe(
      'order-018f3f0c-2b6a-7c11-8f4a-9b0d5c2e1a44',
    );
    expect(streamId('account', 'abcdef.01:02')).toBe('account-abcdef.01:02');
  });

  it('rejects empty or unsafe prefixes and keys', () => {
    expect(() => streamId('', '42')).toThrow();
    expect(() => streamId('1order', '42')).toThrow();
    expect(() => streamId('order-name', '42')).toThrow();
    expect(() => streamId('order', '')).toThrow();
    expect(() => streamId('order', "O'Brien")).toThrow();
    expect(() => streamId('order', '42; DROP TABLE es_event')).toThrow();
  });

  it('rejects non-integer and negative numeric keys', () => {
    expect(() => streamId('order', 1.5)).toThrow();
    expect(() => streamId('order', Number.NaN)).toThrow();
    expect(() => streamId('order', -1)).toThrow();
    expect(() => streamId('order', -1n)).toThrow();
  });

  it('enforces the same 256-character limit as appendToStream', () => {
    const key = 'a'.repeat(255 - 'order'.length);
    expect(streamId('order', key)).toHaveLength(256);
    expect(() => streamId('order', `${key}a`)).toThrow();
  });

  it('uses the stable invalid-batch error code', () => {
    try {
      streamId('order', 'bad key');
      throw new Error('expected streamId to throw');
    } catch (error) {
      expect(esErrorCode(error)).toBe(ES_ERROR.INVALID_BATCH);
    }
  });
});
