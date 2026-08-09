import { Controller, Delete, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { Envelope } from '../../../shared/contracts/common';
import type { ListSessionsResponse, OkResponse } from '../../../shared/contracts/users';
import { ListMySessions, RevokeMySession } from '../../application/users/manage-sessions';
import type { Session } from '../../domain/entities/session';
import type { User } from '../../domain/entities/user';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentSession, CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { clearSessionCookie } from '../http/session-cookie';
import { UuidParam } from '../http/uuid-param.pipe';

// A user's own sessions (docs/07 §7.3, docs/08 §8.2). Both routes need `@CurrentSession()`, which
// is unreachable with an API token — listing is a read, but "which one is current" is a question
// only a session can answer, and revoking is a mutation a bearer credential never reaches.
@Controller('me/sessions')
@UseGuards(SessionGuard)
export class MeSessionsController {
  constructor(
    private readonly list: ListMySessions,
    private readonly revoke: RevokeMySession,
    private readonly config: AppConfig,
  ) {}

  @Get()
  async listSessions(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
  ): Promise<Envelope<ListSessionsResponse>> {
    return successEnvelope(await this.list.execute(user.id, session.id));
  }

  @Delete(':id')
  async revokeSession(
    @CurrentUser() user: User,
    @CurrentSession() session: Session,
    @UuidParam('id', 'SESSION_NOT_FOUND', 'Session') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Envelope<OkResponse>> {
    await this.revoke.execute(user.id, id);
    // Signing this device out from the list is allowed; the cookie goes with it, so the browser is
    // not left holding a credential the server has already killed.
    if (id === session.id) clearSessionCookie(res, this.config);
    return successEnvelope({ ok: true });
  }
}
