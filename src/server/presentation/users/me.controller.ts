import { Controller, Get, Patch, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { UserDto } from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import { updateMeRequestSchema, type UpdateMeRequest } from '../../../shared/contracts/users';
import { GetMe, UpdateMe } from '../../application/users/manage-me';
import type { User } from '../../domain/entities/user';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { setLocaleCookie } from '../http/session-cookie';
import { ZodBody } from '../http/zod-validation.pipe';

// Profile endpoints (docs/07 §7.3).
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly getMe: GetMe,
    private readonly updateMe: UpdateMe,
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
}
