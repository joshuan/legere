// What a document is about (docs/03 §3.3.20): a flat, a car, a country. The kind says what sort of
// thing it is; the name says which one.
export type Subject = {
  id: string;
  kind: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};
