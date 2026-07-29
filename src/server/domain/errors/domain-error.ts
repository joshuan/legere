import type { ErrorCode } from '../../../shared/contracts/common';

// Sealed domain error hierarchy (docs/06 §6.2). Each error carries the machine `code` (docs/07 §7.2)
// and the HTTP status the presentation filter maps it to. Domain/application throw these; the
// DomainExceptionFilter turns them into the error envelope. No framework imports here.
export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  readonly details: unknown;

  constructor(message: string, details: unknown = null) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

// Raised by the Zod validation pipe on request-body/query failure (422, docs/07 §7.2).
export class ValidationFailedError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 422;

  constructor(details: unknown) {
    super('Request validation failed', details);
  }
}

// Generic 404 for resource lookups; callers pass the specific code (e.g. DOCUMENT_NOT_FOUND).
export class NotFoundError extends DomainError {
  readonly httpStatus = 404;

  constructor(
    readonly code: ErrorCode,
    message = 'Resource not found',
  ) {
    super(message);
  }
}

// Authorization failure / deactivated user / CSRF failure (403, docs/07 §7.2).
export class ForbiddenError extends DomainError {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(message = 'Forbidden') {
    super(message);
  }
}

// 401 UNAUTHENTICATED — no or invalid session.
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor(message = 'Authentication required') {
    super(message);
  }
}

// 401 INVALID_CREDENTIALS — login only; deliberately identical for unknown email and wrong password.
export class InvalidCredentialsError extends DomainError {
  readonly code = 'INVALID_CREDENTIALS';
  readonly httpStatus = 401;

  constructor(message = 'Invalid credentials') {
    super(message);
  }
}

// 409 conflicts: EMAIL_ALREADY_REGISTERED, LAST_ADMIN, LIBRARY_PATH_CONFLICT, CATEGORY_SLUG_TAKEN,
// COLLECTION_NAME_TAKEN, SCANSET_INVALID_STATE, DOCUMENT_UNAVAILABLE.
export class ConflictError extends DomainError {
  readonly httpStatus = 409;

  constructor(
    readonly code: ErrorCode,
    message = 'Conflict',
  ) {
    super(message);
  }
}

// 410 ONBOARDING_CLOSED — onboarding attempted after the first user exists.
export class OnboardingClosedError extends DomainError {
  readonly code = 'ONBOARDING_CLOSED';
  readonly httpStatus = 410;

  constructor(message = 'Onboarding is already complete') {
    super(message);
  }
}

// 400 auth-flow failures: EMAIL_CODE_INVALID, REGISTRATION_TICKET_INVALID, INVITE_INVALID,
// RESET_INVALID, CAPTCHA_FAILED.
export class AuthFlowError extends DomainError {
  readonly httpStatus = 400;

  constructor(
    readonly code: ErrorCode,
    message = 'Authentication flow failed',
  ) {
    super(message);
  }
}

// 429 RATE_LIMITED / EMAIL_CODE_TOO_MANY_ATTEMPTS.
export class RateLimitedError extends DomainError {
  readonly httpStatus = 429;

  constructor(
    readonly code: ErrorCode = 'RATE_LIMITED',
    message = 'Too many requests',
  ) {
    super(message);
  }
}

// 422 semantic validation beyond schema shape: LIBRARY_PATH_INVALID, SCANSET_ITEM_NOT_IMAGE.
export class UnprocessableError extends DomainError {
  readonly httpStatus = 422;

  constructor(
    readonly code: ErrorCode,
    message = 'Unprocessable request',
  ) {
    super(message);
  }
}
