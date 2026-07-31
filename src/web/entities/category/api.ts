import {
  categoryDtoSchema,
  listCategoriesResponseSchema,
  type CategoryDto,
  type CreateCategoryRequest,
  type ListCategoriesResponse,
  type UpdateCategoryRequest,
} from '../../../shared/contracts/categories';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// Category endpoints (docs/07 §7.3).
export const categoryApi = {
  list: (): Promise<ListCategoriesResponse> =>
    apiClient.get('/api/categories', { schema: listCategoriesResponseSchema }),

  create: (body: CreateCategoryRequest): Promise<CategoryDto> =>
    apiClient.post('/api/admin/categories', { schema: categoryDtoSchema, body }),

  update: (id: string, body: UpdateCategoryRequest): Promise<CategoryDto> =>
    apiClient.patch(`/api/admin/categories/${id}`, { schema: categoryDtoSchema, body }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/categories/${id}`, { schema: okResponseSchema }),
};

export const categoryKeys = {
  all: ['categories'] as const,
};
