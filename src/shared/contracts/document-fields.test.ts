import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_FIELD_SCHEMAS,
  extractedSearchTextOf,
  fieldSchemaFor,
  sanitizeFieldValues,
  summaryValuesOf,
  validateFieldValue,
  validateFieldsPatch,
} from './document-fields';

const receipt = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'receipt');
if (receipt === undefined) throw new Error('The receipt schema left the registry');

const spec = (key: string) => {
  const found = receipt.fields.find((field) => field.key === key);
  if (found === undefined) throw new Error(`No field ${key} on the receipt schema`);
  return found;
};

describe('fieldSchemaFor (docs/03 §3.3.10a)', () => {
  it('answers the schema of a slug that carries one, and null for the rest', () => {
    expect(fieldSchemaFor('receipt')?.typeSlug).toBe('receipt');
    expect(fieldSchemaFor('passport')?.typeSlug).toBe('passport');
    expect(fieldSchemaFor('id-card')?.typeSlug).toBe('id-card');
    expect(fieldSchemaFor('contract')).toBeNull();
    expect(fieldSchemaFor(null)).toBeNull();
    expect(fieldSchemaFor(undefined)).toBeNull();
  });
});

describe('validateFieldValue — per field, in code (docs/03 §3.3.10a)', () => {
  it('keeps a real calendar day and drops what only looks like one', () => {
    expect(validateFieldValue(spec('purchasedAt'), '2026-05-12')).toBe('2026-05-12');
    // Parses as a string and means nothing — the documentDate rule.
    expect(validateFieldValue(spec('purchasedAt'), '2026-02-31')).toBeUndefined();
    expect(validateFieldValue(spec('purchasedAt'), '12.05.2026')).toBeUndefined();
    expect(validateFieldValue(spec('purchasedAt'), '0026-05-12')).toBeUndefined();
  });

  it('reads money as one fact and normalizes what a model prints', () => {
    expect(validateFieldValue(spec('total'), { amount: 12.4, currency: 'EUR' })).toEqual({
      amount: 12.4,
      currency: 'EUR',
    });
    // "12,40" and "eur" are how receipts and models write it; the value is still the value.
    expect(validateFieldValue(spec('total'), { amount: '12,40', currency: 'eur' })).toEqual({
      amount: 12.4,
      currency: 'EUR',
    });
    expect(validateFieldValue(spec('total'), { amount: 'a lot', currency: 'EUR' })).toBeUndefined();
    expect(validateFieldValue(spec('total'), { amount: 5 })).toBeUndefined();
  });

  it('validates a table row by row and keeps the rows that parse', () => {
    const rows = validateFieldValue(spec('items'), [
      { name: 'Bread', quantity: 1, amount: 1.2 },
      { name: '', quantity: 'x' },
      'not a row',
      { name: 'Milk', quantity: '2', amount: '2,40' },
    ]);
    expect(rows).toEqual([
      { name: 'Bread', quantity: 1, amount: 1.2 },
      { name: 'Milk', quantity: 2, amount: 2.4 },
    ]);
  });
});

describe('sanitizeFieldValues', () => {
  it('drops an invented value without discarding the good one beside it', () => {
    const values = sanitizeFieldValues(receipt, {
      vendor: '  Voli  ',
      purchasedAt: 'yesterday',
      total: { amount: 3, currency: 'EUR' },
      invented: 'never asked for',
    });
    expect(values).toEqual({ vendor: 'Voli', total: { amount: 3, currency: 'EUR' } });
  });
});

describe('validateFieldsPatch (docs/07 §7.3)', () => {
  it('accepts known keys, carries null through, and names what it refuses', () => {
    const patch = validateFieldsPatch(receipt, {
      vendor: 'Voli',
      purchasedAt: null,
      total: 'twelve',
      unknown: 1,
    });
    expect(patch.values).toEqual({ vendor: 'Voli', purchasedAt: null });
    expect(patch.issues).toEqual([
      { key: 'total', reason: 'INVALID_VALUE' },
      { key: 'unknown', reason: 'UNKNOWN_FIELD' },
    ]);
  });
});

describe('the projections (docs/04 §4.3, docs/11 §11.3)', () => {
  it('flattens searchable values — table columns included — and nothing else', () => {
    const text = extractedSearchTextOf(receipt, {
      vendor: 'Voli',
      purchasedAt: '2026-05-12',
      total: { amount: 12.4, currency: 'EUR' },
      items: [{ name: 'Bread', amount: 1.2 }, { quantity: 2 }],
    });
    expect(text).toBe('Voli\nBread');
    expect(extractedSearchTextOf(receipt, {})).toBeNull();
  });

  it('answers the summary-flagged values in schema order, or nothing at all', () => {
    const summary = summaryValuesOf(receipt, {
      total: { amount: 12.4, currency: 'EUR' },
      vendor: 'Voli',
      items: [],
    });
    expect(summary).toEqual({ vendor: 'Voli', total: { amount: 12.4, currency: 'EUR' } });
    expect(Object.keys(summary ?? {})).toEqual(['vendor', 'total']);
    expect(summaryValuesOf(receipt, {})).toBeNull();
  });
});
