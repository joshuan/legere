import { Controller, Delete, Get, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  createApiTokenRequestSchema,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type OkResponse,
} from '../../../shared/contracts/users';
import {
  CreateApiToken,
  ListApiTokens,
  RevokeApiToken,
} from '../../application/users/manage-api-tokens';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody } from '../http/zod-validation.pipe';

// A user's own read-only API tokens (docs/07 §7.3, docs/08 §8.2a). Issuing and revoking are
// mutations, so these routes are reachable with a session only — a token cannot beget a token.
@Controller('me/api-tokens')
@UseGuards(SessionGuard)
export class MeApiTokensController {
  constructor(
    private readonly list: ListApiTokens,
    private readonly create: CreateApiToken,
    private readonly revoke: RevokeApiToken,
  ) {}

  @Get()
  async listTokens(@CurrentUser() user: User): Promise<Envelope<ListApiTokensResponse>> {
    return successEnvelope(await this.list.execute(user.id));
  }

  @Post()
  async createToken(
    @CurrentUser() user: User,
    @ZodBody(createApiTokenRequestSchema) body: CreateApiTokenRequest,
  ): Promise<Envelope<CreateApiTokenResponse>> {
    return successEnvelope(await this.create.execute(user.id, body));
  }

  @Delete(':id')
  async revokeToken(
    @CurrentUser() user: User,
    @UuidParam('id', 'API_TOKEN_NOT_FOUND', 'API token') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.revoke.execute(user.id, id);
    return successEnvelope({ ok: true });
  }
}
