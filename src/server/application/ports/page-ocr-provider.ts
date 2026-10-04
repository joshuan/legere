import type { OcrProviderDto, OcrProviderId, OcrResult } from '../../../shared/contracts/page-ocr';

export type OcrImage = { bytes: Buffer; width: number; height: number; hash: string; dpi: number };
export type OcrOptions = { model: string; languages: string[] };
export type OcrIdentity = {
  pageId: string;
  imageHash: string;
  width: number;
  height: number;
  model: string;
};

export abstract class PageOcrProvider {
  abstract readonly id: OcrProviderId;
  abstract describe(): OcrProviderDto;
  // Called immediately before the billable HTTP request, after gate admission and authentication.
  abstract recognize(
    image: OcrImage,
    options: OcrOptions,
    beforeSubmit?: () => Promise<void>,
  ): Promise<unknown>;
  abstract normalize(raw: unknown, input: OcrIdentity): OcrResult;
}

export class OcrProviders {
  constructor(private readonly providers: readonly PageOcrProvider[]) {}
  list(): OcrProviderDto[] {
    return this.providers.map((provider) => provider.describe());
  }
  get(id: OcrProviderId): PageOcrProvider {
    const provider = this.providers.find((item) => item.id === id);
    if (provider === undefined) throw new Error('Unknown OCR provider');
    return provider;
  }
}

export abstract class OcrPageRenderer {
  abstract render(sourceKey: string, page: number): Promise<OcrImage>;
}

export class OcrProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
