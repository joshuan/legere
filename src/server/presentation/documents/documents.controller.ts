import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  listDocumentsQuerySchema,
  reprocessRequestSchema,
  updateDocumentRequestSchema,
  type DocumentDetailDto,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ReprocessRequest,
  type ReprocessResponse,
  type UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import type { OkResponse } from '../../../shared/contracts/users';
import type { User } from '../../domain/entities/user';
import {
  DeleteDocument,
  GetDocument,
  ListDocuments,
  UpdateDocumentMeta,
} from '../../application/documents/manage-documents';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';
import { CurrentDocument, DocumentAccessGuard } from './document-access.guard';

// Documents (docs/07 §7.3). Guard order: SessionGuard → RolesGuard → DocumentAccessGuard
// (docs/06 §6.4); the access guard loads the document once and hands it to the route.
@Controller('documents')
@UseGuards(SessionGuard, RolesGuard)
export class DocumentsController {
  constructor(
    private readonly list: ListDocuments,
    private readonly get: GetDocument,
    private readonly updateMeta: UpdateDocumentMeta,
    private readonly remove: DeleteDocument,
    private readonly reprocess: ReprocessDocument,
  ) {}

  @Get()
  async listDocuments(
    @CurrentUser() user: User,
    @ZodQuery(listDocumentsQuerySchema) query: ListDocumentsQuery,
  ): Promise<Envelope<ListDocumentsResponse>> {
    return successEnvelope(await this.list.execute(user, query));
  }

  @Get(':id')
  @UseGuards(DocumentAccessGuard)
  getDocument(@CurrentDocument() document: DocumentDetail): Envelope<DocumentDetailDto> {
    return successEnvelope(this.get.execute(document));
  }

  @Patch(':id')
  @UseGuards(DocumentAccessGuard)
  async patchDocument(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(updateDocumentRequestSchema) body: UpdateDocumentRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.updateMeta.execute(user, document, body));
  }

  @Delete(':id')
  @Roles('ADMIN')
  async deleteDocument(@Param('id', ParseUUIDPipe) id: string): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.remove.execute(id));
  }

  // Admin only: reprocessing costs OCR and provider calls, and it rewrites artifacts.
  @Post(':id/reprocess')
  @Roles('ADMIN')
  async reprocessDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(reprocessRequestSchema) body: ReprocessRequest,
  ): Promise<Envelope<ReprocessResponse>> {
    return successEnvelope(await this.reprocess.execute(id, body.steps));
  }
}
