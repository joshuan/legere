import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  createLibraryRequestSchema,
  listScanRunsQuerySchema,
  pathCandidatesQuerySchema,
  updateLibraryRequestSchema,
  type CreateLibraryRequest,
  type LibraryAdminDto,
  type ListLibrariesAdminResponse,
  type ListScanRunsQuery,
  type ListScanRunsResponse,
  type PathCandidatesQuery,
  type PathCandidatesResponse,
  type TriggerScanResponse,
  type UpdateLibraryRequest,
} from '../../../shared/contracts/libraries';
import type { OkResponse } from '../../../shared/contracts/users';
import {
  CreateLibrary,
  DeleteLibrary,
  GetLibraryAdmin,
  ListLibrariesAdmin,
  ListLibraryPathCandidates,
  UpdateLibrary,
} from '../../application/libraries/manage-libraries';
import { ListScanRuns, TriggerScan } from '../../application/libraries/manage-scans';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';

// Admin library management (docs/07 §7.3). Guard order: SessionGuard → RolesGuard (docs/06 §6.4).
@Controller('admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminLibrariesController {
  constructor(
    private readonly createLibrary: CreateLibrary,
    private readonly updateLibrary: UpdateLibrary,
    private readonly deleteLibrary: DeleteLibrary,
    private readonly listLibraries: ListLibrariesAdmin,
    private readonly getLibrary: GetLibraryAdmin,
    private readonly pathCandidates: ListLibraryPathCandidates,
    private readonly triggerScan: TriggerScan,
    private readonly listScanRuns: ListScanRuns,
  ) {}

  // Declared before the ':id' routes so the literal path is not captured as an id.
  @Get('library-path-candidates')
  async candidates(
    @ZodQuery(pathCandidatesQuerySchema) query: PathCandidatesQuery,
  ): Promise<Envelope<PathCandidatesResponse>> {
    return successEnvelope(await this.pathCandidates.execute(query.path));
  }

  @Post('libraries')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @ZodBody(createLibraryRequestSchema) body: CreateLibraryRequest,
  ): Promise<Envelope<LibraryAdminDto>> {
    return successEnvelope(await this.createLibrary.execute(body));
  }

  @Get('libraries')
  async list(): Promise<Envelope<ListLibrariesAdminResponse>> {
    return successEnvelope(await this.listLibraries.execute());
  }

  @Get('libraries/:id')
  async get(@Param('id') id: string): Promise<Envelope<LibraryAdminDto>> {
    return successEnvelope(await this.getLibrary.execute(id));
  }

  @Patch('libraries/:id')
  async update(
    @Param('id') id: string,
    @ZodBody(updateLibraryRequestSchema) body: UpdateLibraryRequest,
  ): Promise<Envelope<LibraryAdminDto>> {
    return successEnvelope(await this.updateLibrary.execute(id, body));
  }

  @Delete('libraries/:id')
  async remove(@Param('id') id: string): Promise<Envelope<OkResponse>> {
    await this.deleteLibrary.execute(id);
    return successEnvelope({ ok: true });
  }

  @Post('libraries/:id/scan')
  @HttpCode(HttpStatus.OK)
  async scan(@Param('id') id: string): Promise<Envelope<TriggerScanResponse>> {
    return successEnvelope(await this.triggerScan.execute(id));
  }

  @Get('libraries/:id/scans')
  async scans(
    @Param('id') id: string,
    @ZodQuery(listScanRunsQuerySchema) query: ListScanRunsQuery,
  ): Promise<Envelope<ListScanRunsResponse>> {
    return successEnvelope(await this.listScanRuns.execute(id, query));
  }
}
