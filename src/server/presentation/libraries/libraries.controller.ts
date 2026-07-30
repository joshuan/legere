import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import type { ListLibrariesResponse } from '../../../shared/contracts/libraries';
import { ListVisibleLibraries } from '../../application/libraries/manage-libraries';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';

// GET /api/libraries (docs/07 §7.3): the libraries this caller may read, used for filters and browse
// roots. A RESTRICTED library the caller has no grant for simply is not listed (docs/08 §8.5).
@Controller('libraries')
@UseGuards(SessionGuard)
export class LibrariesController {
  constructor(private readonly listVisibleLibraries: ListVisibleLibraries) {}

  @Get()
  async list(@CurrentUser() user: User): Promise<Envelope<ListLibrariesResponse>> {
    return successEnvelope(
      await this.listVisibleLibraries.execute({ id: user.id, role: user.role }),
    );
  }
}
