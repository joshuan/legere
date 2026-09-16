import {
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Envelope } from '../../../shared/contracts/common';
import type {
  UploadReceiptResponse,
  UploadReceiptFields,
} from '../../../shared/contracts/receipts';
import { UploadReceipt } from '../../application/receipts/upload-receipt';
import { ValidationFailedError } from '../../domain/errors/domain-error';
import { CurrentUser } from '../auth/current-user';
import { ApiTokenScopeGuard } from '../auth/api-token-scope.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { uploadReceiptFieldsSchema } from '../../../shared/contracts/receipts';
import type { User } from '../../domain/entities/user';

type MultipartReceiptFile = { buffer: Buffer; originalname: string };

// POST /api/incoming/receipts: an n8n attachment in the same multipart shape as the browser route.
@Controller('incoming/receipts')
@UseGuards(ApiTokenScopeGuard)
export class ReceiptIngestController {
  constructor(private readonly upload: UploadReceipt) {}

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
}
