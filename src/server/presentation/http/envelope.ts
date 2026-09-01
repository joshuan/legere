import type { Envelope, ErrorBody, ErrorCode } from '../../../shared/contracts/common';
import {
  errorEnvelope as sharedErrorEnvelope,
  successEnvelope as sharedSuccessEnvelope,
} from '@joshuan/http';

// Response envelope helpers (docs/07 §7.1).
export function successEnvelope<T>(data: T): Envelope<T> {
  return sharedSuccessEnvelope(data);
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details: unknown = null,
): ErrorBody {
  return sharedErrorEnvelope(code, message, details);
}
