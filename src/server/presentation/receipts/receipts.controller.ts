import {
  ReadReceiptDuplicates,
  ResolveReceiptDuplicates,
} from '../../application/receipts/review-receipt-duplicates';
import {
  receiptDuplicateQuerySchema,
  receiptPairQuerySchema,
  resolveReceiptPairSchema,
  type ReceiptDuplicateQuery,
  type ReceiptPairQuery,
  type ResolveReceiptPair,
} from '../../../shared/contracts/receipt-duplicates';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { type Envelope } from '../../../shared/contracts/common';
import type {
  ListReceiptsQuery,
  ListReceiptsResponse,
  ReceiptArtifactUrl,
  ReceiptDetailDto,
  UploadReceiptResponse,
  UploadReceiptFields,
} from '../../../shared/contracts/receipts';
import {
  listReceiptsQuerySchema,
  uploadReceiptFieldsSchema,
} from '../../../shared/contracts/receipts';
import type { User } from '../../domain/entities/user';
import {
  DeleteReceipt,
  GetReceipt,
  GetReceiptArtifactUrl,
  ListReceipts,
} from '../../application/receipts/manage-receipts';
import { UploadReceipt } from '../../application/receipts/upload-receipt';
import { CurrentUser } from '../auth/current-user';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ValidationFailedError } from '../../domain/errors/domain-error';
import { PageIndexParam } from '../http/page-index-param.pipe';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';

type MultipartReceiptFile = {
  buffer: Buffer;
  originalname: string;
};

@Controller('receipts')
@UseGuards(SessionGuard, RolesGuard)
export class ReceiptsController {
  constructor(
    private readonly list: ListReceipts,
    private readonly get: GetReceipt,
    private readonly upload: UploadReceipt,
    private readonly remove: DeleteReceipt,
    private readonly artifacts: GetReceiptArtifactUrl,
    private readonly duplicateReader: ReadReceiptDuplicates,
    private readonly duplicateResolver: ResolveReceiptDuplicates,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  async uploadReceipt(
    @CurrentUser() user: User,
    @UploadedFile() file: MultipartReceiptFile | undefined,
    @ZodBody(uploadReceiptFieldsSchema) fields: UploadReceiptFields,
  ): Promise<Envelope<UploadReceiptResponse>> {
    if (file === undefined) throw new ValidationFailedError({ file: ['A file is required'] });
    return successEnvelope(
      await this.upload.execute(user, {
        fileName: file.originalname,
        bytes: file.buffer,
        ...(fields.text === undefined ? {} : { sourceText: fields.text }),
      }),
    );
  }

  @Get()
  async listReceipts(
    @CurrentUser() user: User,
    @ZodQuery(listReceiptsQuerySchema) query: ListReceiptsQuery,
  ): Promise<Envelope<ListReceiptsResponse>> {
    return successEnvelope(await this.list.execute(user, query));
  }

  @Get('duplicates')
  async duplicates(
    @CurrentUser() user: User,
    @ZodQuery(receiptDuplicateQuerySchema) query: ReceiptDuplicateQuery,
  ) {
    return successEnvelope(await this.duplicateReader.list(user, query.cursor));
  }

  @Get('duplicates/compare')
  async compareDuplicates(
    @CurrentUser() user: User,
    @ZodQuery(receiptPairQuerySchema) query: ReceiptPairQuery,
  ) {
    return successEnvelope(await this.duplicateReader.compare(user, query));
  }

  @Post('duplicates/resolve')
  @HttpCode(200)
  async resolveDuplicates(
    @CurrentUser() user: User,
    @ZodBody(resolveReceiptPairSchema) body: ResolveReceiptPair,
  ) {
    return successEnvelope(await this.duplicateResolver.execute(user, body));
  }

  @Get('duplicates/history')
  async duplicateHistory(
    @CurrentUser() user: User,
    @ZodQuery(receiptDuplicateQuerySchema) query: ReceiptDuplicateQuery,
  ) {
    return successEnvelope(await this.duplicateReader.history(user, query));
  }

  @Post('duplicates/history/:id/undo')
  @HttpCode(200)
  async undoDuplicateDecision(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt review') id: string,
  ) {
    return successEnvelope(await this.duplicateResolver.undo(user, id));
  }

  @Get('duplicates/history/:id/originals/:side')
  async duplicateOriginal(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt review') id: string,
    @PageIndexParam('side') side: number,
  ) {
    return successEnvelope(await this.duplicateReader.original(user, id, side));
  }

  @Get(':id')
  async getReceipt(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
  ): Promise<Envelope<ReceiptDetailDto>> {
    return successEnvelope(await this.get.execute(user, id));
  }

  @Get(':id/original')
  async getOriginal(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
  ): Promise<Envelope<ReceiptArtifactUrl>> {
    return successEnvelope(await this.artifacts.original(user, id, false));
  }

  @Get(':id/download')
  async downloadOriginal(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
  ): Promise<Envelope<ReceiptArtifactUrl>> {
    return successEnvelope(await this.artifacts.original(user, id, true));
  }

  @Get(':id/thumbnail')
  async getThumbnail(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
  ): Promise<Envelope<ReceiptArtifactUrl>> {
    return successEnvelope(await this.artifacts.thumbnail(user, id));
  }

  @Get(':id/pages/:page')
  async getPage(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
    @PageIndexParam('page') page: number,
  ): Promise<Envelope<ReceiptArtifactUrl>> {
    return successEnvelope(await this.artifacts.page(user, id, page));
  }

  @Delete(':id')
  async deleteReceipt(
    @CurrentUser() user: User,
    @UuidParam('id', 'RECEIPT_NOT_FOUND', 'Receipt') id: string,
  ): Promise<Envelope<{ ok: true }>> {
    return successEnvelope(await this.remove.execute(user, id));
  }
}
