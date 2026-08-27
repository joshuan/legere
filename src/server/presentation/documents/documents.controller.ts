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
  createDocumentLinkRequestSchema,
  listDocumentGroupsQuerySchema,
  listDocumentsQuerySchema,
  reprocessRequestSchema,
  updateDocumentRequestSchema,
  type CreateDocumentLinkRequest,
  type DocumentDetailDto,
  type DocumentEventPage,
  type DocumentGroupsResponse,
  type DocumentLinkDto,
  type DocumentLinkSuggestionsResponse,
  type DocumentLinksResponse,
  type DocumentYearsResponse,
  type ListDocumentGroupsQuery,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type ReprocessRequest,
  type ReprocessResponse,
  type UpdateDocumentRequest,
  type UploadDocumentResponse,
  DocumentMarkdownResponse,
} from '../../../shared/contracts/documents';
import {
  addDocumentFileQuerySchema,
  combineDocumentsRequestSchema,
  moveDocumentPagesRequestSchema,
  reorderDocumentFilesRequestSchema,
  reorderDocumentPagesRequestSchema,
  splitDocumentRequestSchema,
  updateDocumentFileRequestSchema,
  updateDocumentPageRequestSchema,
  type AddDocumentFileQuery,
  type CombineDocumentsRequest,
  type CropSuggestionResponse,
  type GroupingSuggestionsResponse,
  type MoveDocumentPagesRequest,
  type MoveDocumentPagesResponse,
  type ReorderDocumentFilesRequest,
  type ReorderDocumentPagesRequest,
  type SplitDocumentFileResponse,
  type SplitDocumentRequest,
  type SplitDocumentResponse,
  type UpdateDocumentFileRequest,
  type UpdateDocumentPageRequest,
} from '../../../shared/contracts/files';
import type { OkResponse } from '../../../shared/contracts/users';
import type { User } from '../../domain/entities/user';
import {
  DeleteDocument,
  GetDocument,
  ListDocumentEvents,
  ListDocumentGroups,
  ListDocumentYears,
  ListDocuments,
  UpdateDocumentMeta,
} from '../../application/documents/manage-documents';
import {
  AddDocumentFile,
  CombineDocuments,
  ReorderDocumentFiles,
  ReplaceDocumentFile,
  SplitDocumentFile,
  SuggestDocumentFileCrop,
  UpdateDocumentFile,
} from '../../application/documents/compose-document';
import {
  MoveDocumentPages,
  RemoveDocumentPage,
  ReorderDocumentPages,
  SplitDocumentAtPages,
  UpdateDocumentPage,
} from '../../application/documents/arrange-pages';
import {
  DownloadDocumentCanonical,
  DownloadDocumentFile,
  GetDocumentArtifactUrl,
  GetDocumentFilePageThumb,
  GetDocumentMarkdown,
  type ArtifactKind,
} from '../../application/documents/download-document';
import {
  CreateDocumentLink,
  DeleteDocumentLink,
  ListDocumentLinks,
  SuggestDocumentLinks,
} from '../../application/documents/document-links';
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
import { PageIndexParam } from '../http/page-index-param.pipe';
import { UuidParam } from '../http/uuid-param.pipe';
import { sendDownload } from '../http/send-download';
import { CurrentDocument, DocumentAccessGuard } from './document-access.guard';
import { attachedFileName, readUploadBody, uploadFileName } from './read-upload-body';

// 🔒 A step and the status it sits in are one filter, not two (docs/07 §7.3): `?step=preview` alone
// would answer with every document and still look like a filtered list, which is the kind of wrong
// answer nobody notices. The pairing lives here rather than in the shared contract, because the
// contract is the shape both sides send and this is a rule about a request.
function stepAndStatusTogether(query: { step?: unknown; stepStatus?: unknown }): boolean {
  return (query.step === undefined) === (query.stepStatus === undefined);
}

const PAIR_STEP = { message: 'step and stepStatus must be given together' };

const listDocumentsQuery = listDocumentsQuerySchema.refine(stepAndStatusTogether, PAIR_STEP);

