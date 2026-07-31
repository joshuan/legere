// What the classifier is allowed to choose from (docs/03 §3.3.12): the slug is the stable
// identifier it answers with, the description is the guidance an admin wrote for exactly this.
export type CategoryOption = {
  slug: string;
  name: string;
  description: string | null;
};

// Categorization is optional in the same way vectorization is (docs/05 §5.5 step 4): unconfigured
// means SKIPPED, not failed.
export abstract class DocumentClassifier {
  abstract get isConfigured(): boolean;

  // Returns one of the offered slugs, or null when the model picks none of them — or answers with
  // something that was never on the list, which is the same thing as far as the caller is concerned.
  abstract classify(excerpt: string, categories: readonly CategoryOption[]): Promise<string | null>;
}
