// Splitting Markdown for embedding (docs/05 §5.9: "split on headings/paragraph boundaries targeting
// CHUNK_TARGET_CHARS with CHUNK_OVERLAP_CHARS overlap").
//
// The unit of meaning is the block — a heading with the text under it, or a paragraph. Blocks are
// packed up to the target size; the tail of one chunk is repeated at the head of the next so a
// sentence split across the boundary can still be found from either side.

export type ChunkingOptions = {
  targetChars: number;
  overlapChars: number;
};

export function chunkMarkdown(markdown: string, options: ChunkingOptions): string[] {
  const target = Math.max(1, options.targetChars);
  // Overlap must leave room for new content, or chunking would never advance.
  const overlap = Math.max(0, Math.min(options.overlapChars, Math.floor(target / 2)));

  const blocks = splitIntoBlocks(markdown).flatMap((block) => splitOversized(block, target));

  const chunks: string[] = [];
  let current = '';

  for (const block of blocks) {
    if (current === '') {
      current = block;
      continue;
    }
    if (current.length + 2 + block.length <= target) {
      current = `${current}\n\n${block}`;
      continue;
    }
    chunks.push(current);
    current = withOverlap(current, block, overlap, target);
  }

  if (current !== '') chunks.push(current);
  return chunks;
}

// A heading belongs with the text it introduces: a chunk that is just "## Payment terms" says
// nothing, and a chunk that starts mid-section loses what it was about.
function splitIntoBlocks(markdown: string): string[] {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');

  const blocks: string[] = [];
  for (const paragraph of paragraphs) {
    const previous = blocks[blocks.length - 1];
    if (previous !== undefined && isHeading(previous)) {
      blocks[blocks.length - 1] = `${previous}\n\n${paragraph}`;
      continue;
    }
    blocks.push(paragraph);
  }
  return blocks;
}

function isHeading(block: string): boolean {
  return /^#{1,6}\s/.test(block) && !block.includes('\n');
}

// A single paragraph can be longer than the whole target — a page of OCR output with no blank lines
// at all is the normal case. It is cut on sentence boundaries where possible, hard otherwise.
function splitOversized(block: string, target: number): string[] {
  if (block.length <= target) return [block];

  const pieces: string[] = [];
  let rest = block;
  while (rest.length > target) {
    const window = rest.slice(0, target);
    const cut = lastSentenceEnd(window) ?? lastWordEnd(window) ?? target;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

function lastSentenceEnd(window: string): number | null {
  const match = /[.!?][)"'”]?\s/g;
  let end: number | null = null;
  for (const found of window.matchAll(match)) {
    if (found.index !== undefined) end = found.index + found[0].length;
  }
  // Cutting at the very start would make no progress.
  return end === null || end < window.length / 2 ? null : end;
}

function lastWordEnd(window: string): number | null {
  const index = window.lastIndexOf(' ');
  return index < window.length / 2 ? null : index + 1;
}

// The overlap is taken from the end of the chunk just emitted, cut at a word boundary so the
// repeated text is readable rather than starting mid-word.
function withOverlap(previous: string, next: string, overlap: number, target: number): string {
  if (overlap === 0) return next;

  const tail = previous.slice(-overlap);
  const start = tail.search(/\s/);
  const carried = (start === -1 ? tail : tail.slice(start + 1)).trim();
  if (carried === '' || carried.length + 2 + next.length > target) return next;
  return `${carried}\n\n${next}`;
}
