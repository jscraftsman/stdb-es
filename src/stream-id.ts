import { ES_ERROR, buildEsErrorMessage } from './errors.js';

/** Mirrors the stream-id limit enforced by `appendToStream`. */
const MAX_STREAM_ID_LENGTH = 256;

/** Prefixes are identifier-like, so the `-` separator stays unambiguous. */
const PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Keys allow common opaque id shapes: UUIDs, hex ids, dotted and colon-separated keys. */
const KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type StreamIdKey = string | number | bigint;

function invalid(detail: string): Error {
  return new Error(buildEsErrorMessage(ES_ERROR.INVALID_BATCH, detail));
}

function keyToString(key: StreamIdKey): string {
  if (typeof key === 'number' && (!Number.isSafeInteger(key) || key < 0)) {
    throw invalid('streamId key must be a non-negative safe integer, bigint, or safe string');
  }
  if (typeof key === 'bigint' && key < 0n) {
    throw invalid('streamId key must be a non-negative bigint or safe string');
  }
  return String(key);
}

/**
 * Builds a stable, validated stream id of the form `<prefix>-<key>`.
 *
 * Use this in module code that derives a stream id from validated command data,
 * and in client code that formats the same id for read-side queries or subscriptions.
 * It keeps the separator unambiguous, rejects id-shaped strings that can break SQL
 * queries or logs, and enforces the same 256-character limit as the append path.
 *
 * It is a formatting helper only. The module owns write-side stream ids and authorization;
 * browser commands must not send a stream id as part of the command payload.
 */
export function streamId(prefix: string, key: StreamIdKey): string {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw invalid(
      'streamId prefix must start with a letter and contain only letters, digits, or underscores',
    );
  }

  const value = keyToString(key);
  if (!KEY_PATTERN.test(value)) {
    throw invalid(
      'streamId key must contain only letters, digits, underscores, dots, colons, or hyphens',
    );
  }

  const id = `${prefix}-${value}`;
  if (id.length > MAX_STREAM_ID_LENGTH) {
    throw invalid(`streamId exceeds ${MAX_STREAM_ID_LENGTH} characters`);
  }
  return id;
}
