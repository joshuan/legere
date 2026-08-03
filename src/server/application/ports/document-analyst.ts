// What the analyst is allowed to choose from (docs/03 §3.3.12): the slug is the stable identifier it
// answers with, the description is the guidance an admin wrote for exactly this.
export type CategoryOption = {
  slug: string;
  name: string;
  description: string | null;
};

// What one look at a document yields (docs/05 §5.5 step 4). Every field is independently optional:
// a model that recognises an invoice but cannot tell which country it is from should still be able
// to say so, rather than being pushed into inventing the rest.
export type DocumentAnalysis = {
  // One of the offered slugs, or null when the model picks none of them — or answers with something
  // that was never on the list, which is the same thing as far as the caller is concerned.
  categorySlug: string | null;
  // BCP-47 tags. Read from what the document *is*, not from the shape of its letters: "ŽPCG" and
  // "PODGORICA" say Montenegro to a reader who knows the railway, and say nothing to an n-gram
  // detector (docs/03 §3.3.10).
  languages: string[];
  // ISO 3166-1 alpha-2, upper-case.
  country: string | null;
  // As written in the document, in whatever language it is written in.
  city: string | null;
};

// The AI step is optional in the same way vectorization is (docs/05 §5.5 step 4): unconfigured
// means SKIPPED, not failed.
export abstract class DocumentAnalyst {
  abstract get isConfigured(): boolean;

  abstract analyze(
    excerpt: string,
    categories: readonly CategoryOption[],
  ): Promise<DocumentAnalysis>;
}
