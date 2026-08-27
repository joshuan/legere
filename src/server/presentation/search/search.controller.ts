import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  searchQuerySchema,
  type SearchQuery,
  type SearchResponse,
} from '../../../shared/contracts/search';
import { SearchDocuments } from '../../application/search/search-documents';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { ZodQuery } from '../http/zod-validation.pipe';

// GET /api/search (docs/07 §7.3). The access filter lives inside the SQL, so nothing this caller
// may not read can appear in a result set.
@Controller('search')
@UseGuards(SessionGuard)
export class SearchController {
  constructor(private readonly search: SearchDocuments) {}

  // 🔒 Throttled against the caller rather than their address (docs/08 §8.4, SEC-74): a search is
  // the one read a signed-in caller can repeat at will, and every non-text one spends an outbound
  // embeddings call on the operator's provider and a turn at the pipeline's embeddings gate.
  @Get()
  @Throttled('search')
  async searchDocuments(
    @CurrentUser() user: User,
    @ZodQuery(searchQuerySchema) query: SearchQuery,
  ): Promise<Envelope<SearchResponse>> {
    return successEnvelope(await this.search.execute({ id: user.id, role: user.role }, query));
  }
}
