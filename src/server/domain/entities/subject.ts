// What a document is about (docs/03 §3.3.20): a flat, a car, a country. The kind says what sort of
// thing it is; the name says which one.
export type Subject = {
  id: string;
  // Which SubjectKind this is one of (docs/03 §3.3.20a); the name comes with it wherever a subject
  // is shown, because both halves are what identifies the thing.
  kindId: string;
  kind: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

// 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-51, SEC-56): how many
// living subjects the catalogue holds at most — twice the people's, because things accumulate
// faster than people do: every flat, car, company and country a document ever named. Living rows,
// deliberately: merges and soft deletes make room again.
export const MAX_LIVING_SUBJECTS = 20_000;
