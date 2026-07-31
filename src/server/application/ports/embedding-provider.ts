// Vectorization is optional (ADR: graceful degradation, docs/05 §5.5 step 5). With no provider
// configured the step is SKIPPED and everything else keeps working — semantic search simply reports
// itself unavailable.
export abstract class EmbeddingProvider {
  abstract get isConfigured(): boolean;

  // One vector per input text, in the same order. The dimension is fixed by the column type
  // (vector(1536), docs/04 §4.3), so a model that returns something else is a configuration error.
  abstract embed(texts: readonly string[]): Promise<number[][]>;
}
