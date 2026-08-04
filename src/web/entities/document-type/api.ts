import {
  documentTypeDtoSchema,
  listDocumentTypesResponseSchema,
  type DocumentTypeDto,
  type CreateDocumentTypeRequest,
  type ListDocumentTypesResponse,
  type UpdateDocumentTypeRequest,
} from '../../../shared/contracts/document-types';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// DocumentType endpoints (docs/07 §7.3).
export const documentTypeApi = {
  list: (): Promise<ListDocumentTypesResponse> =>
    apiClient.get('/api/document-types', { schema: listDocumentTypesResponseSchema }),

  create: (body: CreateDocumentTypeRequest): Promise<DocumentTypeDto> =>
    apiClient.post('/api/admin/document-types', { schema: documentTypeDtoSchema, body }),

  update: (id: string, body: UpdateDocumentTypeRequest): Promise<DocumentTypeDto> =>
    apiClient.patch(`/api/admin/document-types/${id}`, { schema: documentTypeDtoSchema, body }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/document-types/${id}`, { schema: okResponseSchema }),
};

export const documentTypeKeys = {
  all: ['documentTypes'] as const,
};
