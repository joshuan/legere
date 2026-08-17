import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/infrastructure/config/app-config';
import { OpenAiCompatAnalyst } from '../../src/server/infrastructure/ai/openai-compat-analyst';
import { ServiceGates } from '../../src/server/application/queue/service-gate';
import { FixedClock } from '../helpers/fakes';

// The analyst against a real model, the way the MinIO- and Stirling-backed suites work: it skips
// itself when no provider is configured, so it costs nothing in CI and is there the moment somebody
// points CLASSIFIER_API_BASE_URL at ollama or a hosted endpoint (docs/12 §12.5).
//
// It asserts the contract, not the answer. Which country a given model names is the model's
// business — what has to hold for any of them is that a live answer survives parsing and that the
// values are usable: an offered slug or null, BCP-47 tags, an upper-case alpha-2 country.
const config = loadConfig(process.env);
const configured =
  config.get('CLASSIFIER_API_BASE_URL') !== '' && config.get('CLASSIFIER_MODEL') !== '';

const CATEGORIES = [
  { slug: 'ticket', name: 'Ticket', description: 'Travel tickets and boarding passes.' },
  { slug: 'invoice', name: 'Invoice', description: 'Bills and payment requests.' },
  { slug: 'contract', name: 'Contract', description: null },
];

// A real train ticket, reduced to what Docling extracts from it. Note what is *not* in the text:
// no country is named anywhere. "ŽPCG" is the operator's abbreviation and Podgorica is a city —
// naming Montenegro from this is knowledge, not string matching.
const TICKET = [
  'Vozna karta / Ticket',
  'CIV 1062 · K-2 (online prodaja)',
  'Odlazak / Departure: 25.07.2026.',
  'PODGORICA – BEOGRAD CENTAR',
  'Razred / Class: 1. razred',
  'Voz / Train: 432, 21:20 · 25.07.2026.',
  'Cijena / Price: 21,00 EUR',
  'ŽPCG · Prevoz putnika',
].join('\n');

describe.runIf(configured)('OpenAiCompatAnalyst against a live model', () => {
  it('answers with something usable for a document that never names its country', async () => {
    const analyst = new OpenAiCompatAnalyst(config, new ServiceGates(new FixedClock()));

    const analysis = await analyst.analyze(TICKET, CATEGORIES);

    // Reported so a run tells you what the model you configured actually said.
    console.info(`[analyst] ${config.get('CLASSIFIER_MODEL')} → ${JSON.stringify(analysis)}`);

    if (analysis.typeSlug !== null) {
      expect(CATEGORIES.map((documentType) => documentType.slug)).toContain(analysis.typeSlug);
    }
    for (const tag of analysis.languages) expect(tag).toMatch(/^[a-z]{2,3}(-[A-Z][a-z]{3})?/);
    if (analysis.country !== null) expect(analysis.country).toMatch(/^[A-Z]{2}$/);
    if (analysis.city !== null) expect(analysis.city.length).toBeLessThanOrEqual(100);
    // A mark is a whole number in range or nothing at all, whatever this model chose to answer —
    // and nothing at all is the right answer here, since it was shown no pages (docs/05 §5.5
    // step 4). The contract again, not the number.
    for (const mark of [analysis.legibility, analysis.extraction]) {
      if (mark === null) continue;
      expect(Number.isInteger(mark)).toBe(true);
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(mark).toBeLessThanOrEqual(100);
    }
  }, 180_000);
});
