import {
  createSubjectKindRequestSchema,
  listSubjectKindsResponseSchema,
  subjectKindDtoSchema,
  updateSubjectKindRequestSchema,
  type CreateSubjectKindRequest,
  type ListSubjectKindsResponse,
  type SubjectKindDto,
  type UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import { okResponseSchema } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

export const subjectKindApi = {
  list: (): Promise<ListSubjectKindsResponse> =>
    apiClient.get('/api/subject-kinds', { schema: listSubjectKindsResponseSchema }),

  // Open to anyone signed in, like people and subjects: the analysis adds a kind it meets, and
  // whoever files a boat must not wait for an admin to invent "boat" (docs/03 §3.3.20a).
  create: (body: CreateSubjectKindRequest): Promise<SubjectKindDto> =>
    apiClient.post('/api/subject-kinds', {
      schema: subjectKindDtoSchema,
      body: createSubjectKindRequestSchema.parse(body),
    }),

  update: (id: string, body: UpdateSubjectKindRequest): Promise<SubjectKindDto> =>
    apiClient.patch(`/api/admin/subject-kinds/${id}`, {
      schema: subjectKindDtoSchema,
      body: updateSubjectKindRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<{ ok: boolean }> =>
    apiClient.delete(`/api/admin/subject-kinds/${id}`, { schema: okResponseSchema }),
};

export const subjectKindKeys = {
  all: ['subject-kinds'] as const,
};
