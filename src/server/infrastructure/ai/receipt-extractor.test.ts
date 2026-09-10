import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import { fieldSchemaFor } from '../../../shared/contracts/document-fields';
import { DocumentAnalyst } from '../../application/ports/document-analyst';
import { ReceiptExtractor } from '../../application/ports/receipt-extractor';
import { ServiceThrottledError } from '../../application/ports/service-unavailable';
import { ungatedServices } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig, loadConfig } from '../config/app-config';
import { serviceEndpoint } from '../config/service-endpoints';
import { AiModule } from './ai.module';
import { OpenAiCompatAnalyst } from './openai-compat-analyst';

const MODEL = 'gemma4:e4b-it-q4_K_M';
const schema = fieldSchemaFor('receipt');
if (schema === null) throw new Error('Missing receipt schema');
const receiptSchema = schema;

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere_test',
    APP_BASE_URL: 'http://localhost:3000',
    AUTH_SECRET: 'test-secret-minimum-32-characters!!',
    S3_ACCESS_KEY_ID: 'test',
    S3_SECRET_ACCESS_KEY: 'test-secret',
    CLASSIFIER_API_BASE_URL: 'https://documents.example/v1',
    CLASSIFIER_API_KEY: 'document-only-key',
    CLASSIFIER_MODEL: 'unchanged-document-model',
    EMBEDDINGS_API_KEY: 'embedding-only-key',
    RECEIPT_API_BASE_URL: 'http://ollama.example:11434/v1',
    RECEIPT_MODEL: MODEL,
    ...extra,
  });
}

function answer(content = '{"vendor":"Test Shop","total":{"amount":650,"currency":"RSD"}}') {
  return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
}

