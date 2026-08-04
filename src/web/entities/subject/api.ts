import {
  createSubjectRequestSchema,
  listSubjectsResponseSchema,
  subjectDtoSchema,
  updateSubjectRequestSchema,
  type CreateSubjectRequest,
  type ListSubjectsResponse,
  type SubjectDto,
  type UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

export const subjectApi = {
  list: (): Promise<ListSubjectsResponse> =>
    apiClient.get('/api/subjects', { schema: listSubjectsResponseSchema }),

  // Open to anyone signed in, like people: the analysis adds things on its own (docs/03 §3.3.20).
  create: (body: CreateSubjectRequest): Promise<SubjectDto> =>
    apiClient.post('/api/subjects', {
      schema: subjectDtoSchema,
      body: createSubjectRequestSchema.parse(body),
    }),

  // Renaming and removing reach across every document about that thing, so they are an admin's
  // (docs/11 §11.12).
  update: (id: string, body: UpdateSubjectRequest): Promise<SubjectDto> =>
    apiClient.patch(`/api/admin/subjects/${id}`, {
      schema: subjectDtoSchema,
      body: updateSubjectRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/subjects/${id}`, { schema: okResponseSchema }),
};

export const subjectKeys = {
  all: ['subjects'] as const,
};
