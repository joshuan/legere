import { z } from 'zod';

// What a card may put under its title, and what the reader may switch off (docs/11 §11.3).
//
// The extension badge and the document type are in the set rather than fixed, because "what you came
// for" differs by archive: somebody filing scans by person does not need to be told PDF forty times.
// The state badges are deliberately *not* here — "Processing", "Some files missing" and the file
// count say what is happening to a document rather than what it is about, and a card that could hide
// them would be a card that lies by omission.
export const documentCardFieldSchema = z.enum([
  'ext',
  'type',
  'date',
  'people',
  'subjects',
  'place',
  'languages',
]);
export type DocumentCardField = z.infer<typeof documentCardFieldSchema>;

// In the order a card draws them, whichever order they were asked for in: a chosen set is a set.
export const DOCUMENT_CARD_FIELDS: readonly DocumentCardField[] = documentCardFieldSchema.options;

// The arrangement every screen but the home one keeps, and the one the home screen starts from:
// exactly what the card showed before it could be arranged at all (docs/11 §11.3).
export const DEFAULT_DOCUMENT_CARD_FIELDS: readonly DocumentCardField[] = ['ext', 'type'];

// A chosen set out of a query-string value: `?card=date,people`. Unknown names are dropped rather
// than refused — a hand-edited URL cannot break the screen — and the order is the card's own.
// An empty value is a real choice ("title only"), which is why absence, not emptiness, is what means
// "the default" (docs/11 §11.3).
export function parseDocumentCardFields(value: string | null): readonly DocumentCardField[] | null {
  if (value === null) return null;
  const asked = new Set(value.split(','));
  return DOCUMENT_CARD_FIELDS.filter((field) => asked.has(field));
}

// The same, back into the query string. Null when the choice is the default one, which leaves no
// trace the way an unset filter does not.
export function formatDocumentCardFields(fields: readonly DocumentCardField[]): string | null {
  const chosen = DOCUMENT_CARD_FIELDS.filter((field) => fields.includes(field));
  const isDefault =
    chosen.length === DEFAULT_DOCUMENT_CARD_FIELDS.length &&
    chosen.every((field) => DEFAULT_DOCUMENT_CARD_FIELDS.includes(field));
  return isDefault ? null : chosen.join(',');
}
