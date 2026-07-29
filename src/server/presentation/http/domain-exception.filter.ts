import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import type { ErrorCode } from '../../../shared/contracts/common';
import { DomainError } from '../../domain/errors/domain-error';
import { errorEnvelope } from './envelope';

// Global filter (docs/06 §6.4): DomainError → typed envelope + its HTTP status; Nest HttpExceptions
// (e.g. from guards/throttler) → mapped envelope; anything else → 500 INTERNAL with the stack logged
// and no internals leaked to the client.
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(DomainExceptionFilter.name) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof DomainError) {
      response
        .status(exception.httpStatus)
        .json(errorEnvelope(exception.code, exception.message, exception.details));
      return;
    }

    if (exception instanceof HttpException) {
      // Nest throws NotFoundException for unmatched /api routes and Unauthorized/Forbidden from
      // guards; map to a stable code + developer-hint message (the UI localizes by code, docs/07 §7.1)
      // so unknown routes yield the documented { code: NOT_FOUND, message: 'Unknown API route' } body.
      const status = exception.getStatus();
      const code = this.codeForStatus(status);
      response.status(status).json(errorEnvelope(code, this.messageForCode(code)));
      return;
    }

    this.logger.error({ err: exception }, 'Unhandled exception');
    response
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json(errorEnvelope('INTERNAL', 'Internal server error'));
  }

  private codeForStatus(status: number): ErrorCode {
    const byStatus: Record<number, ErrorCode> = {
      [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
      [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
      [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
      [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
      [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
    };
    return byStatus[status] ?? 'INTERNAL';
  }

  private messageForCode(code: ErrorCode): string {
    const messages: Partial<Record<ErrorCode, string>> = {
      NOT_FOUND: 'Unknown API route',
      UNAUTHENTICATED: 'Authentication required',
      FORBIDDEN: 'Forbidden',
      RATE_LIMITED: 'Too many requests',
      VALIDATION_FAILED: 'Request validation failed',
    };
    return messages[code] ?? 'Internal server error';
  }
}
