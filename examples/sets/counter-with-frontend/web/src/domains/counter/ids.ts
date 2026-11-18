import { streamId } from 'stdb-es';
import { STREAM_PREFIXES_COUNTER } from './constants.js';

/** The single public counter used by this UI. */
export const COUNTER_STREAM_ID = streamId(STREAM_PREFIXES_COUNTER.counter, '1');
