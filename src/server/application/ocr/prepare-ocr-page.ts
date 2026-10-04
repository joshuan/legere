import type { PageOcrRepository } from '../../domain/repositories/page-ocr.repository';
import type { FileStorage } from '../ports/file-storage';
import type { OcrImage, OcrPageRenderer } from '../ports/page-ocr-provider';
import { toBuffer } from '../ports/binary-source';

export class PrepareOcrPage {
  private readonly pending = new Map<string, Promise<OcrImage & { key: string }>>();
  constructor(
    private readonly repository: PageOcrRepository,
    private readonly renderer: OcrPageRenderer,
    private readonly files: FileStorage,
  ) {}
  async execute(
    documentId: string,
    canonicalKey: string,
    pageId: string,
    pageNumber: number,
  ): Promise<OcrImage & { key: string }> {
    const identity = JSON.stringify([documentId, canonicalKey, pageId]);
    const active = this.pending.get(identity);
    if (active !== undefined) return active;
    const work = this.prepare(documentId, canonicalKey, pageId, pageNumber);
    this.pending.set(identity, work);
    try {
      return await work;
    } finally {
      this.pending.delete(identity);
    }
  }
  private async prepare(
    documentId: string,
    canonicalKey: string,
    pageId: string,
    pageNumber: number,
  ): Promise<OcrImage & { key: string }> {
    let saved = await this.repository.findImage(documentId, canonicalKey, pageId);
    if (saved === null) {
      const rendered = await this.renderer.render(canonicalKey, pageNumber);
      const key = `documents/${documentId}/ocr/images/${rendered.hash}.png`;
      await this.files.put(key, rendered.bytes, 'image/png');
      saved = await this.repository.saveImage({
        documentId,
        canonicalKey,
        pageId,
        imageKey: key,
        imageHash: rendered.hash,
        width: rendered.width,
        height: rendered.height,
        dpi: rendered.dpi,
      });
    }
    return {
      bytes: await toBuffer(await this.files.getStream(saved.imageKey), 9_000_000),
      key: saved.imageKey,
      hash: saved.imageHash,
      width: saved.width,
      height: saved.height,
      dpi: saved.dpi,
    };
  }
}
