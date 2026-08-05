import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  paginationQuerySchema,
  type Envelope,
  type PaginationQuery,
} from '../../../shared/contracts/common';
import {
  listDocumentsQuerySchema,
  reprocessRequestSchema,
  updateDocumentRequestSchema,
  type DocumentDetailDto,
  type DocumentEventPage,
  type DocumentYearsResponse,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ReprocessRequest,
  type ReprocessResponse,
  type UpdateDocumentRequest,
  type UploadDocumentResponse,
  DocumentMarkdownResponse,
} from '../../../shared/contracts/documents';
import {
  combineDocumentsRequestSchema,
  reorderDocumentFilesRequestSchema,
  updateDocumentFileRequestSchema,
  type CombineDocumentsRequest,
  type CropSuggestionResponse,
  type GroupingSuggestionsResponse,
  type ReorderDocumentFilesRequest,
  type SplitDocumentFileResponse,
  type UpdateDocumentFileRequest,
} from '../../../shared/contracts/files';
import type { OkResponse } from '../../../shared/contracts/users';
import type { User } from '../../domain/entities/user';
import {
  DeleteDocument,
  GetDocument,
  ListDocumentEvents,
  ListDocumentYears,
  ListDocuments,
  UpdateDocumentMeta,
} from '../../application/documents/manage-documents';
import {
  AddDocumentFile,
  CombineDocuments,
  ReorderDocumentFiles,
  SetDocumentFileCrop,
  SplitDocumentFile,
  SuggestDocumentFileCrop,
} from '../../application/documents/compose-document';
import {
  DownloadDocumentCanonical,
  DownloadDocumentFile,
  GetDocumentArtifactUrl,
  GetDocumentMarkdown,
  type ArtifactKind,
  type Download,
} from '../../application/documents/download-document';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import { SuggestGroupings } from '../../application/documents/suggest-groupings';
import { UploadDocument } from '../../application/documents/upload-document';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';
import { CurrentDocument, DocumentAccessGuard } from './document-access.guard';
import { attachedFileName, readUploadBody, uploadFileName } from './read-upload-body';

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
    private readonly events: ListDocumentEvents,
    private readonly years: ListDocumentYears,
    private readonly canonical: DownloadDocumentCanonical,
    private readonly fileContent: DownloadDocumentFile,
    private readonly artifactUrl: GetDocumentArtifactUrl,
    private readonly markdown: GetDocumentMarkdown,
    private readonly upload: UploadDocument,
    private readonly addFile: AddDocumentFile,
    private readonly reorderFiles: ReorderDocumentFiles,
    private readonly setCrop: SetDocumentFileCrop,
    private readonly suggestCrop: SuggestDocumentFileCrop,
    private readonly splitFile: SplitDocumentFile,
    private readonly combine: CombineDocuments,
    private readonly groupings: SuggestGroupings,
    private readonly config: AppConfig,
  ) {}

  // The file itself is the body; its name rides in a header (docs/07 §7.3). No multipart, no new
  // dependency, and nothing is buffered before the size has been checked.
  @Post()
  @HttpCode(201)
  async uploadDocument(
    @CurrentUser() user: User,
    @Req() req: Request,
  ): Promise<Envelope<UploadDocumentResponse>> {
    const fileName = uploadFileName(req);
    const bytes = await readUploadBody(req, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(await this.upload.execute(user, { bytes, fileName }));
  }

  @Get()
  async listDocuments(
    @CurrentUser() user: User,
    @ZodQuery(listDocumentsQuerySchema) query: ListDocumentsQuery,
  ): Promise<Envelope<ListDocumentsResponse>> {
    return successEnvelope(await this.list.execute(user, query));
  }

  // The years documents carry, for browsing by date (docs/11 §11.4). Before `:id`, or the router
  // would read "years" as a document id.
  @Get('years')
  async getYears(@CurrentUser() user: User): Promise<Envelope<DocumentYearsResponse>> {
    return successEnvelope(await this.years.execute({ id: user.id, role: user.role }));
  }

  // "These look like one document" (docs/05 §5.6a): computed on every request, never stored. Before
  // `:id` for the same reason as the years.
  @Get('grouping-suggestions')
  async getGroupingSuggestions(
    @CurrentUser() user: User,
  ): Promise<Envelope<GroupingSuggestionsResponse>> {
    return successEnvelope(await this.groupings.execute({ id: user.id, role: user.role }));
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
  async deleteDocument(
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.remove.execute(id));
  }

  @Get(':id/markdown')
  @UseGuards(DocumentAccessGuard)
  getMarkdown(@CurrentDocument() document: DocumentDetail): Envelope<DocumentMarkdownResponse> {
    return successEnvelope(this.markdown.execute(document));
  }

  // The document's history (docs/03 §3.3.18). Guarded like the document itself: whoever may read a
  // document may read how it came to be what it is.
  @Get(':id/events')
  @UseGuards(DocumentAccessGuard)
  async getEvents(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodQuery(paginationQuerySchema) query: PaginationQuery,
  ): Promise<Envelope<DocumentEventPage>> {
    return successEnvelope(
      await this.events.execute(document.document.id, {
        limit: query.limit,
        cursor: query.cursor,
        // The host a step ran against is operational detail: it names a container on an internal
        // network, and only the person who administers it has any use for it (docs/03 §3.3.18).
        withEndpoints: user.role === 'ADMIN',
      }),
    );
  }

  // --- what the document is made of (docs/07 §7.3, docs/05 §5.6) -------------------------------

  // The file is the body, its name in a header, and it is appended last. Every composition route
  // answers with the whole document: a change to one file is never local to it.
  @Post(':id/files')
  @UseGuards(DocumentAccessGuard)
  async postFile(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @Req() req: Request,
  ): Promise<Envelope<DocumentDetailDto>> {
    const fileName = attachedFileName(req);
    const bytes = await readUploadBody(req, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(await this.addFile.execute(user, document, { bytes, fileName }));
  }

  @Patch(':id/files')
  @UseGuards(DocumentAccessGuard)
  async patchFiles(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(reorderDocumentFilesRequestSchema) body: ReorderDocumentFilesRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.reorderFiles.execute(user, document, body));
  }

  @Patch(':id/files/:fileId')
  @UseGuards(DocumentAccessGuard)
  async patchFile(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @ZodBody(updateDocumentFileRequestSchema) body: UpdateDocumentFileRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.setCrop.execute(user, document, fileId, body));
  }

  // The file leaves and becomes a document of its own — never nothing (docs/05 §5.6).
  @Delete(':id/files/:fileId')
  @UseGuards(DocumentAccessGuard)
  async deleteFile(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
  ): Promise<Envelope<SplitDocumentFileResponse>> {
    return successEnvelope(await this.splitFile.execute(user, document, fileId));
  }

  // A proposal, not a change: nothing is stored until the client saves it (docs/05 §5.6).
  @Get(':id/files/:fileId/crop-suggestion')
  @UseGuards(DocumentAccessGuard)
  async getCropSuggestion(
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
  ): Promise<Envelope<CropSuggestionResponse>> {
    return successEnvelope(await this.suggestCrop.execute(document, fileId));
  }

  // One original, exactly as it arrived: streamed from the volume, or a signed URL for a managed
  // file (docs/09 §9.1–9.2).
  @Get(':id/files/:fileId/content')
  @UseGuards(DocumentAccessGuard)
  async getFileContent(
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    send(res, await this.fileContent.execute(document, fileId), 'attachment');
  }

  // An update rather than a creation: nothing new appears, several documents become one
  // (docs/07 §7.1).
  @Post(':id/combine')
  @HttpCode(200)
  @UseGuards(DocumentAccessGuard)
  async postCombine(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(combineDocumentsRequestSchema) body: CombineDocumentsRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.combine.execute(user, document, body));
  }

  // --- what a document looks like (docs/09 §9.2) -----------------------------------------------

  @Get(':id/preview')
  @UseGuards(DocumentAccessGuard)
  getPreview(@CurrentDocument() document: DocumentDetail, @Res() res: Response): Promise<void> {
    return this.sendArtifact(document, 'preview', res);
  }

  @Get(':id/thumb')
  @UseGuards(DocumentAccessGuard)
  getThumb(@CurrentDocument() document: DocumentDetail, @Res() res: Response): Promise<void> {
    return this.sendArtifact(document, 'thumb', res);
  }

  // The document itself, as one PDF (docs/05 §5.5): read inline in the viewer, saved under the
  // document's own title when `?download=1` (docs/11 §11.5b).
  @Get(':id/canonical')
  @UseGuards(DocumentAccessGuard)
  async getCanonical(
    @CurrentDocument() document: DocumentDetail,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const asAttachment = download === '1' || download === 'true';
    send(res, await this.canonical.execute(document, asAttachment), 'attachment');
  }

  private async sendArtifact(
    document: DocumentDetail,
    kind: ArtifactKind,
    res: Response,
  ): Promise<void> {
    // Viewed rather than saved: these are what an <img> or <embed> on the page points at.
    send(res, await this.artifactUrl.execute(document, kind), 'inline');
  }

  // Admin only: reprocessing costs OCR and provider calls, and it rewrites artifacts.
  @Post(':id/reprocess')
  @Roles('ADMIN')
  async reprocessDocument(
    @CurrentUser() user: User,
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
    @ZodBody(reprocessRequestSchema) body: ReprocessRequest,
  ): Promise<Envelope<ReprocessResponse>> {
    return successEnvelope(await this.reprocess.execute(id, body.steps, user.id));
  }
}

// A 302 to a signed URL, or the bytes themselves. The signed URL is short-lived and never published
// as a permanent link (docs/08 §8.5), which is why the API redirects instead of returning it.
function send(res: Response, download: Download, disposition: 'attachment' | 'inline'): void {
  if (download.kind === 'redirect') {
    res.redirect(302, download.url);
    return;
  }

  res.setHeader('Content-Type', download.contentType);
  // Absent for the canonical PDF: only the bucket knows how big it is, and asking would cost a round
  // trip to save the client a progress bar.
  if (download.contentLength !== undefined) {
    res.setHeader('Content-Length', download.contentLength.toString());
  }
  res.setHeader('Content-Disposition', contentDisposition(disposition, download.fileName));
  // 🔒 A library file is user content served from our own origin: nothing here may be sniffed into
  // something the browser decides to execute.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Backpressure comes from pipe (docs/09 §9.1); a read error after the headers are out can only be
  // signalled by dropping the connection.
  download.body.on('error', () => res.destroy());
  download.body.pipe(res);
}

// RFC 5987: a plain ASCII fallback plus the real name, so a Cyrillic title survives the trip.
function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
