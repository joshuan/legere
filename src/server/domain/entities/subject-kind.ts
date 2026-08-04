// What sort of thing a subject is: "apartment", "car", "country" (docs/03 §3.3.20a). A catalogue of
// its own, so that the same kind cannot exist twice under two spellings and renaming one is a single
// edit rather than one per subject.
export type SubjectKind = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};