@Global()
@Module({})
class Dependencies {}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('dedicated receipt extraction', () => {
  it('wires independent receipt and document clients through the real AI module', async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        {
          module: Dependencies,
          providers: [
            { provide: AppConfig, useValue: config() },
            { provide: ServiceGates, useValue: new ServiceGates(new FixedClock()) },
          ],
          exports: [AppConfig, ServiceGates],
        },
        AiModule,
      ],
    }).compile();
    try {
      const documents = module.get(DocumentAnalyst);
      const receipts = module.get(ReceiptExtractor);
      expect(receipts).not.toBe(documents);
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
        if (typeof init?.body !== 'string' || typeof url !== 'string') {
          throw new Error('Expected a JSON request to a URL string');
        }
        const body: unknown = JSON.parse(init.body);
        if (url.includes('ollama.example')) {
          expect(body).toMatchObject({ model: MODEL, reasoning_effort: 'none', max_tokens: 8192 });
          expect(body).toMatchObject({
            messages: [
              expect.objectContaining({ role: 'system' }),
              {
                role: 'user',
                content: [
                  expect.objectContaining({ type: 'image_url' }),
                  expect.objectContaining({ type: 'text' }),
                ],
              },
            ],
          });
          expect(init?.headers).not.toHaveProperty('authorization');
        } else {
          expect(body).toMatchObject({ model: 'unchanged-document-model' });
          expect(body).not.toHaveProperty('reasoning_effort');
          expect(body).not.toHaveProperty('max_tokens');
          expect(init?.headers).toMatchObject({ authorization: 'Bearer document-only-key' });
        }
        return Promise.resolve(answer());
      });
      await receipts.extractFields(receiptSchema, '', [{ bytes: Buffer.from('receipt-jpeg') }]);
      await documents.extractFields(receiptSchema, 'document');
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        'http://ollama.example:11434/v1/chat/completions',
        'https://documents.example/v1/chat/completions',
      ]);
    } finally {
      await module.close();
    }
  });

  it('preserves the legacy client until a dedicated receipt provider is explicitly configured', async () => {
    const module = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        {
          module: Dependencies,
          providers: [
            {
              provide: AppConfig,
              useValue: config({ RECEIPT_API_BASE_URL: '', RECEIPT_MODEL: '' }),
            },
            { provide: ServiceGates, useValue: new ServiceGates(new FixedClock()) },
          ],
          exports: [AppConfig, ServiceGates],
        },
        AiModule,
      ],
    }).compile();
    try {
      expect(module.get(ReceiptExtractor)).toBe(module.get(DocumentAnalyst));
    } finally {
      await module.close();
    }
  });

  it('never borrows a cloud API key for the dedicated receipt endpoint', () => {
    expect(serviceEndpoint(config(), 'receipt-extractor')).toEqual({
      baseUrl: 'http://ollama.example:11434/v1',
      apiKey: '',
    });
    expect(
      serviceEndpoint(config({ RECEIPT_API_KEY: 'receipt-only' }), 'receipt-extractor').apiKey,
    ).toBe('receipt-only');
  });

  it.each([{ RECEIPT_MODEL: '' }, { RECEIPT_API_BASE_URL: '' }])(
    'does not silently fall back when dedicated settings are incomplete: %o',
    (extra) => {
      expect(
        new OpenAiCompatAnalyst(
          config(extra),
          new ServiceGates(new FixedClock()),
          'receipt-extractor',
        ).isConfigured,
      ).toBe(false);
    },
  );

  it('keeps receipt calls independent of a throttled document provider', async () => {
    const now = new Date('2026-09-10T12:00:00Z');
    vi.useFakeTimers({ now });
    const gates = new ServiceGates(new FixedClock(now));
    gates.configure({
      ...ungatedServices(),
      'receipt-extractor': { concurrency: 1, cooldownSeconds: 0 },
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '60' } }))
      .mockResolvedValueOnce(answer());
    const documents = new OpenAiCompatAnalyst(config(), gates);
    const receipts = new OpenAiCompatAnalyst(config(), gates, 'receipt-extractor');
    await expect(documents.extractFields(receiptSchema, '')).rejects.toBeInstanceOf(
      ServiceThrottledError,
    );
    expect((await receipts.extractFields(receiptSchema, '')).values.vendor).toBe('Test Shop');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      gates.snapshot().find((gate) => gate.service === 'receipt-extractor')?.throttledUntil,
    ).toBeNull();
  });

  it('keeps document calls independent of a throttled receipt provider', async () => {
    const now = new Date('2026-09-10T12:00:00Z');
    vi.useFakeTimers({ now });
    const gates = new ServiceGates(new FixedClock(now));
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '60' } }))
      .mockResolvedValueOnce(answer());
    const receipts = new OpenAiCompatAnalyst(config(), gates, 'receipt-extractor');
    const documents = new OpenAiCompatAnalyst(config(), gates);
    await expect(receipts.extractFields(receiptSchema, '')).rejects.toMatchObject({
      service: 'receipt-extractor',
    });
    expect((await documents.extractFields(receiptSchema, '')).values.vendor).toBe('Test Shop');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      gates.snapshot().find((gate) => gate.service === 'classifier')?.throttledUntil,
    ).toBeNull();
  });

  it.each(['', '{}', 'no JSON', '[]'])(
    'does not mark an empty or malformed response as a successful receipt: %s',
    async (content) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer(content));
      const receipts = new OpenAiCompatAnalyst(
        config(),
        new ServiceGates(new FixedClock()),
        'receipt-extractor',
      );
      await expect(receipts.extractFields(receiptSchema, '')).rejects.toThrow(
        'no structured fields',
      );
    },
  );

  it('rejects a truncated response even if its partial JSON is valid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        choices: [
          {
            message: { content: '{"vendor":"Test Shop"}' },
            finish_reason: 'length',
          },
        ],
      }),
    );
    const receipts = new OpenAiCompatAnalyst(
      config(),
      new ServiceGates(new FixedClock()),
      'receipt-extractor',
    );
    await expect(receipts.extractFields(receiptSchema, '')).rejects.toThrow('truncated');
  });
});