// The grouping takes the same filters as the list, so it takes the same rule about them: a count
// under half a filter would be a wrong number that looks like a right one.
const listDocumentGroupsQuery = listDocumentGroupsQuerySchema.refine(
  stepAndStatusTogether,
  PAIR_STEP,
);

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
    private readonly groups: ListDocumentGroups,
    private readonly canonical: DownloadDocumentCanonical,
    private readonly fileContent: DownloadDocumentFile,
    private readonly artifactUrl: GetDocumentArtifactUrl,
    private readonly markdown: GetDocumentMarkdown,
    private readonly upload: UploadDocument,
    private readonly addFile: AddDocumentFile,
    private readonly reorderFiles: ReorderDocumentFiles,
    private readonly reorderPages: ReorderDocumentPages,
    private readonly updatePage: UpdateDocumentPage,
    private readonly removePage: RemoveDocumentPage,
    private readonly splitAtPages: SplitDocumentAtPages,
    private readonly movePages: MoveDocumentPages,
    private readonly updateFile: UpdateDocumentFile,
    private readonly suggestCrop: SuggestDocumentFileCrop,
    private readonly pageThumb: GetDocumentFilePageThumb,
    private readonly replaceFile: ReplaceDocumentFile,
    private readonly splitFile: SplitDocumentFile,
    private readonly combine: CombineDocuments,
    private readonly groupings: SuggestGroupings,
    private readonly documentLinks: ListDocumentLinks,
    private readonly createLinkTo: CreateDocumentLink,
    private readonly deleteLinkTo: DeleteDocumentLink,
    private readonly suggestLinks: SuggestDocumentLinks,
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
    @ZodQuery(listDocumentsQuery) query: ListDocumentsQuery,
  ): Promise<Envelope<ListDocumentsResponse>> {
    return successEnvelope(await this.list.execute(user, query));
  }

  // The years documents carry, for browsing by date (docs/11 §11.4). Before `:id`, or the router
  // would read "years" as a document id.
  @Get('years')
  async getYears(@CurrentUser() user: User): Promise<Envelope<DocumentYearsResponse>> {
    return successEnvelope(await this.years.execute({ id: user.id, role: user.role }));
  }

  // The shelves of one dimension under the filters in force (docs/07 §7.3, docs/11 §11.3): an
  // aggregate, so a bounded `{ items }` rather than a page — a group's contents are the ordinary
  // list filtered by that group's key. Before `:id`, like the years.
  @Get('groups')
  async getGroups(
    @CurrentUser() user: User,
    @ZodQuery(listDocumentGroupsQuery) query: ListDocumentGroupsQuery,
  ): Promise<Envelope<DocumentGroupsResponse>> {
    return successEnvelope(await this.groups.execute({ id: user.id, role: user.role }, query));
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
  getDocument(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
  ): Envelope<DocumentDetailDto> {
    return successEnvelope(this.get.execute(user, document));
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

  // The edges of this document (docs/03 §3.3.23, docs/07 §7.3): both ends list the same edge, and
  // 🔒 one whose other side the caller may not read is absent from the answer entirely.
  @Get(':id/links')
  @UseGuards(DocumentAccessGuard)
  async getLinks(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
  ): Promise<Envelope<DocumentLinksResponse>> {
    return successEnvelope(await this.documentLinks.execute(user, document));
  }

  @Post(':id/links')
  @UseGuards(DocumentAccessGuard)
  async createLink(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(createDocumentLinkRequestSchema) body: CreateDocumentLinkRequest,
  ): Promise<Envelope<DocumentLinkDto>> {
    return successEnvelope(await this.createLinkTo.execute(user, document, body.documentId));
  }

  @Delete(':id/links/:documentId')
  @UseGuards(DocumentAccessGuard)
  async deleteLink(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('documentId', 'DOCUMENT_NOT_FOUND', 'Document') otherId: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.deleteLinkTo.execute(user, document, otherId));
  }

  // Candidates the archive found by the identifiers the documents share (docs/05 §5.6b). Computed
  // on request, stored never; dismissing one is the client's business.
  @Get(':id/link-suggestions')
  @UseGuards(DocumentAccessGuard)
  async getLinkSuggestions(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
  ): Promise<Envelope<DocumentLinkSuggestionsResponse>> {
    return successEnvelope(await this.suggestLinks.execute(user, document));
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
      await this.events.execute(user, document.document.id, {
        limit: query.limit,
        cursor: query.cursor,
        // An entry is written whole and read redacted: the host a step ran against names a container
        // on an internal network, and the path of a library file may name a folder in a library this
        // reader cannot open. Only the person who administers the instance has use for either, and
        // is the only one who could have seen them anyway (docs/03 §3.3.18, docs/08 §8.5).
        asAdmin: user.role === 'ADMIN',
      }),
    );
  }

  // --- what the document is made of (docs/07 §7.3, docs/05 §5.6) -------------------------------

  // The file is the body, its name in a header, and its pages go where `?at=` says — after the last
  // page of the document when it says nothing, which is what an append always was. Every composition
  // route answers with the whole document: a change to one page is never local to it.
  @Post(':id/files')
  @UseGuards(DocumentAccessGuard)
  async postFile(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodQuery(addDocumentFileQuerySchema) query: AddDocumentFileQuery,
    @Req() req: Request,
  ): Promise<Envelope<DocumentDetailDto>> {
    const fileName = attachedFileName(req);
    const bytes = await readUploadBody(req, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(
      await this.addFile.execute(user, document, { bytes, fileName }, query.at),
    );
  }

  // --- the pages themselves (docs/07 §7.3, docs/05 §5.6, ADR-025) ------------------------------

  // The whole order, every page of this document exactly once: one request and one truth, which is
  // also the only shape a reorder cannot be half applied in.
  @Patch(':id/pages')
  @UseGuards(DocumentAccessGuard)
  async patchPages(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(reorderDocumentPagesRequestSchema) body: ReorderDocumentPagesRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.reorderPages.execute(user, document, body));
  }

  // How one page lies and how much of it is paper (docs/03 §3.3.17). A crop is taken on any page —
  // the build renders and warps a page of a PDF exactly as it warps a photograph — and only the
  // mirror is an image's own.
  @Patch(':id/pages/:pageId')
  @UseGuards(DocumentAccessGuard)
  async patchPage(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('pageId', 'PAGE_NOT_FOUND', 'Page') pageId: string,
    @ZodBody(updateDocumentPageRequestSchema) body: UpdateDocumentPageRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.updatePage.execute(user, document, pageId, body));
  }

  // The pages that belong elsewhere go there — an existing document at a chosen position, or a new
  // one made to hold them. 🔒 Refused whole when the caller may not edit the other end.
  @Post(':id/pages/move')
  @HttpCode(200)
  @UseGuards(DocumentAccessGuard)
  async postPagesMove(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(moveDocumentPagesRequestSchema) body: MoveDocumentPagesRequest,
  ): Promise<Envelope<MoveDocumentPagesResponse>> {
    return successEnvelope(await this.movePages.execute(user, document, body));
  }

  // One page leaves and the rest close up behind it; the file goes to the trash only if nothing
  // anywhere still reads a page of it (docs/05 §5.7a).
  @Delete(':id/pages/:pageId')
  @UseGuards(DocumentAccessGuard)
  async deletePage(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('pageId', 'PAGE_NOT_FOUND', 'Page') pageId: string,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.removePage.execute(user, document, pageId));
  }

  // The scan whose eighth page begins another contract becomes two documents and no new bytes
  // (docs/05 §5.6): the entries divide, the parts are linked, and every one of them rebuilds.
  @Post(':id/split')
  @HttpCode(200)
  @UseGuards(DocumentAccessGuard)
  async postSplit(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @ZodBody(splitDocumentRequestSchema) body: SplitDocumentRequest,
  ): Promise<Envelope<SplitDocumentResponse>> {
    return successEnvelope(await this.splitAtPages.execute(user, document, body));
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

  // What one file says about itself: the crop of its content, the order of its own pages, or both
  // in one edit — and one rebuild either way (docs/07 §7.3).
  @Patch(':id/files/:fileId')
  @UseGuards(DocumentAccessGuard)
  async patchFile(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @ZodBody(updateDocumentFileRequestSchema) body: UpdateDocumentFileRequest,
  ): Promise<Envelope<DocumentDetailDto>> {
    return successEnvelope(await this.updateFile.execute(user, document, fileId, body));
  }

  // A better copy of one page, in the same place: the body is the file, exactly as for the append
  // above, and what it replaces goes to the trash (docs/05 §5.6, §5.7a).
  @Post(':id/files/:fileId/replacement')
  @HttpCode(200)
  @UseGuards(DocumentAccessGuard)
  async postReplacement(
    @CurrentUser() user: User,
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @Req() req: Request,
  ): Promise<Envelope<DocumentDetailDto>> {
    const fileName = attachedFileName(req);
    const bytes = await readUploadBody(req, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(
      await this.replaceFile.execute(user, document, fileId, { bytes, fileName }),
    );
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
    sendDownload(res, await this.fileContent.execute(document, fileId));
  }

  // One page of one original, small (docs/07 §7.3, docs/09 §9.2). 🔒 Guarded exactly as the file's
  // own content is, because it is the same bytes: whoever may read the document may look at its
  // pages, and nobody else may.
  @Get(':id/files/:fileId/pages/:page/thumb')
  @UseGuards(DocumentAccessGuard)
  async getFilePageThumb(
    @CurrentDocument() document: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @PageIndexParam('page') page: number,
    @Res() res: Response,
  ): Promise<void> {
    sendDownload(res, await this.pageThumb.execute(document, fileId, page));
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
    sendDownload(res, await this.canonical.execute(document, asAttachment));
  }

  private async sendArtifact(
    document: DocumentDetail,
    kind: ArtifactKind,
    res: Response,
  ): Promise<void> {
    // Viewed rather than saved: these are what an <img> on the page points at, and the use case says
    // so on the download it returns.
    sendDownload(res, await this.artifactUrl.execute(document, kind));
  }

  // Admin only: reprocessing costs OCR and provider calls, and it rewrites artifacts.
  @Post(':id/reprocess')
  @Roles('ADMIN')
  async reprocessDocument(
    @CurrentUser() user: User,
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
    @ZodBody(reprocessRequestSchema) body: ReprocessRequest,
  ): Promise<Envelope<ReprocessResponse>> {
    return successEnvelope(
      await this.reprocess.execute(id, body.steps, user.id, body.analyseInFull ?? false),
    );
  }
}

// A 302 to a signed URL, or the bytes themselves. The signed URL is short-lived and never published
// as a permanent link (docs/08 §8.5), which is why the API redirects instead of returning it.
