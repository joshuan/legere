import { Controller, Get, HttpCode, HttpStatus, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { UserDto } from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import {
  changePasswordRequestSchema,
  updateMeRequestSchema,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  type UpdateMeRequest,
} from '../../../shared/contracts/users';
import { ChangePassword } from '../../application/auth/change-password';
import { GetMe, UpdateMe } from '../../application/users/manage-me';
import type { Session } from '../../domain/entities/session';
import type { User } from '../../domain/entities/user';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentSession, CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { setLocaleCookie } from '../http/session-cookie';
import { Throttled } from '../http/throttling';
import { ZodBody } from '../http/zod-validation.pipe';

// Profile endpoints (docs/07 §7.3).
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly getMe: GetMe,
    private readonly updateMe: UpdateMe,
    private readonly changePassword: ChangePassword,
    private readonly config: AppConfig,
  ) {}

  @Get()
  me(@CurrentUser() user: User): Envelope<UserDto> {
    return successEnvelope(this.getMe.execute(user));
  }

  @Patch()
  async update(
    @CurrentUser() user: User,
    @ZodBody(updateMeRequestSchema) body: UpdateMeRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Envelope<UserDto>> {
    const updated = await this.updateMe.execute(user.id, body);
    // Keep SSR in step with the chosen language (docs/10 §10.3).
    setLocaleCookie(res, this.config, updated.language);
    return successEnvelope(updated);
  }

  // POST /api/me/password (docs/08 §8.1.6a). `@CurrentSession()` is what keeps this browser signed
  // in while every other session of the same user ends — and it is unreachable with an API token,
  // which is right: a read-only credential has no business rotating the password behind it.
  //
  // 🔒 Throttled against the caller, and the only reason this route has a budget of its own: it
  // verifies an Argon2 hash before it can fail, and that verification queues at the one concurrency
  // gate of two that login shares. Unbudgeted, one signed-in account filled that queue from a route
  // no throttler covered and nobody on the instance could sign in (docs/08 §8.4, SEC-54).
  @Post('password')
  @Throttled('password')
  @HttpCode(HttpStatus.OK)
  async password(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
    @ZodBody(changePasswordRequestSchema) body: ChangePasswordRequest,
  ): Promise<Envelope<ChangePasswordResponse>> {
    return successEnvelope(
      await this.changePassword.execute({
        userId: user.id,
        currentSessionId: session.id,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      }),
    );
  }
}
