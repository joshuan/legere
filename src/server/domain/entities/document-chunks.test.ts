import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './document-chunks';

const options = { targetChars: 200, overlapChars: 40 };

// Chunking for embedding (docs/05 §5.9): headings and paragraphs are the seams, the target is a
// size to aim for rather than a hard limit, and the overlap keeps a sentence findable from either
// side of a boundary.
describe('chunkMarkdown', () => {
  it('keeps a short document in one chunk', () => {
    const markdown = '# Invoice\n\nAmount due: 1200.';

    expect(chunkMarkdown(markdown, options)).toEqual([markdown]);
  });

  it('has nothing to chunk in an empty document', () => {
    expect(chunkMarkdown('', options)).toEqual([]);
    expect(chunkMarkdown('   \n\n  ', options)).toEqual([]);
  });

  it('keeps a heading with the text it introduces', () => {
    const markdown = [
      `## Payment terms\n\n${'a'.repeat(150)}`,
      `## Delivery\n\n${'b'.repeat(150)}`,
    ].join('\n\n');

    const chunks = chunkMarkdown(markdown, options);

    // A chunk that is only "## Delivery" would say nothing, and one starting mid-section would
    // have lost what it was about.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.startsWith('## Payment terms')).toBe(true);
    expect(chunks[1]).toContain('## Delivery');
  });

  it('packs whole paragraphs up to the target', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `${'x'.repeat(60)}-${index}`);

    const chunks = chunkMarkdown(paragraphs.join('\n\n'), options);

    expect(chunks.length).toBeGreaterThan(1);
    // Every paragraph survives somewhere, none is lost between chunks.
    for (const paragraph of paragraphs) {
      expect(chunks.some((chunk) => chunk.includes(paragraph))).toBe(true);
    }
  });

  it('splits a paragraph longer than the target on sentence boundaries', () => {
    // A page of OCR output has no blank lines at all — this is the normal case, not the edge one.
    const sentence = `${'word '.repeat(20).trim()}. `;
    const chunks = chunkMarkdown(sentence.repeat(10).trim(), options);

    expect(chunks.length).toBeGreaterThan(1);
    // Cut at a sentence end rather than mid-word wherever the text allows it.
    expect(chunks.slice(0, -1).every((chunk) => chunk.trim().endsWith('.'))).toBe(true);
  });

  it('splits text that has no sentence boundaries at all rather than giving up', () => {
    const chunks = chunkMarkdown('x'.repeat(1000), options);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= options.targetChars)).toBe(true);
    expect(chunks.join('')).toBe('x'.repeat(1000));
  });

  it('repeats the tail of a chunk at the head of the next one', () => {
    const first = `First paragraph ending on the word anchor ${'a'.repeat(120)}`;
    const second = 'Second paragraph.';

    const chunks = chunkMarkdown(`${first}\n\n${second}`, { targetChars: 160, overlapChars: 40 });

    expect(chunks).toHaveLength(2);
    // The overlap carries the end of the previous chunk, cut at a word boundary.
    expect(chunks[1]).toContain(second);
    expect(chunks[1]?.length).toBeGreaterThan(second.length);
  });

  it('makes progress even when the overlap is configured larger than the target', () => {
    const chunks = chunkMarkdown('y'.repeat(500), { targetChars: 100, overlapChars: 400 });

    // Nonsense configuration must not loop forever or produce a chunk per character.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(20);
  });

  it('never emits an empty chunk', () => {
    const chunks = chunkMarkdown('# Title\n\n\n\nBody\n\n\n\n', options);

    expect(chunks.every((chunk) => chunk.trim() !== '')).toBe(true);
  });
});
