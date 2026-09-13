import { Injectable } from '@nestjs/common';
import { Readable } from 'node:stream';
import { MimeDetector, type DetectedType } from '../../application/ports/mime-detector';
import { chunkToBuffer, MAX_BINARY_BYTES } from '../../application/ports/binary-source';

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
//
// 🔒 Which means what comes out of here below the magic-byte line is the uploader's own claim about
// their file — `report.html` is `text/html` because it is called that. That claim is good enough to
// decide how a document is converted and what its row displays; it is never good enough to decide
// what a browser is told the bytes are. Serving normalizes it against a render allow-list, at the
// two ends of the object's life (`servableContentType`, docs/09 §9.2, SEC-03).
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
  async detect(
    head: Uint8Array,
    fileName: string,
    openSource?: () => Promise<Readable>,
  ): Promise<DetectedType> {
    // file-type reads through a tokenizer and throws End-Of-Stream when a signature it recognises is
    // truncated — a two-byte file must fall through to the extension, not fail the ingest.
    const { fileTypeFromBuffer, fileTypeFromStream } = await loadFileType();
    let detected = await fileTypeFromBuffer(head).catch(() => undefined);
    // A DOCX is a ZIP package; its content-types entry can follow a large embedded picture.
    // Ingest hashes without retaining the file. Only an ambiguous ZIP needs another streaming read.
    if (detected?.mime === 'application/zip' && openSource !== undefined) {
      const source = await openSource();
      const bounded = Readable.from(boundedChunks(source));
      try {
        detected = (await fileTypeFromStream(Readable.toWeb(bounded))) ?? detected;
      } finally {
        bounded.destroy();
        source.destroy();
      }
    }
    if (detected !== undefined) {
      // CFB is shared by legacy Office formats. Only a CFB file actually named .doc enters Word;
      // arbitrary bytes and ordinary ZIPs cannot acquire Office support by being renamed.
      if (detected.mime === 'application/x-cfb' && extensionOf(fileName) === 'doc') {
        return { mime: 'application/msword', ext: 'doc' };
      }
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

async function* boundedChunks(source: Readable): AsyncGenerator<Buffer> {
  let size = 0;
  for await (const chunk of source) {
    const bytes = chunkToBuffer(chunk);
    size += bytes.byteLength;
    if (size > MAX_BINARY_BYTES) throw new Error('File exceeds the format detection byte limit');
    yield bytes;
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
