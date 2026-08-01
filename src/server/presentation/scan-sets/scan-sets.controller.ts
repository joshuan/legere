import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  createScanSetRequestSchema,
  updateScanSetRequestSchema,
  type CreateScanSetRequest,
  type ListScanSetsResponse,
  type ScanSetDetailDto,
  type ScanSetDto,
  type UpdateScanSetRequest,
} from '../../../shared/contracts/scan-sets';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  CreateScanSet,
  DeleteScanSet,
  GetScanSet,
  ListScanSets,
  MergeScanSet,
  UpdateScanSet,
} from '../../application/scan-sets/manage-scan-sets';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// Scan sets (docs/07 §7.3): a stack of photographed pages, and the PDF they become.
@Controller('scan-sets')
@UseGuards(SessionGuard)
export class ScanSetsController {
  constructor(
    private readonly list: ListScanSets,
    private readonly create: CreateScanSet,
    private readonly get: GetScanSet,
    private readonly update: UpdateScanSet,
    private readonly merge: MergeScanSet,
    private readonly remove: DeleteScanSet,
  ) {}

  @Get()
  async listScanSets(@CurrentUser() user: User): Promise<Envelope<ListScanSetsResponse>> {
    return successEnvelope(await this.list.execute(viewerOf(user)));
  }

  @Post()
  async createScanSet(
    @CurrentUser() user: User,
    @ZodBody(createScanSetRequestSchema) body: CreateScanSetRequest,
  ): Promise<Envelope<ScanSetDetailDto>> {
    return successEnvelope(await this.create.execute(viewerOf(user), body));
  }

  @Get(':id')
  async getScanSet(
    @CurrentUser() user: User,
    @UuidParam('id', 'SCANSET_NOT_FOUND', 'Scan set') id: string,
  ): Promise<Envelope<ScanSetDetailDto>> {
    return successEnvelope(await this.get.execute(viewerOf(user), id));
  }

  @Patch(':id')
  async updateScanSet(
    @CurrentUser() user: User,
    @UuidParam('id', 'SCANSET_NOT_FOUND', 'Scan set') id: string,
    @ZodBody(updateScanSetRequestSchema) body: UpdateScanSetRequest,
  ): Promise<Envelope<ScanSetDetailDto>> {
    return successEnvelope(await this.update.execute(viewerOf(user), id, body));
  }

  @Post(':id/merge')
  async mergeScanSet(
    @CurrentUser() user: User,
    @UuidParam('id', 'SCANSET_NOT_FOUND', 'Scan set') id: string,
  ): Promise<Envelope<ScanSetDto>> {
    return successEnvelope(await this.merge.execute(viewerOf(user), id));
  }

  @Delete(':id')
  async deleteScanSet(
    @CurrentUser() user: User,
    @UuidParam('id', 'SCANSET_NOT_FOUND', 'Scan set') id: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.remove.execute(viewerOf(user), id));
  }
}

function viewerOf(user: User): { id: string; role: User['role'] } {
  return { id: user.id, role: user.role };
}
