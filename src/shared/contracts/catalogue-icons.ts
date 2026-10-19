import { z } from 'zod';

export const catalogueIconTargetSchema = z.enum(['subjects', 'subject-kinds']);
export type CatalogueIconTarget = z.infer<typeof catalogueIconTargetSchema>;
export const catalogueSymbolSchema = z.enum([
  'building',
  'bank',
  'home',
  'car',
  'shop',
  'health',
  'education',
  'travel',
  'document',
  'tool',
  'globe',
  'folder',
  'heart',
  'person',
]);
export type CatalogueSymbol = z.infer<typeof catalogueSymbolSchema>;
export const catalogueIconSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('symbol'), symbol: catalogueSymbolSchema }),
  z.object({ type: z.literal('image'), revision: z.string().uuid() }),
]);
export type CatalogueIcon = z.infer<typeof catalogueIconSchema>;
export const updateCatalogueIconSchema = z.object({ symbol: catalogueSymbolSchema.nullable() });
export const catalogueIconResponseSchema = z.object({ icon: catalogueIconSchema.nullable() });
export const MAX_CATALOGUE_ICON_BYTES = 2 * 1024 * 1024;
