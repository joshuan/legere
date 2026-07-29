// RelativePath (docs/06 §6.2): the only way a library-relative path is represented in the domain.
//
// 🔒 Traversal guard (docs/05 §5.1, docs/09 §9.1). Construction rejects anything that could escape the
// library root — absolute paths, `..` segments, Windows drive letters, UNC prefixes and NUL bytes —
// so no caller can hand the filesystem a path that leaves the volume. Separators are normalized to
// `/` and redundant ones collapsed, which also makes the value comparable and storable as-is.
export class RelativePathError extends Error {}

export class RelativePath {
  // Private so the only way to obtain one is through the validating factories.
  private constructor(readonly value: string) {}

  static root(): RelativePath {
    return new RelativePath('');
  }

  static parse(raw: string): RelativePath {
    if (raw.includes('\0')) throw new RelativePathError('Path must not contain NUL bytes');

    // Windows drive letters (C:\…) and UNC paths (\\server\share) are absolute references.
    if (/^[a-zA-Z]:/.test(raw)) throw new RelativePathError('Path must be relative');

    const unified = raw.replace(/\\/g, '/');
    if (unified.startsWith('/')) throw new RelativePathError('Path must be relative');

    const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');
    for (const segment of segments) {
      if (segment === '..') throw new RelativePathError('Path must not traverse upwards');
    }

    return new RelativePath(segments.join('/'));
  }

  // Same validation, but returns null instead of throwing — for callers filtering untrusted input.
  static tryParse(raw: string): RelativePath | null {
    try {
      return RelativePath.parse(raw);
    } catch {
      return null;
    }
  }

  get isRoot(): boolean {
    return this.value === '';
  }

  get segments(): string[] {
    return this.isRoot ? [] : this.value.split('/');
  }

  // Last segment — the file or directory name.
  get name(): string {
    return this.segments.at(-1) ?? '';
  }

  // Everything before the last segment; the root's parent is the root.
  get parent(): RelativePath {
    const segments = this.segments;
    return segments.length <= 1
      ? RelativePath.root()
      : new RelativePath(segments.slice(0, -1).join('/'));
  }

  // Lower-cased extension without the dot, or '' when the name has none. A leading dot means a
  // hidden file rather than an extension (`.env` has no extension).
  get extension(): string {
    const name = this.name;
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  }

  // Name without its extension; the initial title of a document comes from this (docs/03 §3.3.10).
  get stem(): string {
    const name = this.name;
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? name : name.slice(0, dot);
  }

  // Appending re-validates, so a child can never escape its parent.
  join(...parts: string[]): RelativePath {
    const combined = [this.value, ...parts].filter((part) => part !== '').join('/');
    return RelativePath.parse(combined);
  }

  equals(other: RelativePath): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
