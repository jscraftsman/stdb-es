import { ES_ERROR } from '../errors.js';
import { esError } from './errors.js';
import {
  ANY_VERSION,
  NO_STREAM,
  STREAM_EXISTS,
  type AppendArgs,
  type AppendResult,
  type EncodedEvent,
  type EventStoreConfig,
} from './protocol.js';
import { GLOBAL_HEAD, type EsCtx, type EventRow } from './tables.js';

const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_PAYLOAD_LENGTH = 64 * 1024;
const MAX_STREAM_ID_LENGTH = 256;
const MAX_EVENT_ID_LENGTH = 128;

function validateEvents(
  events: readonly EncodedEvent[],
  config: EventStoreConfig<any>,
  registered: ReadonlySet<string> | null,
): void {
  const maxBatch = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  if (events.length === 0) {
    throw esError(ES_ERROR.INVALID_BATCH, 'an append must contain at least one event');
  }
  if (events.length > maxBatch) {
    throw esError(ES_ERROR.INVALID_BATCH, `batch of ${events.length} exceeds limit ${maxBatch}`);
  }

  const seen = new Set<string>();
  const maxPayload = config.maxPayloadLength ?? DEFAULT_MAX_PAYLOAD_LENGTH;

  for (const event of events) {
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
      throw esError(ES_ERROR.INVALID_EVENT_ID, 'eventId must be a non-empty string');
    }
    if (event.eventId.length > MAX_EVENT_ID_LENGTH) {
      throw esError(ES_ERROR.INVALID_EVENT_ID, `eventId exceeds ${MAX_EVENT_ID_LENGTH} characters`);
    }
    if (seen.has(event.eventId)) {
      throw esError(ES_ERROR.INVALID_BATCH, `duplicate eventId in batch: ${event.eventId}`);
    }
    seen.add(event.eventId);

    if (typeof event.eventType !== 'string' || event.eventType.length === 0) {
      throw esError(ES_ERROR.UNKNOWN_EVENT_TYPE, 'eventType must be a non-empty string');
    }
    if (registered !== null && !registered.has(event.eventType)) {
      throw esError(ES_ERROR.UNKNOWN_EVENT_TYPE, event.eventType);
    }

    if (typeof event.data !== 'string' || event.data.length === 0) {
      throw esError(ES_ERROR.INVALID_PAYLOAD, `${event.eventId}: payload must be a non-empty string`);
    }
    if (event.data.length > maxPayload) {
      throw esError(ES_ERROR.INVALID_PAYLOAD, `${event.eventId}: payload exceeds ${maxPayload} characters`);
    }
    try {
      JSON.parse(event.data);
    } catch {
      throw esError(ES_ERROR.INVALID_PAYLOAD, `${event.eventId}: payload is not valid JSON`);
    }
  }
}

function assertExpectedVersion(expectedVersion: number, current: number): void {
  if (expectedVersion === ANY_VERSION) return;
  if (expectedVersion === NO_STREAM) {
    if (current !== 0) {
      throw esError(ES_ERROR.EXPECTED_VERSION_MISMATCH, `expected no stream, found version ${current}`);
    }
    return;
  }
  if (expectedVersion === STREAM_EXISTS) {
    if (current === 0) {
      throw esError(ES_ERROR.EXPECTED_VERSION_MISMATCH, 'expected an existing stream, found none');
    }
    return;
  }
  if (expectedVersion < 0) {
    throw esError(ES_ERROR.INVALID_BATCH, `unknown expectedVersion sentinel ${expectedVersion}`);
  }
  if (expectedVersion !== current) {
    throw esError(ES_ERROR.EXPECTED_VERSION_MISMATCH, `expected ${expectedVersion}, found ${current}`);
  }
}

function writeHead(es: EsCtx, position: bigint): void {
  const head = es.db.esHead.id.find(GLOBAL_HEAD);
  if (head) es.db.esHead.id.update({ ...head, position });
  else es.db.esHead.insert({ id: GLOBAL_HEAD, position });
}

