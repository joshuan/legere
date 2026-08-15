import { describe, expect, it } from 'vitest';
import { linkProbeTokens, orderedPair } from './document-link';

describe('orderedPair (docs/03 §3.3.23)', () => {
  it('spells the pair one way whichever way it arrives', () => {
    expect(orderedPair('b', 'a')).toEqual({ aId: 'a', bId: 'b' });
    expect(orderedPair('a', 'b')).toEqual({ aId: 'a', bId: 'b' });
  });
});

describe('linkProbeTokens (docs/05 §5.6b)', () => {
  const bare = { title: '', markdown: null, extracted: null };

  it('reads number-bearing tokens off the title and the opening of the text', () => {
    const probes = linkProbeTokens({
      ...bare,
      title: 'Contract № 12-2019',
      markdown: 'Signed under agreement 12-2019 with account 40817810099910004312.',
    });
    expect(probes).toContain('12-2019');
    expect(probes).toContain('40817810099910004312');
  });

  it('prefers the searchable extracted identifiers, and only the string ones', () => {
    const probes = linkProbeTokens({
      ...bare,
      extracted: {
        schema: { slug: 'passport', version: 1 },
        values: { number: 'AB1234567', holder: 'Ana Petrović', birthDate: '1990-01-02' },
        sources: { number: 'AUTO', holder: 'AUTO', birthDate: 'AUTO' },
      },
    });
    // The number is an identifier; a name has no digit and a date field is not a string spec.
    expect(probes).toEqual(['AB1234567']);
  });

  it('excludes what would link half the archive to the other half', () => {
    const probes = linkProbeTokens({
      ...bare,
      title: 'Report 2019',
      // A bare year, a short run of digits, a word with no digit at all.
      markdown: 'In 2019 we paid 1234 dinars for the flat on Njegoševa.',
    });
    expect(probes).toEqual([]);
  });

  it('deduplicates case-insensitively and answers a bounded handful', () => {
    const many = Array.from({ length: 20 }, (unused, i) => `INV-10${i}`).join(' ');
    const probes = linkProbeTokens({ ...bare, markdown: `inv-100 INV-100 ${many}` });
    expect(probes.length).toBeLessThanOrEqual(8);
    expect(new Set(probes.map((p) => p.toLowerCase())).size).toBe(probes.length);
  });
});
