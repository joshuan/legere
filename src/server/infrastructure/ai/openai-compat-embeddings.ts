import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { AppConfig } from '../config/app-config';

// The OpenAI embeddings shape, which Ollama, LM Studio, vLLM and the rest implement too
// (docs/12 §12.4: any OpenAI-compatible base URL). `index` is read rather than trusted to be in
// order — the spec allows a provider to return them shuffled.
const embeddingsResponseSchema = z.object({
  data: z
    .array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }))
    .min(1),
});

@Injectable()
export class OpenAiCompatEmbeddings extends EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(config: AppConfig) {
    super();
    this.baseUrl = config.get('EMBEDDINGS_API_BASE_URL').replace(/\/+$/, '');
    this.apiKey = config.get('EMBEDDINGS_API_KEY');
    this.model = config.get('EMBEDDINGS_MODEL');
    this.dimensions = config.get('EMBEDDING_DIMENSIONS');
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!this.isConfigured) throw new Error('No embeddings provider is configured');
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      // The message goes into the step error, so a misconfigured key or model is diagnosable from
      // the admin panel rather than only from the container logs.
      const detail = await response.text().catch(() => '');
      throw new Error(`Embeddings request failed with ${response.status}: ${truncate(detail)}`);
    }

    const parsed = embeddingsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Embeddings provider returned an unreadable response');

    const vectors: number[][] = [];
    for (const [position] of texts.entries()) {
      const vector = parsed.data.data.find((item) => item.index === position)?.embedding;
      if (vector === undefined) throw new Error(`Embeddings provider skipped text ${position}`);
      // 🔒 The column is vector(1536): a model of another size would be rejected by Postgres row by
      // row, leaving half the chunks written. Better to refuse the whole batch here.
      if (vector.length !== this.dimensions) {
        throw new Error(
          `Embeddings provider returned ${vector.length} dimensions, expected ${this.dimensions}`,
        );
      }
      vectors.push(vector);
    }
    return vectors;
  }
}

function truncate(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
