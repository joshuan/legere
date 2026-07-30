import { Injectable } from '@nestjs/common';
import { MimeDetector, type DetectedType } from '../../application/ports/mime-detector';

// file-type is ESM-only, while the production server is compiled to CommonJS (docs/12 §12.3), where a
// static import of it fails to resolve at runtime. A dynamic import works under both module systems;
// it is cached so the module is loaded once per process rather than per file.
type FileTypeModule = typeof import('file-type');
let fileTypeModule: Promise<FileTypeModule> | null = null;

function loadFileType(): Promise<FileTypeModule> {
  fileTypeModule ??= import('file-type');
  return fileTypeModule;
}

// Magic bytes first, extension only as a fallback for formats that have none (docs/06 §6.3.3).
// Text and Markdown are exactly that case: their content is indistinguishable from any other bytes,
// so the extension is the only signal available.
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  log: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
};

const FALLBACK: DetectedType = { mime: 'application/octet-stream', ext: '' };

@Injectable()
export class FileTypeMimeDetector extends MimeDetector {
  async detect(head: Uint8Array, fileName: string): Promise<DetectedType> {
    // file-type reads through a tokenizer and throws End-Of-Stream when a signature it recognises is
    // truncated — a two-byte file must fall through to the extension, not fail the ingest.
    const { fileTypeFromBuffer } = await loadFileType();
    const detected = await fileTypeFromBuffer(head).catch(() => undefined);
    if (detected !== undefined) {
      return { mime: detected.mime, ext: detected.ext.toLowerCase() };
    }

    const extension = extensionOf(fileName);
    const textMime = TEXT_EXTENSIONS[extension];
    if (textMime !== undefined && looksLikeText(head)) {
      return { mime: textMime, ext: extension };
    }

    // Unknown content: registered and downloadable, but the pipeline will skip its steps
    // (docs/05 §5.5). The extension is still reported when there is one, for display.
    return extension === '' ? FALLBACK : { ...FALLBACK, ext: extension };
  }
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

// A NUL byte in the head is the classic binary marker; without one, treat the extension's claim of
// being text as credible. An empty file counts as text — it has no content contradicting it.
function looksLikeText(head: Uint8Array): boolean {
  return !head.includes(0);
}
