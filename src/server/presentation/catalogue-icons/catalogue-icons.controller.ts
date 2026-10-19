import { Controller, Get, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  catalogueIconTargetSchema,
  updateCatalogueIconSchema,
  MAX_CATALOGUE_ICON_BYTES,
  type CatalogueIconTarget,
  type CatalogueSymbol,
} from '../../../shared/contracts/catalogue-icons';
import { ManageCatalogueIcons } from '../../application/catalogues/manage-catalogue-icons';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodParam } from '../http/zod-validation.pipe';
import { readUploadBody } from '../documents/read-upload-body';

@Controller('catalogue-icons')
@UseGuards(SessionGuard)
export class CatalogueIconImagesController {
  constructor(private readonly icons: ManageCatalogueIcons) {}

  @Get(':catalogue/:id/image')
  async image(
    @ZodParam('catalogue', catalogueIconTargetSchema) catalogue: CatalogueIconTarget,
    @UuidParam('id', 'NOT_FOUND', 'Catalogue row') id: string,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(302, await this.icons.image(catalogue, id));
  }
}

@Controller('admin/catalogue-icons')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminCatalogueIconsController {
  constructor(private readonly icons: ManageCatalogueIcons) {}

  @Patch(':catalogue/:id')
  async symbol(
    @ZodParam('catalogue', catalogueIconTargetSchema) catalogue: CatalogueIconTarget,
    @UuidParam('id', 'NOT_FOUND', 'Catalogue row') id: string,
    @ZodBody(updateCatalogueIconSchema) body: { symbol: CatalogueSymbol | null },
  ) {
    return successEnvelope(await this.icons.setSymbol(catalogue, id, body.symbol));
  }

  @Post(':catalogue/:id/image')
  @Throttled('catalogue')
  async upload(
    @ZodParam('catalogue', catalogueIconTargetSchema) catalogue: CatalogueIconTarget,
    @UuidParam('id', 'NOT_FOUND', 'Catalogue row') id: string,
    @Req() request: Request,
  ) {
    return successEnvelope(
      await this.icons.upload(
        catalogue,
        id,
        await readUploadBody(request, MAX_CATALOGUE_ICON_BYTES),
      ),
    );
  }
}
