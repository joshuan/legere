import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FixedClock } from '../../../../test/helpers/fakes';
import { ServiceGates } from '../../application/queue/service-gate';
import {
  ServiceThrottledError,
  ServiceUnavailableError,
} from '../../application/ports/service-unavailable';
import { OcrProviderError } from '../../application/ports/page-ocr-provider';
import { GoogleDocumentOcr, YandexVisionOcr } from './cloud-ocr-providers';

const image = { bytes: Buffer.from('png'), hash: 'hash', width: 100, height: 200, dpi: 300 };
const options = { model: 'page', languages: ['ru-RU', 'en', 'ru'] };
function bodyText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected JSON string body');
  return value;
}
const gates = () => new ServiceGates(new FixedClock());

describe('cloud OCR REST adapters', () => {
  it('checks the durable submission fence before sending billable work', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    const provider = new YandexVisionOcr('key', gates(), fetcher);
    const before = vi.fn(() => Promise.reject(new Error('lease lost')));
    await expect(provider.recognize(image, options, before)).rejects.toThrow('lease lost');
    expect(before).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends the raster and chosen Yandex model with server-side API-key auth', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ textAnnotation: {} }));
    const provider = new YandexVisionOcr('private-key', gates(), fetcher);
    await provider.recognize(image, { ...options, model: 'table' });
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://ai.api.cloud.yandex.net/ocr/v1/recognizeText');
    expect(request?.headers).toMatchObject({ Authorization: 'Api-Key private-key' });
    expect(JSON.parse(bodyText(request?.body))).toEqual({
      content: image.bytes.toString('base64'),
      mimeType: 'image/png',
      languageCodes: ['ru', 'en'],
      model: 'table',
    });
  });
  it('uses automatic language detection when no language is known', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    await new YandexVisionOcr('key', gates(), fetcher).recognize(image, {
      model: 'handwritten',
      languages: [],
    });
    expect(bodyText(fetcher.mock.calls[0]?.[1]?.body)).toContain('"languageCodes":["*"]');
  });
  it.each([400, 401, 403, 404])(
    'settles HTTP %s without leaking response text or keys',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('private document text', { status }));
      const promise = new YandexVisionOcr('secret', gates(), fetcher).recognize(image, options);
      await expect(promise).rejects.toMatchObject({
        retryable: false,
        message: `OCR HTTP ${status}; check provider credentials, processor and input limits`,
      });
    },
  );
  it.each([408, 500, 502, 503])('retries HTTP %s as an availability failure', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(
      new YandexVisionOcr('key', gates(), fetcher).recognize(image, options),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
  it('honors Retry-After and marks interrupted requests as potentially billed', async () => {
    const throttled = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } }));
    await expect(
      new YandexVisionOcr('key', gates(), throttled).recognize(image, options),
    ).rejects.toBeInstanceOf(ServiceThrottledError);
    const interrupted = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      new YandexVisionOcr('key', gates(), interrupted).recognize(image, options),
    ).rejects.toThrow('may have billed');
  });
  it('rejects missing configuration and malformed provider JSON', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('not json'));
    await expect(
      new YandexVisionOcr('', gates(), fetcher).recognize(image, options),
    ).rejects.toBeInstanceOf(OcrProviderError);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      new YandexVisionOcr('key', gates(), fetcher).recognize(image, options),
    ).rejects.toThrow('invalid or oversized');
  });
  it('exchanges a signed service-account assertion and reuses its token with the pinned processor resource', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: 'access', expires_in: 3600 }))
      .mockImplementation(() => Promise.resolve(Response.json({ document: { pages: [] } })));
    const provider = new GoogleDocumentOcr(
      {
        project: 'current-project',
        processor: 'current-processor',
        location: 'us',
        version: 'new-version',
        credentials: JSON.stringify({ client_email: 'ocr@example.test', private_key: privateKey }),
      },
      gates(),
      fetcher,
    );
    const model =
      'projects/saved-project/locations/eu/processors/saved-processor/processorVersions/pretrained-ocr-v2.1-2024-08-07';
    await provider.recognize(image, { model, languages: ['ru', 'en'] });
    await provider.recognize(image, { model, languages: [] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const body = fetcher.mock.calls[0]?.[1]?.body;
    if (!(body instanceof URLSearchParams)) throw new Error('Missing OAuth form');
    const payload = body.get('assertion')?.split('.')[1];
    if (payload === undefined) throw new Error('Missing JWT payload');
    expect(
      z
        .object({ iss: z.string(), aud: z.string() })
        .parse(JSON.parse(Buffer.from(payload, 'base64url').toString())),
    ).toEqual({ iss: 'ocr@example.test', aud: 'https://oauth2.googleapis.com/token' });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      `https://eu-documentai.googleapis.com/v1/${model}:process`,
    );
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer access' });
    const sent = z
      .object({
        rawDocument: z.object({ mimeType: z.string(), content: z.string() }),
        fieldMask: z.string(),
      })
      .parse(JSON.parse(bodyText(fetcher.mock.calls[1]?.[1]?.body)));
    expect(sent.rawDocument).toEqual({
      mimeType: 'image/png',
      content: image.bytes.toString('base64'),
    });
    expect(sent.fieldMask).toContain('pages.transforms');
  });
  it('fails closed on a non-resource processor name and malformed credentials', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new GoogleDocumentOcr(
      {
        project: 'p',
        processor: 'p',
        location: 'eu',
        version: 'v1',
        credentials: 'secret invalid json',
      },
      gates(),
      fetcher,
    );
    await expect(provider.recognize(image, options)).rejects.toThrow('processor version resource');
    await expect(
      provider.recognize(image, { ...options, model: provider.describe().model }),
    ).rejects.toThrow('Invalid Google service-account credentials');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
