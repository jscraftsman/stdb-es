import { SenderError } from 'spacetimedb/server';
import { buildEsErrorMessage, type EsErrorCode } from '../errors.js';

export {
  ES_ERROR,
  buildEsErrorMessage,
  esErrorCode,
  isEsError,
  type EsErrorCode,
} from '../errors.js';

/** Throws a reducer-visible error with a stable code prefix. */
export function esError(code: EsErrorCode, detail: string): SenderError {
  return new SenderError(buildEsErrorMessage(code, detail));
}
