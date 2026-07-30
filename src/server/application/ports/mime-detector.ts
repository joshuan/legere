// Format detection (docs/06 §6.3.3). Content decides, not the file name: a .pdf that is really a JPEG
// must be processed as a JPEG (docs/03 §3.3.10 — "detected from content (magic bytes), not from the
// extension"). The file name is passed only for the text fallback, where there are no magic bytes.
export type DetectedType = {
  mime: string;
  ext: string;
};

export abstract class MimeDetector {
  abstract detect(head: Uint8Array, fileName: string): Promise<DetectedType>;
}
