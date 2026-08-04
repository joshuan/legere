import {
  createPersonRequestSchema,
  listPeopleResponseSchema,
  personDtoSchema,
  type CreatePersonRequest,
  type ListPeopleResponse,
  type PersonDto,
} from '../../../shared/contracts/people';
import { apiClient } from '../../shared/api';

export const personApi = {
  list: (): Promise<ListPeopleResponse> =>
    apiClient.get('/api/people', { schema: listPeopleResponseSchema }),

  // Open to anyone signed in: the analyst adds names on its own, and whoever corrects it must be
  // able to add the one it missed (docs/03 §3.3.19).
  create: (body: CreatePersonRequest): Promise<PersonDto> =>
    apiClient.post('/api/people', {
      schema: personDtoSchema,
      body: createPersonRequestSchema.parse(body),
    }),
};

export const personKeys = {
  all: ['people'] as const,
};
