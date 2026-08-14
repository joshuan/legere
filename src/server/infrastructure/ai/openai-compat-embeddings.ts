import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { readBoundedJson, readBoundedText } from '../../application/ports/binary-source';
import { EmbeddingProvider } from '../../application/ports/embedding-provider';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig } from '../config/app-config';
import { callHeaders } from '../logging/async-call-context';

// The OpenAI embeddings shape, which Ollama, LM Studio, vLLM and the rest implement too
// (docs/12 §12.4: any OpenAI-compatible base URL). `index` is read rather than trusted to be in
// order — the spec allows a provider to return them shuffled.
const embeddingsResponseSchema = z.object({
  data: z
    .array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) }))
    .min(1),
});

// 🔒 How long one batch may take. The provider is whatever the operator pointed this at — a local
// Ollama on a CPU, or somebody else's HTTP endpoint — and without a signal a hung one holds a
// vectorization worker until undici's 300 s, which a slow drip defeats outright (docs/05 §5.4). Two
// minutes is a long time for a batch of embeddings even on a small CPU, and short enough that the
// step fails and retries rather than occupying a worker.
const TIMEOUT_MS = 2 * 60_000;

// 🔒 And how much may come back. A batch answers with one vector per text — 1536 numbers, roughly
// 30 KB of JSON each — so a batch of a few hundred is a handful of megabytes. 64 MiB leaves room for
// any batch size this instance uses and refuses a provider that answers with a stream instead.
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
// An error detail is a sentence, and it is truncated to 300 characters below in any case, so a
// provider answering a failure with a gigabyte is refused at the first chunk past this.
const MAX_ERROR_BYTES = 64 * 1024;

@Injectable()
export class OpenAiCompatEmbeddings extends EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(
    config: AppConfig,
    private readonly gates: ServiceGates,
  ) {
    super();
    this.baseUrl = config.get('EMBEDDINGS_API_BASE_URL').replace(/\/+$/, '');
    this.apiKey = config.get('EMBEDDINGS_API_KEY');
    this.model = config.get('EMBEDDINGS_MODEL');
    this.dimensions = config.get('EMBEDDING_DIMENSIONS');
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  get endpoint(): string {
    return this.baseUrl;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (!this.isConfigured) throw new Error('No embeddings provider is configured');
    if (texts.length === 0) return [];

    // One batch is one unit of the `embeddings` gate (docs/05 §5.4b): a vectorization that sends
    // four batches asks the provider four times, and each one waits its turn.
    return this.gates.run('embeddings', () => this.ask(texts));
  }

  private async ask(texts: readonly string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey === '' ? {} : { authorization: `Bearer ${this.apiKey}` }),
        ...callHeaders(),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      // 🔒 Headers and body alike: when it fires, undici tears the body stream down too, so a
      // provider that answers and then drips cannot hold the worker either.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The message goes into the step error, so a misconfigured key or model is diagnosable from
      // the admin panel rather than only from the container logs.
      const detail = await readBoundedText(response, MAX_ERROR_BYTES).catch(() => '');
      throw new Error(`Embeddings request failed with ${response.status}: ${truncate(detail)}`);
    }

    const parsed = embeddingsResponseSchema.safeParse(
      await readBoundedJson(response, MAX_ANSWER_BYTES),
    );
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
