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

// 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-51, SEC-56): how many
// living kinds the catalogue holds at most. A household files by dozens of kinds, not thousands —
// and this is the one catalogue whose every row used to reach the analysis system message
// untruncated (SEC-51), so its ceiling is the tightest of the three. Living rows, deliberately:
// merges and soft deletes make room again.
export const MAX_LIVING_SUBJECT_KINDS = 500;
