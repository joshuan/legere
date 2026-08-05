// What the analyst is allowed to choose from (docs/03 §3.3.12): the slug is the stable identifier it
// answers with, the description is the guidance an admin wrote for exactly this.
export type DocumentTypeOption = {
  slug: string;
  name: string;
  description: string | null;
};

// What one look at a document yields (docs/05 §5.5 step 4). Every field is independently optional:
// a model that recognises an invoice but cannot tell which country it is from should still be able
// to say so, rather than being pushed into inventing the rest.
export type DocumentAnalysis = {
  // What a person would write on the folder, in the document's own language — "Rental agreement,
  // Njegoševa 12" rather than "IMG_20260714_113355". Null when the excerpt says nothing worth
  // titling, which is a better answer than a title invented out of a file name (docs/03 §3.3.10).
  title: string | null;
  // What the document is, between whom and what for, in a few hundred characters — enough to judge
  // an unfamiliar document without reading it (docs/03 §3.3.10).
  description: string | null;
  // One of the offered slugs, or null when the model picks none of them — or answers with something
  // that was never on the list, which is the same thing as far as the caller is concerned.
  typeSlug: string | null;
  // BCP-47 tags. Read from what the document *is*, not from the shape of its letters: "ŽPCG" and
  // "PODGORICA" say Montenegro to a reader who knows the railway, and say nothing to an n-gram
  // detector (docs/03 §3.3.10).
  languages: string[];
  // ISO 3166-1 alpha-2, upper-case.
  country: string | null;
  // As written in the document, in whatever language it is written in.
  city: string | null;
  // The people the document is about, named as it names them: the parties to a contract, the
  // passenger on a ticket (docs/03 §3.3.19).
  people: string[];
  // The date written on the document — signed, issued, departed — as yyyy-mm-dd.
  date: string | null;
  // What the document is about: the kind of thing and which one (docs/03 §3.3.20).
  subjects: Array<{ kind: string; name: string }>;
};

// The AI step is optional in the same way vectorization is (docs/05 §5.5 step 4): unconfigured
// means SKIPPED, not failed.
export abstract class DocumentAnalyst {
  abstract get isConfigured(): boolean;

  // Which host the work goes to (docs/03 §3.3.18); empty when unconfigured.
  abstract get endpoint(): string;

  // The kinds the catalogue already holds travel with the request: a model told what "apartment"
  // is called here reuses it instead of inventing a synonym, which is what turns one shelf into two
  // (docs/03 §3.3.20a).
  abstract analyze(
    excerpt: string,
    documentTypes: readonly DocumentTypeOption[],
    subjectKinds: readonly string[],
  ): Promise<DocumentAnalysis>;
}
