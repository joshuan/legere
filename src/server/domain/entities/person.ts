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
