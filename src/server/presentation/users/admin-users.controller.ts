import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
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

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @ZodBody(updateUserRequestSchema) body: UpdateUserRequest,
  ): Promise<Envelope<AdminUserDto>> {
    // The schema guarantees at least one field; role is the only one today.
    const role = body.role;
    if (role === undefined) throw new Error('unreachable: schema requires a role');
    return successEnvelope(await this.changeUserRole.execute(id, role));
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(@Param('id') id: string): Promise<Envelope<AdminUserDto>> {
    return successEnvelope(await this.deactivateUser.execute(id));
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id') id: string): Promise<Envelope<AdminUserDto>> {
    return successEnvelope(await this.reactivateUser.execute(id));
  }

  @Post(':id/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  async revokeSessions(@Param('id') id: string): Promise<Envelope<RevokeSessionsResponse>> {
    return successEnvelope(await this.revokeUserSessions.execute(id));
  }

  @Post(':id/password-reset')
  @HttpCode(HttpStatus.CREATED)
  async passwordReset(
    @Param('id') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<CreatePasswordResetResponse>> {
    return successEnvelope(await this.createPasswordReset.execute(id, admin.id));
  }
}
