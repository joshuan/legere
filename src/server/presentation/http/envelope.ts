import type { Envelope, ErrorBody, ErrorCode } from '../../../shared/contracts/common';

// Response envelope helpers (docs/07 §7.1).
export function successEnvelope<T>(data: T): Envelope<T> {
  return { data };
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details: unknown = null,
): ErrorBody {
  return { error: { code, message, details } };
}
