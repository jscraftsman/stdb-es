import { streamId } from 'stdb-es';
import { STREAM_PREFIXES_COUNTER } from './constants.js';

/** The single public counter used by this UI. Commands send this id, not a stream id. */
export const COUNTER_ID = '1';

/** Read-side id used only for display and audit queries; the module derives write ids. */
export const COUNTER_STREAM_ID = streamId(STREAM_PREFIXES_COUNTER.counter, COUNTER_ID);
