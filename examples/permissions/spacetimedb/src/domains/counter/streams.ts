import { streamId as makeStreamId } from 'stdb-es';
import type { Context } from '../../schema.js';
import { assertGoogleSender } from './auth.js';
import {
  COUNTER_KIND,
  STREAM_PREFIXES,
  type CounterKind,
} from './constants.js';

/**
 * The single global counter has a fixed id. Owned counters derive their ids
 * from the verified sender, so callers cannot choose or duplicate an instance.
 */
export function counterStream(ctx: Context, kind: CounterKind): string {
  if (kind === COUNTER_KIND.global) {
    return makeStreamId(STREAM_PREFIXES.global, 'all');
  }

  assertGoogleSender(ctx);
  return makeStreamId(STREAM_PREFIXES[kind], ctx.sender.toHexString());
}
