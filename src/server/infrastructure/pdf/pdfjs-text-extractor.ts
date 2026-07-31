import { Injectable } from '@nestjs/common';
import { toBuffer, type BinarySource } from '../../application/ports/binary-source';
import { TextExtractor } from '../../application/ports/text-extractor';

// pdfjs-dist ships ESM only, while the production server is compiled to CommonJS (docs/12 §12.3),
// where a static import of it fails to resolve at runtime. A dynamic import works under both module
// systems; it is cached so the library is loaded once per process rather than once per document.
type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsModule: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsModule ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModule;
}

@Injectable()
export class PdfjsTextExtractor extends TextExtractor {
  async pdfTextByPage(source: BinarySource): Promise<string[]> {
    const { getDocument, VerbosityLevel } = await loadPdfjs();
    const bytes = new Uint8Array(await toBuffer(source));

    const document = await getDocument({
      data: bytes,
      // pdfjs writes its warnings straight to the console, which would bypass our structured logger
      // for every document processed — and most of them ("standardFontDataUrl not provided") are
      // about rendering, which extraction does not do. Errors still surface as a rejection.
      verbosity: VerbosityLevel.ERRORS,
      // 🔒 Nothing in a library file may be executed: PDFs can carry JavaScript, and the documents
      // here come from whatever the user dropped on the volume.
      isEvalSupported: false,
      // Text extraction needs no glyph rendering, so neither system fonts nor the standard font data
      // have to be found on disk.
      useSystemFonts: false,
    }).promise;

    try {
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        // Marked-content items carry structure, not text; only the items with a `str` are words.
        const text = content.items
          .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ''}` : ''))
          .join('');
        pages.push(text);
        page.cleanup();
      }
      return pages;
    } finally {
      // The document holds a worker and its buffers until destroyed; a leak here would accumulate
      // across every processed document in a long-running process.
      await document.destroy();
    }
  }
}
