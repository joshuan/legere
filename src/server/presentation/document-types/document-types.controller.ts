import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  createCategoryRequestSchema,
  updateCategoryRequestSchema,
  type DocumentTypeDto,
  type CreateDocumentTypeRequest,
  type ListDocumentTypesResponse,
  type UpdateDocumentTypeRequest,
} from '../../../shared/contracts/document-types';
import type { Envelope } from '../../../shared/contracts/common';
import {
  CreateDocumentType,
  DeleteDocumentType,
  ListDocumentTypes,
  UpdateDocumentType,
} from '../../application/document-types/manage-document-types';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// GET /api/document-types (docs/07 §7.3): every signed-in user reads the reference list — it is what the
// filters and the documentType picker are built from.
@Controller('document-types')
@UseGuards(SessionGuard)
export class DocumentTypesController {
  constructor(private readonly list: ListDocumentTypes) {}

  @Get()
  async listCategories(): Promise<Envelope<ListDocumentTypesResponse>> {
    return successEnvelope(await this.list.execute());
  }
}

// Managing the list is an admin's job (docs/11 §11.12).
@Controller('admin/document-types')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminDocumentTypesController {
  constructor(
    private readonly create: CreateDocumentType,
    private readonly update: UpdateDocumentType,
    private readonly remove: DeleteDocumentType,
  ) {}

  @Post()
  async createCategory(
    @ZodBody(createCategoryRequestSchema) body: CreateDocumentTypeRequest,
  ): Promise<Envelope<DocumentTypeDto>> {
    return successEnvelope(await this.create.execute(body));
  }

  @Patch(':id')
  async updateCategory(
    @UuidParam('id', 'DOCUMENT_TYPE_NOT_FOUND', 'DocumentType') id: string,
    @ZodBody(updateCategoryRequestSchema) body: UpdateDocumentTypeRequest,
  ): Promise<Envelope<DocumentTypeDto>> {
    return successEnvelope(await this.update.execute(id, body));
  }

  @Delete(':id')
  async deleteCategory(
    @UuidParam('id', 'DOCUMENT_TYPE_NOT_FOUND', 'DocumentType') id: string,
  ): Promise<Envelope<{ ok: true; documentsReset: number }>> {
    return successEnvelope(await this.remove.execute(id));
  }
}
