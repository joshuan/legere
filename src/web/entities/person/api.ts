import {
  createPersonRequestSchema,
  listPeopleResponseSchema,
  personDtoSchema,
  updatePersonRequestSchema,
  type CreatePersonRequest,
  type ListPeopleResponse,
  type PersonDto,
  type UpdatePersonRequest,
} from '../../../shared/contracts/people';
import { okResponseSchema, type OkResponse } from '../../../shared/contracts/users';
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

  // Renaming and removing reach across every document that names the person, so they are an admin's
  // (docs/11 §11.12).
  update: (id: string, body: UpdatePersonRequest): Promise<PersonDto> =>
    apiClient.patch(`/api/admin/people/${id}`, {
      schema: personDtoSchema,
      body: updatePersonRequestSchema.parse(body),
    }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/admin/people/${id}`, { schema: okResponseSchema }),
};

export const personKeys = {
  all: ['people'] as const,
};
