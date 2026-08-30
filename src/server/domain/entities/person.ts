// A person a document is about (docs/03 §3.3.19): the parties to a contract, the passenger on a
// ticket. A shared catalogue, so the same person on forty documents is one row and correcting a
// spelling corrects all forty.
export type Person = {
  id: string;
  name: string;
  // Anything that tells two people of the same name apart, in whatever words the owner likes.
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

// 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-51, SEC-56): how many
// living people the catalogue holds at most. A family archive has hundreds of people, not millions,
// so the bound costs nothing legitimate — what it bounds is one account filling a namespace every
// other user reads, and a table the analysis carries on every document. Living rows, deliberately:
// merges and soft deletes make room again.
export const MAX_LIVING_PEOPLE = 10_000;
