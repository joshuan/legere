import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import { apiTokenDtoSchema } from './users';
import { documentStepsSchema } from './documents';
import { agentIdentitySchema } from './identity';

export const integrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type IntegrationDto = z.infer<typeof integrationSchema>;
export const listIntegrationsSchema = z.object({ items: z.array(integrationSchema) });
export const createIntegrationSchema = z
  .object({ name: z.string().trim().min(1).max(128) })
  .strict();
export const integrationTokenRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
export const integrationTokenResponseSchema = z.object({
  token: z.string(),
  apiToken: apiTokenDtoSchema,
});
export const integrationDocumentSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  createdAt: z.string().datetime(),
  documentDate: z.string().nullable(),
  pageCount: z.number().int().nonnegative().nullable(),
  processing: z.boolean(),
  steps: documentStepsSchema,
  url: z.string().url(),
  ownerId: z.string().uuid(),
  createdVia: agentIdentitySchema.nullable(),
});
export type IntegrationDocumentDto = z.infer<typeof integrationDocumentSchema>;
export const integrationDocumentsQuerySchema = paginationQuerySchema.strict();
export const integrationDocumentListSchema = paginatedSchema(integrationDocumentSchema);
export const integrationUploadResponseSchema = z.object({
  document: integrationDocumentSchema,
  created: z.boolean(),
});
export const integrationArtifactSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  contentType: z.enum(['application/pdf', 'image/jpeg']),
});
