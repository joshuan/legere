import { Controller, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Envelope } from '../../../shared/contracts/common';
import type { ConvertArchiveItemResponse } from '../../../shared/contracts/receipts';
import { ConvertArchiveItem } from '../../application/archive-items/convert-archive-item';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody } from '../http/zod-validation.pipe';

const convertBodySchema = z.object({ kind: z.enum(['DOCUMENT', 'RECEIPT']) });
type ConvertBody = z.infer<typeof convertBodySchema>;

@Controller('archive-items')
@UseGuards(SessionGuard, RolesGuard)
export class ArchiveItemsController {
  constructor(private readonly convert: ConvertArchiveItem) {}

  @Patch(':id/kind')
  async convertKind(
    @CurrentUser() user: User,
    @UuidParam('id', 'NOT_FOUND', 'Archive item') id: string,
    @ZodBody(convertBodySchema) body: ConvertBody,
  ): Promise<Envelope<ConvertArchiveItemResponse>> {
    return successEnvelope(await this.convert.execute(user, id, body.kind));
  }
}
