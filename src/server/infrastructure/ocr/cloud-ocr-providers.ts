import { createSign } from 'node:crypto';
import { z } from 'zod';
import type { OcrIdentity, OcrImage, OcrOptions } from '../../application/ports/page-ocr-provider';
import { PageOcrProvider, OcrProviderError } from '../../application/ports/page-ocr-provider';
import { readBoundedJson } from '../../application/ports/binary-source';
import {
  ServiceUnavailableError,
  throttledOrUnavailable,
} from '../../application/ports/service-unavailable';
import type { ServiceName } from '../../../shared/contracts/queue';
import type { ServiceGates } from '../../application/queue/service-gate';
import { normalizeGoogle, normalizeYandex } from './normalize-ocr';

export type GoogleOcrConfig = {
  project: string;
  location: string;
  processor: string;
  version: string;
  credentials: string;
};
const credentialSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

async function requestJson(
  fetcher: typeof fetch,
  service: ServiceName,
  url: string,
  body: object,
  authorization: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
  } catch {
    throw new ServiceUnavailableError(
      service,
      'OCR request interrupted; the provider may have billed this page',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429)
      throw throttledOrUnavailable(service, response.headers.get('retry-after'));
    if (response.status >= 500 || response.status === 408)
      throw new ServiceUnavailableError(service, `OCR HTTP ${response.status}`);
    throw new OcrProviderError(
      `OCR HTTP ${response.status}; check provider credentials, processor and input limits`,
      false,
    );
  }
  try {
    return await readBoundedJson(response, 32 * 1024 * 1024);
  } catch {
    throw new OcrProviderError(
      'The OCR provider returned an invalid or oversized JSON response',
      false,
    );
  }
}

export class GoogleDocumentOcr extends PageOcrProvider {
  readonly id = 'google-document-ai' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  constructor(
    private readonly config: GoogleOcrConfig,
    private readonly gates: ServiceGates,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super();
  }
  describe() {
    return {
      id: this.id,
      configured: Object.values(this.config).every((value) => value !== ''),
      model: `projects/${this.config.project}/locations/${this.config.location}/processors/${this.config.processor}/processorVersions/${this.config.version}`,
    };
  }
  async recognize(
    image: OcrImage,
    options: OcrOptions,
    beforeSubmit?: () => Promise<void>,
  ): Promise<unknown> {
    if (!this.describe().configured)
      throw new OcrProviderError('Google Document AI is not configured', false);
    const match =
      /^projects\/([\w-]+)\/locations\/(eu|us)\/processors\/([\w-]+)\/processorVersions\/([\w.-]+)$/.exec(
        options.model,
      );
    if (match === null)
      throw new OcrProviderError('Invalid Google OCR processor version resource', false);
    const url = `https://${match[2]}-documentai.googleapis.com/v1/${options.model}:process`;
    return this.gates.run(this.id, async () => {
      const token = await this.accessToken();
      await beforeSubmit?.();
      return requestJson(
        this.fetcher,
        this.id,
        url,
        {
          rawDocument: { content: image.bytes.toString('base64'), mimeType: 'image/png' },
          // Include the processed image geometry and transforms needed to restore input coordinates.
          fieldMask:
            'text,pages.pageNumber,pages.image,pages.dimension,pages.transforms,pages.blocks,pages.lines,pages.tokens,pages.imageQualityScores,error',
          processOptions: {
            ocrConfig: {
              enableImageQualityScores: true,
              hints: { languageHints: options.languages },
            },
          },
        },
        `Bearer ${token}`,
      );
    });
  }
  normalize(raw: unknown, input: OcrIdentity) {
    return normalizeGoogle(raw, input);
  }
  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    if (this.refreshing !== null) return this.refreshing;
    this.refreshing = this.refreshToken();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }
  private async refreshToken(): Promise<string> {
    let credentials: z.infer<typeof credentialSchema>;
    try {
      credentials = credentialSchema.parse(JSON.parse(this.config.credentials));
    } catch {
      throw new OcrProviderError('Invalid Google service-account credentials', false);
    }
    const at = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credentials.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: at, exp: at + 3600 })}`;
    let assertion: string;
    try {
      assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credentials.private_key, 'base64url')}`;
    } catch {
      throw new OcrProviderError('Invalid Google service-account signing key', false);
    }
    let response: Response;
    try {
      response = await this.fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      });
    } catch {
      throw new ServiceUnavailableError(this.id, 'Google token endpoint did not answer');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new OcrProviderError(
        `Google authentication HTTP ${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }
    let token: z.infer<typeof tokenSchema>;
    try {
      token = tokenSchema.parse(await readBoundedJson(response, 64 * 1024));
    } catch {
      throw new OcrProviderError('Google authentication returned an invalid response', false);
    }
    this.token = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}

export class YandexVisionOcr extends PageOcrProvider {
  readonly id = 'yandex-vision' as const;
  constructor(
    private readonly apiKey: string,
    private readonly gates: ServiceGates,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    super();
  }
  describe() {
    return { id: this.id, configured: this.apiKey !== '', model: 'page' };
  }
  async recognize(
    image: OcrImage,
    options: OcrOptions,
    beforeSubmit?: () => Promise<void>,
  ): Promise<unknown> {
    if (!this.describe().configured)
      throw new OcrProviderError('Yandex Vision OCR is not configured', false);
    const languages = [
      ...new Set(options.languages.map((language) => language.split('-')[0] ?? language)),
    ];
    return this.gates.run(this.id, async () => {
      await beforeSubmit?.();
      return requestJson(
        this.fetcher,
        this.id,
        'https://ai.api.cloud.yandex.net/ocr/v1/recognizeText',
        {
          content: image.bytes.toString('base64'),
          mimeType: 'image/png',
          model: options.model,
          languageCodes: languages.length === 0 ? ['*'] : languages,
        },
        `Api-Key ${this.apiKey}`,
      );
    });
  }
  normalize(raw: unknown, input: OcrIdentity) {
    return normalizeYandex(raw, input);
  }
}
