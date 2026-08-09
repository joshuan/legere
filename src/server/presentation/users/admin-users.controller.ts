import { Controller, Get, HttpCode, HttpStatus, Patch, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  listUsersQuerySchema,
  updateUserRequestSchema,
  type AdminUserDto,
  type CreatePasswordResetResponse,
  type ListUsersQuery,
  type ListUsersResponse,
  type RevokeSessionsResponse,
  type UpdateUserRequest,
} from '../../../shared/contracts/users';
import { CreatePasswordReset } from '../../application/users/manage-password-resets';
import {
  ChangeUserRole,
  DeactivateUser,
  ListUsers,
  ReactivateUser,
  RevokeUserSessions,
} from '../../application/users/manage-users';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodQuery, ZodBody } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// Admin user lifecycle (docs/07 §7.3). Guard order is SessionGuard → RolesGuard (docs/06 §6.4).
@Controller('admin/users')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminUsersController {
  constructor(
    private readonly listUsers: ListUsers,
    private readonly changeUserRole: ChangeUserRole,
    private readonly deactivateUser: DeactivateUser,
    private readonly reactivateUser: ReactivateUser,
    private readonly revokeUserSessions: RevokeUserSessions,
    private readonly createPasswordReset: CreatePasswordReset,
  ) {}

  @Get()
  async list(
    @ZodQuery(listUsersQuerySchema) query: ListUsersQuery,
  ): Promise<Envelope<ListUsersResponse>> {
    return successEnvelope(await this.listUsers.execute(query));
  }

  // Each of the four below takes the calling admin as well as the target: a change of authority is
  // recorded against whoever made it (docs/06 §6.7).
  @Patch(':id')
  async update(
    @UuidParam('id', 'USER_NOT_FOUND', 'User') id: string,
    @ZodBody(updateUserRequestSchema) body: UpdateUserRequest,
    @CurrentUser() admin: User,
  ): Promise<Envelope<AdminUserDto>> {
    // The schema guarantees at least one field; role is the only one today.
    const role = body.role;
    if (role === undefined) throw new Error('unreachable: schema requires a role');
    return successEnvelope(await this.changeUserRole.execute(id, role, admin.id));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @UuidParam('id', 'USER_NOT_FOUND', 'User') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<AdminUserDto>> {
    return successEnvelope(await this.deactivateUser.execute(id, admin.id));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @UuidParam('id', 'USER_NOT_FOUND', 'User') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<AdminUserDto>> {
    return successEnvelope(await this.reactivateUser.execute(id, admin.id));
  }

  @Post(':id/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  async revokeSessions(
    @UuidParam('id', 'USER_NOT_FOUND', 'User') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<RevokeSessionsResponse>> {
    return successEnvelope(await this.revokeUserSessions.execute(id, admin.id));
  }

  @Post(':id/password-reset')
  @HttpCode(HttpStatus.CREATED)
  async passwordReset(
    @UuidParam('id', 'USER_NOT_FOUND', 'User') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<CreatePasswordResetResponse>> {
    return successEnvelope(await this.createPasswordReset.execute(id, admin.id));
  }
}
