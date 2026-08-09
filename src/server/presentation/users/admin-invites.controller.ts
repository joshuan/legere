import { Controller, Delete, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  createInviteRequestSchema,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type ListInvitesResponse,
  type OkResponse,
} from '../../../shared/contracts/users';
import { CreateInvite, ListInvites, RevokeInvite } from '../../application/users/manage-invites';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// Admin invite management (docs/07 §7.3). Guard order is SessionGuard → RolesGuard (docs/06 §6.4).
@Controller('admin/invites')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminInvitesController {
  constructor(
    private readonly createInvite: CreateInvite,
    private readonly listInvites: ListInvites,
    private readonly revokeInvite: RevokeInvite,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @ZodBody(createInviteRequestSchema) body: CreateInviteRequest,
    @CurrentUser() admin: User,
  ): Promise<Envelope<CreateInviteResponse>> {
    return successEnvelope(await this.createInvite.execute(body, admin.id));
  }

  @Get()
  async list(): Promise<Envelope<ListInvitesResponse>> {
    return successEnvelope(await this.listInvites.execute());
  }

  @Delete(':id')
  async revoke(
    @UuidParam('id', 'INVITE_NOT_FOUND', 'Invite') id: string,
    @CurrentUser() admin: User,
  ): Promise<Envelope<OkResponse>> {
    await this.revokeInvite.execute(id, admin.id);
    return successEnvelope({ ok: true });
  }
}
