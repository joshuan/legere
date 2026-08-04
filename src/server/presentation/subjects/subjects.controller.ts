import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  createSubjectRequestSchema,
  updateSubjectRequestSchema,
  type CreateSubjectRequest,
  type ListSubjectsResponse,
  type SubjectDto,
  type UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import type { Envelope } from '../../../shared/contracts/common';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  CreateSubject,
  DeleteSubject,
  ListSubjects,
  UpdateSubject,
} from '../../application/subjects/manage-subjects';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody } from '../http/zod-validation.pipe';

// Reading the catalogue and adding to it are open to anyone signed in: the analyst adds names on its
// own, and whoever corrects it must be able to add the one it missed without waiting for an admin
// (docs/03 §3.3.19).
@Controller('subjects')
@UseGuards(SessionGuard)
export class SubjectsController {
  constructor(
    private readonly list: ListSubjects,
    private readonly createSubject: CreateSubject,
  ) {}

  @Get()
  async listSubjects(): Promise<Envelope<ListSubjectsResponse>> {
    return successEnvelope(await this.list.execute());
  }

  @Post()
  async create(
    @ZodBody(createSubjectRequestSchema) body: CreateSubjectRequest,
  ): Promise<Envelope<SubjectDto>> {
    return successEnvelope(await this.createSubject.execute(body));
  }
}

// Renaming and removing reach across every document that names the subject, so they are an admin's
// (docs/11 §11.13).
@Controller('admin/subjects')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminSubjectsController {
  constructor(
    private readonly updateSubject: UpdateSubject,
    private readonly deleteSubject: DeleteSubject,
  ) {}

  @Patch(':id')
  async update(
    @UuidParam('id', 'SUBJECT_NOT_FOUND', 'Subject') id: string,
    @ZodBody(updateSubjectRequestSchema) body: UpdateSubjectRequest,
  ): Promise<Envelope<SubjectDto>> {
    return successEnvelope(await this.updateSubject.execute(id, body));
  }

  @Delete(':id')
  async remove(
    @UuidParam('id', 'SUBJECT_NOT_FOUND', 'Subject') id: string,
  ): Promise<Envelope<OkResponse>> {
    await this.deleteSubject.execute(id);
    return successEnvelope({ ok: true });
  }
}
