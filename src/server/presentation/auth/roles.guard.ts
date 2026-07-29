import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '../../../shared/contracts/enums';
import { ForbiddenError } from '../../domain/errors/domain-error';
import { callerOf } from './current-user';

const ROLES_KEY = 'legereRoles';

// @Roles('ADMIN') on a route or controller; runs after SessionGuard (docs/06 §6.4).
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const caller = callerOf(context.switchToHttp().getRequest<Request>());
    if (caller === undefined) throw new ForbiddenError('Forbidden');
    if (!required.includes(caller.user.role)) {
      throw new ForbiddenError('This action requires a different role');
    }
    return true;
  }
}
