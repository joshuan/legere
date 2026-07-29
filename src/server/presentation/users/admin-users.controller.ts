import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import type { CreatePasswordResetResponse } from '../../../shared/contracts/users';
import { CreatePasswordReset } from '../../application/users/manage-password-resets';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';

// Admin user management (docs/07 §7.3). The reset-link endpoint lands here with M2.5; the rest of
// the admin user lifecycle (list, role change, deactivate, revoke sessions) follows in M2.6.
@Controller('admin/users')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminUsersController {
  constructor(private readonly createPasswordReset: CreatePasswordReset) {}

  @Post(':id/password-reset')
  @HttpCode(HttpStatus.CREATED)
  async passwordReset(
    @Param('id') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<CreatePasswordResetResponse>> {
    return successEnvelope(await this.createPasswordReset.execute(id, admin.id));
  }
}
