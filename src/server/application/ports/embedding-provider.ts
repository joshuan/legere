// Vectorization is optional (ADR: graceful degradation, docs/05 §5.5 step 5). With no provider
// configured the step is SKIPPED and everything else keeps working — semantic search simply reports
// itself unavailable.
export abstract class EmbeddingProvider {
  abstract get isConfigured(): boolean;

  // Which host the work goes to (docs/03 §3.3.18); empty when unconfigured.
  abstract get endpoint(): string;

  // Which model answers there (docs/03 §3.3.11). Stored on every chunk, because two models' vectors
  // in one column is a search whose distances mean nothing and nothing else would say so.
  abstract get model(): string;

  // One vector per input text, in the same order. The dimension is fixed by the column type
  // (vector(1024), docs/04 §4.3), so a model that returns something else is a configuration error.
  abstract embed(texts: readonly string[]): Promise<number[][]>;
}
