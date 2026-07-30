// ContentHash (docs/06 §6.2): the identity of a document's content — SHA-256, lower-case hex.
// Content equality is the deduplication rule (ADR-009), so a single canonical form matters: the same
// bytes must always produce the same key regardless of how the hash was written down.
export class ContentHashError extends Error {}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class ContentHash {
  private constructor(readonly value: string) {}

  static parse(raw: string): ContentHash {
    const normalized = raw.trim().toLowerCase();
    if (!SHA256_HEX.test(normalized)) {
      throw new ContentHashError('Content hash must be 64 hex characters (sha256)');
    }
    return new ContentHash(normalized);
  }

  static tryParse(raw: string): ContentHash | null {
    try {
      return ContentHash.parse(raw);
    } catch {
      return null;
    }
  }

  equals(other: ContentHash): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
