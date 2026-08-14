import { describe, expect, it, vi } from 'vitest';
import { ServiceGates } from '../../application/queue/service-gate';
import { loadConfig } from '../config/app-config';
import { OpenAiCompatTranscriber } from './openai-compat-transcriber';

// The recogniser of last resort (docs/05 §5.5 step 3). Every case here was measured against a real
// provider on a real photograph before it was written down: these are not imagined failures.

const PAGE = { bytes: Buffer.from('page') };

function transcriberWith(
  answer: unknown,
  status = 200,
  gates: ServiceGates = new ServiceGates(),
): OpenAiCompatTranscriber {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
    APP_BASE_URL: 'http://localhost:3000',
    AUTH_SECRET: 'test-secret-minimum-32-characters!!',
    S3_ACCESS_KEY_ID: 'legere',
    S3_SECRET_ACCESS_KEY: 'legere-secret',
    TRANSCRIBER_API_BASE_URL: 'http://vision.test/v1',
    TRANSCRIBER_MODEL: 'sees-things',
  });
  globalThis.fetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(answer), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  return new OpenAiCompatTranscriber(config, gates);
}

const completion = (content: string, finish = 'stop'): unknown => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 1900, completion_tokens: 430 },
});

describe('OpenAiCompatTranscriber', () => {
  it('returns the transcription and what it cost', async () => {
    const transcriber = transcriberWith(completion('| Лейкоциты | единичные |'));

    const result = await transcriber.transcribe([PAGE], ['ru']);

    expect(result.markdown).toBe('| Лейкоциты | единичные |');
    expect(result.usage).toEqual({ promptTokens: 1900, completionTokens: 430 });
  });

  it('unwraps the code fence models add whatever they are told', async () => {
    const transcriber = transcriberWith(completion('```markdown\n# Отчёт\n\nТекст\n```'));

    expect((await transcriber.transcribe([PAGE], [])).markdown).toBe('# Отчёт\n\nТекст');
  });

  it('drops a hallucinated image, and the provider path inside it', async () => {
    // 🔒 Measured: four runs of seven emitted exactly this — a Markdown image pointing at a
    // temporary file on the provider's own disk. The prompt forbids it and it happens anyway.
    const transcriber = transcriberWith(
      completion('# Отчёт\n\n![ЛОТОС](file:///var/folders/ph/T/agy-img-1.jpg)\n\nТекст'),
    );

    const { markdown } = await transcriber.transcribe([PAGE], []);

    expect(markdown).not.toContain('file:///');
    expect(markdown).not.toContain('![');
    expect(markdown).toContain('Текст');
  });

  it('refuses a transcription that ran out of room', async () => {
    // Half a document reads exactly like a whole one: the status is 200 and the text ends on a
    // plausible line. `finish_reason` is the only thing that tells them apart.
    const transcriber = transcriberWith(completion('| Лейкоциты | еди', 'length'));

    await expect(transcriber.transcribe([PAGE], [])).rejects.toThrow(/ran out of output/u);
  });

  // One transcription — the whole document in one call — is one unit of the `transcriber` gate
  // (docs/05 §5.4b).
  it('reads a document through the transcriber gate', async () => {
    const gates = new ServiceGates();
    const run = vi.spyOn(gates, 'run');
    const transcriber = transcriberWith(completion('# Отчёт'), 200, gates);

    await transcriber.transcribe([PAGE], ['ru']);
    // Nothing to read is nothing to ask, so it takes no slot.
    await transcriber.transcribe([], ['ru']);

    expect(run.mock.calls.map(([service]) => service)).toEqual(['transcriber']);
  });

  it('asks for nothing when there are no pages to read', async () => {
    const transcriber = transcriberWith(completion('never asked'));

    expect(await transcriber.transcribe([], [])).toEqual({ markdown: '', usage: {} });
  });
});
