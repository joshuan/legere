import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { DocumentParser, type ParseOptions } from '../../application/ports/document-parser';
import { AppConfig } from '../config/app-config';

const CONVERT = '/v1/convert/file';

// Only the field we read; the answer also carries timings and confidence scores.
const conversionSchema = z.object({
  document: z.object({ md_content: z.string().nullable() }),
});

@Injectable()
export class DoclingParser extends DocumentParser {
  private readonly baseUrl: string;
  private readonly describePictures: boolean;

  constructor(config: AppConfig) {
    super();
    this.baseUrl = config.get('DOCLING_URL').replace(/\/+$/, '');
    this.describePictures = config.get('DOCLING_PICTURE_DESCRIPTION');
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  async toMarkdown(source: BinarySource, options: ParseOptions): Promise<string> {
    if (!this.isConfigured) throw new Error('DOCLING_URL is not configured');

    const bytes = await toBuffer(source);
    const form = new FormData();
    form.append('files', new Blob([viewOf(bytes)]), 'input.pdf');
    form.append('to_formats', 'md');
    // pypdfium2 over the default parser: measured on real documents, the default splits diacritics
    // into separate glyph runs — "li č ne" instead of "lične" — which breaks the word for search as
    // well as for reading (docs/05 §5.5).
    form.append('pdf_backend', 'pypdfium2');

    if (options.ocrLanguages.length === 0) {
      // The document carries its own text: reading it is both faster and more accurate than
      // recognising a picture of it.
      form.append('do_ocr', 'false');
    } else {
      form.append('force_ocr', 'true');
      // Named explicitly: the default engine has no Cyrillic model and, asked for Russian, silently
      // falls back to its Chinese model set — returning confident-looking nonsense.
      form.append('ocr_preset', 'tesseract');
      for (const language of options.ocrLanguages) form.append('ocr_lang', language);
    }

    // A caption under every picture, from the vision model in the Docling image. Slow enough that it
    // is opt-in (docs/12 §12.4), so the flag is passed only when it is on.
    if (this.describePictures) form.append('do_picture_description', 'true');

    const response = await fetch(`${this.baseUrl}${CONVERT}`, { method: 'POST', body: form });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      // The one failure worth naming: asking for captions from an image built without the vision
      // model answers 404, and "404" alone sends nobody anywhere useful.
      const hint =
        this.describePictures && response.status === 404
          ? ' — DOCLING_PICTURE_DESCRIPTION is on; does the Docling image carry a picture-description model?'
          : '';
      throw new Error(
        `Docling ${CONVERT} failed with ${response.status}: ${detail.slice(0, 500)}${hint}`,
      );
    }

    const parsed = conversionSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Docling answered in a shape this version does not know');

    return stripImagePlaceholders(parsed.data.document.md_content ?? '');
  }
}

// Docling marks every picture it did not describe with an HTML comment. It is a note about the file,
// not text from it, and it would otherwise count towards the "does this have a text layer" measure.
// A described picture keeps the comment and gains a paragraph under it, which is text and stays.
function stripImagePlaceholders(markdown: string): string {
  return markdown.replace(/<!--\s*image\s*-->/g, '');
}

// Blob wants an ArrayBuffer; this views the same memory rather than copying the document.
function viewOf(bytes: Buffer): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (!(buffer instanceof ArrayBuffer)) return new Uint8Array(bytes).buffer;
  return buffer.slice(byteOffset, byteOffset + byteLength);
}