/**
 * Appends a batch to a stream inside the caller's transaction.
 *
 * Order matters: dedupe runs *before* the version check so that retrying an
 * already-committed batch returns the settled result instead of a false
 * `ES_EXPECTED_VERSION_MISMATCH`.
 */
export function appendToStream<C extends EsCtx>(
  ctx: C,
  args: AppendArgs,
  config: EventStoreConfig<C> = {},
): AppendResult {
  // The store only touches its own tables, so it narrows the app's context to
  // the store schema internally. `onAppended` still receives the full context.
  const es = ctx as EsCtx;

  if (typeof args.streamId !== 'string' || args.streamId.length === 0) {
    throw esError(ES_ERROR.INVALID_BATCH, 'streamId must be a non-empty string');
  }
  if (args.streamId.length > MAX_STREAM_ID_LENGTH) {
    throw esError(ES_ERROR.INVALID_BATCH, `streamId exceeds ${MAX_STREAM_ID_LENGTH} characters`);
  }
  if (typeof args.streamType !== 'string' || args.streamType.length === 0) {
    throw esError(ES_ERROR.INVALID_BATCH, 'streamType must be a non-empty string');
  }

  const registered = config.eventTypes ? new Set(config.eventTypes) : null;
  validateEvents(args.events, config, registered);

  // 1) Idempotent replay of the whole batch.
  const existing = args.events.map((event) => es.db.esEvent.eventId.find(event.eventId));
  if (existing.every((row) => row !== null)) {
    const rows = existing as EventRow[];
    const foreign = rows.find((row) => row.streamId !== args.streamId);
    if (foreign) {
      throw esError(ES_ERROR.EVENT_ID_CONFLICT, `event ${foreign.eventId} belongs to stream ${foreign.streamId}`);
    }
    return { status: 'replayed', version: rows[rows.length - 1]!.version, rows };
  }
  if (existing.some((row) => row !== null)) {
    const duplicate = args.events[existing.findIndex((row) => row !== null)];
    throw esError(ES_ERROR.PARTIAL_DUPLICATE, `event ${duplicate?.eventId ?? '?'} was already appended`);
  }

  // 2) Optimistic concurrency check and stream-type check.
  const stream = es.db.esStream.streamId.find(args.streamId);
  const current = stream?.version ?? 0;
  if (stream && stream.streamType !== args.streamType) {
    throw esError(ES_ERROR.STREAM_TYPE_MISMATCH, `${stream.streamType} != ${args.streamType}`);
  }
  assertExpectedVersion(args.expectedVersion, current);

  // 3) Append. One head write for the whole batch.
  const createdAt = es.timestamp;
  const createdAtMicros = createdAt.microsSinceUnixEpoch;
  let position = es.db.esHead.id.find(GLOBAL_HEAD)?.position ?? 0n;
  let version = current;
  const rows: EventRow[] = [];

  for (const event of args.events) {
    version += 1;
    position += 1n;
    const row: EventRow = {
      eventId: event.eventId,
      position,
      streamId: args.streamId,
      streamType: args.streamType,
      version,
      eventType: event.eventType,
      data: event.data,
      metadata: event.metadata ?? args.metadata ?? undefined,
      createdAt,
      createdAtMicros,
      createdBy: es.sender,
    };
    es.db.esEvent.insert(row);
    rows.push(row);
  }

  writeHead(es, position);

  if (stream) {
    es.db.esStream.streamId.update({ ...stream, version, updatedAt: createdAt });
  } else {
    es.db.esStream.insert({
      streamId: args.streamId,
      streamType: args.streamType,
      version,
      createdAt,
      updatedAt: createdAt,
      metadata: args.metadata ?? undefined,
    });
  }

  const result: AppendResult = { status: 'appended', version, rows };
  // Runs in the same transaction, so a throwing hook rolls back the append.
  config.onAppended?.(ctx, result);
  return result;
}
