import { Controller, Delete, Get, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { type Envelope } from '../../../shared/contracts/common';
import {
  listTrashQuerySchema,
  type EmptyTrashResponse,
  type ListTrashQuery,
  type ListTrashResponse,
  type RestoreTrashResponse,
} from '../../../shared/contracts/trash';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  DeleteTrashItem,
  DownloadTrashItem,
  EmptyTrash,
  ListTrash,
  RestoreTrashItem,
} from '../../application/trash/manage-trash';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { sendDownload } from '../http/send-download';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodQuery } from '../http/zod-validation.pipe';

// The trash (docs/07 §7.3, docs/05 §5.7a, docs/11 §11.13b): every file that has left a document and
// has not been destroyed yet. An admin's, all of it — each route either destroys bytes for good or
// makes a document.
@Controller('admin/trash')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminTrashController {
  constructor(
    private readonly list: ListTrash,
    private readonly removeOne: DeleteTrashItem,
    private readonly empty: EmptyTrash,
    private readonly restore: RestoreTrashItem,
    private readonly download: DownloadTrashItem,
  ) {}

  @Get()
  async listTrash(
    @ZodQuery(listTrashQuerySchema) query: ListTrashQuery,
  ): Promise<Envelope<ListTrashResponse>> {
    return successEnvelope(await this.list.execute(query));
  }

  // Everything, not "everything due": the retention window says when a file goes at the latest, and
  // this is somebody saying now (docs/05 §5.7a). Declared before `:fileId`, or the router would read
  // the empty path as an id.
  @Delete()
  async emptyTrash(): Promise<Envelope<EmptyTrashResponse>> {
    return successEnvelope(await this.empty.execute());
  }

  // The bytes themselves, on the same terms as any other original (docs/09 §9.2). Getting a scan
  // back out is often the whole errand, and it should not require restoring it first.
  @Get(':fileId/content')
  async getContent(
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendDownload(res, await this.download.execute(fileId));
  }

  @Delete(':fileId')
  async deleteItem(
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
  ): Promise<Envelope<OkResponse>> {
    return successEnvelope(await this.removeOne.execute(fileId));
  }

  // A creation, and it says so: what comes back is a new document, never the one the file left
  // (docs/05 §5.7a).
  @Post(':fileId/restore')
  @HttpCode(201)
  async restoreItem(
    @CurrentUser() user: User,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
  ): Promise<Envelope<RestoreTrashResponse>> {
    return successEnvelope(await this.restore.execute(fileId, user.id));
  }
}
