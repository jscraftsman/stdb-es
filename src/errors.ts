/**
 * Stable error codes shared by the server and client entries. Clients should
 * match on these codes, never on the human-readable detail.
 */
export const ES_ERROR = {
  /** The caller's expected version does not match the stream's current version. */
  EXPECTED_VERSION_MISMATCH: 'ES_EXPECTED_VERSION_MISMATCH',
  /** An event id in the batch already exists on a different stream. */
  EVENT_ID_CONFLICT: 'ES_EVENT_ID_CONFLICT',
  /** Some, but not all, event ids in the batch already exist. */
  PARTIAL_DUPLICATE: 'ES_PARTIAL_DUPLICATE',
  /** The stream exists but belongs to a different stream type. */
  STREAM_TYPE_MISMATCH: 'ES_STREAM_TYPE_MISMATCH',
  /** The append batch itself is malformed. */
  INVALID_BATCH: 'ES_INVALID_BATCH',
  /** The event type is not registered with the event store. */
  UNKNOWN_EVENT_TYPE: 'ES_UNKNOWN_EVENT_TYPE',
  /** The event id is missing or has an unusable shape. */
  INVALID_EVENT_ID: 'ES_INVALID_EVENT_ID',
  /** The payload is not valid JSON or exceeds the configured size limit. */
  INVALID_PAYLOAD: 'ES_INVALID_PAYLOAD',
} as const;

export type EsErrorCode = (typeof ES_ERROR)[keyof typeof ES_ERROR];

/** Formats the message carried by a store error. */
export function buildEsErrorMessage(code: EsErrorCode, detail: string): string {
  return `${code}: ${detail}`;
}

/** The error code of a thrown store error, or null for unrelated errors. */
export function esErrorCode(error: unknown): EsErrorCode | null {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of Object.values(ES_ERROR)) {
    if (message.startsWith(`${code}:`) || message === code) return code;
  }
  return null;
}

/** True when `error` came from the event store. */
export function isEsError(error: unknown): boolean {
  return esErrorCode(error) !== null;
}
