import { Body, Injectable, type PipeTransform, Query } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';
import { ValidationFailedError } from '../../domain/errors/domain-error';

// Per-route Zod validation (docs/06 §6.4): a schema-bound pipe that returns typed data or throws
// ValidationFailedError (→ 422 VALIDATION_FAILED with flattened issues in `details`). Applied via the
// @ZodBody/@ZodQuery decorators so controllers declare the contract schema per route.
// The input type is deliberately `unknown`: query strings and JSON bodies arrive untyped, and
// schemas with defaults or coercion have an input type that differs from what they produce.
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationFailedError({ issues: result.error.flatten() });
    }
    return result.data;
  }
}

export function ZodBody<T>(schema: ZodType<T, ZodTypeDef, unknown>): ParameterDecorator {
  return Body(new ZodValidationPipe(schema));
}

export function ZodQuery<T>(schema: ZodType<T, ZodTypeDef, unknown>): ParameterDecorator {
  return Query(new ZodValidationPipe(schema));
}
