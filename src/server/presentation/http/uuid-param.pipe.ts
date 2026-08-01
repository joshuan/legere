import { Param, type PipeTransform } from '@nestjs/common';
import type { ErrorCode } from '../../../shared/contracts/common';
import { NotFoundError } from '../../domain/errors/domain-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 🔒 A malformed id is answered 404 with the resource's own code, exactly like an id that exists
// nowhere (docs/07 §7.1: "malformed UUID → 404 (not 422)"). Nest's ParseUUIDPipe answers 400 and
// leaks nothing useful either way; letting the string through is worse still, because it reaches
// Prisma and comes back as a 500.
export class UuidParamPipe implements PipeTransform<string, string> {
  constructor(
    private readonly code: ErrorCode,
    private readonly resource: string,
  ) {}

  transform(value: string): string {
    if (!UUID.test(value)) throw new NotFoundError(this.code, `${this.resource} not found`);
    return value;
  }
}

// `@UuidParam('id', 'LIBRARY_NOT_FOUND', 'Library')` — the shape controllers actually use.
export function UuidParam(name: string, code: ErrorCode, resource: string): ParameterDecorator {
  return Param(name, new UuidParamPipe(code, resource));
}
