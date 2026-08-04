import {
  createSubjectRequestSchema,
  listSubjectsResponseSchema,
  subjectDtoSchema,
  type CreateSubjectRequest,
  type ListSubjectsResponse,
  type SubjectDto,
} from '../../../shared/contracts/subjects';
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
};

export const subjectKeys = {
  all: ['subjects'] as const,
};
