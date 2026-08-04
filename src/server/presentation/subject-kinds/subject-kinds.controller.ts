import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  createSubjectKindRequestSchema,
  updateSubjectKindRequestSchema,
  type CreateSubjectKindRequest,
  type ListSubjectKindsResponse,
  type SubjectKindDto,
  type UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import type { Envelope } from '../../../shared/contracts/common';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  CreateSubjectKind,
  DeleteSubjectKind,
  ListSubjectKinds,
  UpdateSubjectKind,
} from '../../application/subject-kinds/manage-subject-kinds';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody } from '../http/zod-validation.pipe';

// Reading the catalogue and adding to it are open to anyone signed in, exactly as for people and
// subjects: the analysis adds a kind it meets, and whoever files a boat must not wait for an admin
// to invent "boat" (docs/03 §3.3.20a).
@Controller('subject-kinds')
@UseGuards(SessionGuard)
export class SubjectKindsController {
  constructor(
    private readonly list: ListSubjectKinds,
    private readonly createKind: CreateSubjectKind,
  ) {}

  @Get()
  async listKinds(): Promise<Envelope<ListSubjectKindsResponse>> {
    return successEnvelope(await this.list.execute());
  }

  @Post()
  async create(
    @ZodBody(createSubjectKindRequestSchema) body: CreateSubjectKindRequest,
  ): Promise<Envelope<SubjectKindDto>> {
    return successEnvelope(await this.createKind.execute(body));
  }
}

// Renaming reaches every thing filed under the kind, and removing is refused while any of them is
// alive — both are an admin's (docs/11 §11.12).
@Controller('admin/subject-kinds')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminSubjectKindsController {
  constructor(
    private readonly updateKind: UpdateSubjectKind,
    private readonly deleteKind: DeleteSubjectKind,
  ) {}

  @Patch(':id')
  async update(
    @UuidParam('id', 'SUBJECT_KIND_NOT_FOUND', 'Subject kind') id: string,
    @ZodBody(updateSubjectKindRequestSchema) body: UpdateSubjectKindRequest,
  ): Promise<Envelope<SubjectKindDto>> {
    return successEnvelope(await this.updateKind.execute(id, body));
  }

  @Delete(':id')
  async remove(
    @UuidParam('id', 'SUBJECT_KIND_NOT_FOUND', 'Subject kind') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.deleteKind.execute(id);
    return successEnvelope({ ok: true });
  }
}
