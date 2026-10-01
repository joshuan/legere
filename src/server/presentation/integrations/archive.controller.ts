import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { archiveDocumentsQuerySchema } from '../../../shared/contracts/archive-integration';
import { PersonalArchive } from '../../application/integrations/personal-archive';
import type { User } from '../../domain/entities/user';
import { ValidationFailedError } from '../../domain/errors/domain-error';
import { CurrentUser } from '../auth/current-user';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { ArchiveGuard } from './archive.guard';

const emptyQuery = z.object({}).strict();
function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationFailedError(null);
  return result.data;
}

@Controller('integrations/archive')
@Throttled('archive')
@UseGuards(ArchiveGuard)
export class ArchiveController {
  constructor(private readonly archive: PersonalArchive) {}
  @Get('me')
  me(@CurrentUser() user: User, @Query() query: unknown) {
    parse(emptyQuery, query);
    return successEnvelope({ subject: user.id, displayName: user.displayName });
  }
  @Get('documents')
  async list(@CurrentUser() user: User, @Query() query: unknown) {
    return successEnvelope(
      await this.archive.list(user.id, parse(archiveDocumentsQuerySchema, query)),
    );
  }
  @Get('documents/:id')
  async get(@CurrentUser() user: User, @Param('id') id: string, @Query() query: unknown) {
    parse(emptyQuery, query);
    return successEnvelope(await this.archive.get(user.id, parse(z.string().uuid(), id)));
  }
  @Get('documents/:id/canonical')
  async canonical(@CurrentUser() user: User, @Param('id') id: string, @Query() query: unknown) {
    parse(emptyQuery, query);
    return successEnvelope(
      await this.archive.artifact(user.id, parse(z.string().uuid(), id), 'canonical'),
    );
  }
  @Get('documents/:id/preview')
  async preview(@CurrentUser() user: User, @Param('id') id: string, @Query() query: unknown) {
    parse(emptyQuery, query);
    return successEnvelope(
      await this.archive.artifact(user.id, parse(z.string().uuid(), id), 'preview'),
    );
  }
}
