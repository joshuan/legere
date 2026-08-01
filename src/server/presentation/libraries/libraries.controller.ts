import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  browseQuerySchema,
  type BrowseQuery,
  type BrowseResponse,
  type ListLibrariesResponse,
} from '../../../shared/contracts/libraries';
import { BrowseLibrary } from '../../application/libraries/browse-library';
import { ListVisibleLibraries } from '../../application/libraries/manage-libraries';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodQuery } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// GET /api/libraries (docs/07 §7.3): the libraries this caller may read, used for filters and browse
// roots. A RESTRICTED library the caller has no grant for simply is not listed (docs/08 §8.5).
@Controller('libraries')
@UseGuards(SessionGuard)
export class LibrariesController {
  constructor(
    private readonly listVisibleLibraries: ListVisibleLibraries,
    private readonly browse: BrowseLibrary,
  ) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<Envelope<ListLibrariesResponse>> {
    return successEnvelope(
      await this.listVisibleLibraries.execute({ id: user.id, role: user.role }),
    );
  }

  // GET /api/libraries/:id/browse (docs/07 §7.3, docs/11 §11.4): one level of the mounted folder
  // structure, plus the documents that sit directly in it.
  @Get(':id/browse')
  async browseLibrary(
    @CurrentUser() user: User,
    @UuidParam('id', 'LIBRARY_NOT_FOUND', 'Library') id: string,
    @ZodQuery(browseQuerySchema) query: BrowseQuery,
  ): Promise<Envelope<BrowseResponse>> {
    return successEnvelope(await this.browse.execute({ id: user.id, role: user.role }, id, query));
  }
}
