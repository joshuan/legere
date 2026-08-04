import type { ErrorCode } from '../../../shared/contracts/common';

// Exhaustive map from machine error code to translation key (docs/10 §10.3). Record<ErrorCode, …>
// is deliberate: adding a code to the contracts without a message here is a type error, so the UI
// can never fall back to showing the server's developer-facing `message`.
export const ERROR_MESSAGE_KEYS: Record<ErrorCode | 'NETWORK', string> = {
  UNAUTHENTICATED: 'errors.codes.UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'errors.codes.INVALID_CREDENTIALS',
  FORBIDDEN: 'errors.codes.FORBIDDEN',
  NOT_FOUND: 'errors.codes.NOT_FOUND',
  USER_NOT_FOUND: 'errors.codes.USER_NOT_FOUND',
  LIBRARY_NOT_FOUND: 'errors.codes.LIBRARY_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'errors.codes.DOCUMENT_NOT_FOUND',
  DOCUMENT_TYPE_NOT_FOUND: 'errors.codes.DOCUMENT_TYPE_NOT_FOUND',
  COLLECTION_NOT_FOUND: 'errors.codes.COLLECTION_NOT_FOUND',
  SCANSET_NOT_FOUND: 'errors.codes.SCANSET_NOT_FOUND',
  INVITE_NOT_FOUND: 'errors.codes.INVITE_NOT_FOUND',
  EMAIL_ALREADY_REGISTERED: 'errors.codes.EMAIL_ALREADY_REGISTERED',
  LAST_ADMIN: 'errors.codes.LAST_ADMIN',
  LIBRARY_PATH_CONFLICT: 'errors.codes.LIBRARY_PATH_CONFLICT',
  DOCUMENT_TYPE_SLUG_TAKEN: 'errors.codes.DOCUMENT_TYPE_SLUG_TAKEN',
  PERSON_EXISTS: 'errors.codes.PERSON_EXISTS',
  PERSON_NOT_FOUND: 'errors.codes.PERSON_NOT_FOUND',
  DOCUMENT_DUPLICATE: 'errors.codes.DOCUMENT_DUPLICATE',
  COLLECTION_NAME_TAKEN: 'errors.codes.COLLECTION_NAME_TAKEN',
  SCANSET_INVALID_STATE: 'errors.codes.SCANSET_INVALID_STATE',
  DOCUMENT_UNAVAILABLE: 'errors.codes.DOCUMENT_UNAVAILABLE',
  ONBOARDING_CLOSED: 'errors.codes.ONBOARDING_CLOSED',
  VALIDATION_FAILED: 'errors.codes.VALIDATION_FAILED',
  LIBRARY_PATH_INVALID: 'errors.codes.LIBRARY_PATH_INVALID',
  SCANSET_ITEM_NOT_IMAGE: 'errors.codes.SCANSET_ITEM_NOT_IMAGE',
  EMAIL_CODE_INVALID: 'errors.codes.EMAIL_CODE_INVALID',
  REGISTRATION_TICKET_INVALID: 'errors.codes.REGISTRATION_TICKET_INVALID',
  INVITE_INVALID: 'errors.codes.INVITE_INVALID',
  RESET_INVALID: 'errors.codes.RESET_INVALID',
  CAPTCHA_FAILED: 'errors.codes.CAPTCHA_FAILED',
  RATE_LIMITED: 'errors.codes.RATE_LIMITED',
  EMAIL_CODE_TOO_MANY_ATTEMPTS: 'errors.codes.EMAIL_CODE_TOO_MANY_ATTEMPTS',
  INTERNAL: 'errors.codes.INTERNAL',
  NETWORK: 'errors.network',
};

export function messageKeyFor(code: ErrorCode | 'NETWORK'): string {
  return ERROR_MESSAGE_KEYS[code];
}
