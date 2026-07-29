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
