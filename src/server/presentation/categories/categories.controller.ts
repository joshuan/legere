import { Controller, Delete, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  createCategoryRequestSchema,
  updateCategoryRequestSchema,
  type CategoryDto,
  type CreateCategoryRequest,
  type ListCategoriesResponse,
  type UpdateCategoryRequest,
} from '../../../shared/contracts/categories';
import type { Envelope } from '../../../shared/contracts/common';
import {
  CreateCategory,
  DeleteCategory,
  ListCategories,
  UpdateCategory,
} from '../../application/categories/manage-categories';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// GET /api/categories (docs/07 §7.3): every signed-in user reads the reference list — it is what the
// filters and the category picker are built from.
@Controller('categories')
@UseGuards(SessionGuard)
export class CategoriesController {
  constructor(private readonly list: ListCategories) {}

  @Get()
  async listCategories(): Promise<Envelope<ListCategoriesResponse>> {
    return successEnvelope(await this.list.execute());
  }
}

// Managing the list is an admin's job (docs/11 §11.12).
@Controller('admin/categories')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminCategoriesController {
  constructor(
    private readonly create: CreateCategory,
    private readonly update: UpdateCategory,
    private readonly remove: DeleteCategory,
  ) {}

  @Post()
  async createCategory(
    @ZodBody(createCategoryRequestSchema) body: CreateCategoryRequest,
  ): Promise<Envelope<CategoryDto>> {
    return successEnvelope(await this.create.execute(body));
  }

  @Patch(':id')
  async updateCategory(
    @UuidParam('id', 'CATEGORY_NOT_FOUND', 'Category') id: string,
    @ZodBody(updateCategoryRequestSchema) body: UpdateCategoryRequest,
  ): Promise<Envelope<CategoryDto>> {
    return successEnvelope(await this.update.execute(id, body));
  }

  @Delete(':id')
  async deleteCategory(
    @UuidParam('id', 'CATEGORY_NOT_FOUND', 'Category') id: string,
  ): Promise<Envelope<{ ok: true; documentsReset: number }>> {
    return successEnvelope(await this.remove.execute(id));
  }
}
