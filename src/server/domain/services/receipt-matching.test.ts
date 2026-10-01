import { describe, expect, it } from 'vitest';
import type { ReceiptExtraction } from '../../../shared/contracts/receipts';
import { matchReceipts } from './receipt-matching';

const facts = { purchasedAt: '2026-09-30', total: { amount: 12.4, currency: 'EUR' } };
const lines = [
  { name: 'Fresh milk', quantity: 2, amount: 4.4 },
  { name: 'Bread', quantity: 1, amount: 8 },
];
function extracted(values: Record<string, unknown>): ReceiptExtraction {
  return {
    schema: { slug: 'receipt', version: 3 },
    values: { ...facts, ...values },
    confidence: 99,
  };
}

describe('receipt matching by purchase facts', () => {
  it('never treats date and total alone, missing facts or currency changes as a match', () => {
    for (const [first, second] of [
      [extracted({}), extracted({})],
      [null, null],
      [extracted({ vendor: 'Voli', purchasedAt: null }), extracted({ vendor: 'Voli' })],
      [
        extracted({ vendor: 'Voli', purchasedAt: '2026-02-30' }),
        extracted({ vendor: 'Voli', purchasedAt: '2026-02-30' }),
      ],
      [
        extracted({ vendor: 'Voli', total: { amount: 12.4, currency: 'USD' } }),
        extracted({ vendor: 'Voli' }),
      ],
      [
        extracted({ vendor: 'Voli', total: { amount: 12.5, currency: 'EUR' } }),
        extracted({ vendor: 'Voli' }),
      ],
    ])
      expect(matchReceipts(first ?? null, second ?? null).kind).toBe('manual');
  });

  it('recognizes a re-photographed receipt using complete item lines, ignoring order and punctuation', () => {
    const match = matchReceipts(
      extracted({ vendor: 'VÓLI d.o.o.', items: lines }),
      extracted({
        statementDescriptor: 'POS VOLI 021',
        items: [lines[1], { name: 'Fresh-Milk', quantity: 2, amount: 4.4 }],
      }),
    );
    expect(match).toEqual({
      kind: 'duplicate',
      reasons: ['date', 'total', 'merchant', 'items'],
      conflicts: [],
    });
  });

  it('recognizes a fiscal receipt and its bank slip as complementary parts', () => {
    const match = matchReceipts(
      extracted({ vendor: 'Voli', purchasedTime: '17:42', card: '****1234', items: lines }),
      extracted({
        vendor: 'Bank terminal',
        statementDescriptor: 'VOLI MARKET',
        purchasedTime: '17:44',
        card: '•••• 1234',
      }),
    );
    expect(match.kind).toBe('parts');
    expect(match.reasons).toEqual(['date', 'total', 'merchant', 'time', 'card']);
    expect(match.conflicts).toEqual([]);
  });

  it('can connect different merchant spellings through tax ID or card plus time', () => {
    expect(
      matchReceipts(
        extracted({ vendor: 'Воли', vendorTaxId: '12-34567', receiptNumber: 'AB-321' }),
        extracted({ vendor: 'Voli', vendorTaxId: '1234567', receiptNumber: 'ab 321' }),
      ).kind,
    ).toBe('duplicate');
    expect(
      matchReceipts(
        extracted({ vendor: 'Воли', card: '****1234', purchasedTime: '12:10', items: lines }),
        extracted({ vendor: 'Voli', card: '1234', purchasedTime: '12:11' }),
      ).kind,
    ).toBe('parts');
  });

  it('does not use a common city, legal suffix or unknown vendor as identity', () => {
    for (const [a, b] of [
      ['Bakery Belgrade', 'Pharmacy Belgrade'],
      ['Unknown', 'unknown'],
      ['LLC', 'LLC'],
    ]) {
      expect(matchReceipts(extracted({ vendor: a }), extracted({ vendor: b })).kind).toBe('manual');
    }
  });

  it('keeps repeated same-price purchases tentative and reports conflicting facts', () => {
    const match = matchReceipts(
      extracted({
        vendor: 'Voli',
        receiptNumber: 'A12',
        card: '1234',
        vendorTaxId: '12345',
        items: lines,
      }),
      extracted({
        vendor: 'Voli',
        receiptNumber: 'B12',
        card: '5678',
        vendorTaxId: '56789',
        items: [{ name: 'Tea', quantity: 1, amount: 12.4 }],
      }),
    );
    expect(match.kind).toBe('possible');
    expect(match.conflicts).toEqual(['taxId', 'number', 'card', 'items']);
  });

  it('rejects purchases far apart in time unless a receipt identifier agrees', () => {
    expect(
      matchReceipts(
        extracted({ vendor: 'Voli', purchasedTime: '08:00' }),
        extracted({ vendor: 'Voli', purchasedTime: '20:00' }),
      ).kind,
    ).toBe('manual');
    const match = matchReceipts(
      extracted({ vendor: 'Voli', receiptNumber: 'ABC123', purchasedTime: '08:00' }),
      extracted({ vendor: 'Voli', receiptNumber: 'ABC123', purchasedTime: '20:00' }),
    );
    expect(match.kind).toBe('duplicate');
    expect(match.conflicts).toContain('time');
  });

  it('does not invent equal item sets from incomplete or partially matching extraction', () => {
    for (const items of [
      [{ name: 'Bread' }],
      [{ name: 'Bread', quantity: 1, amount: { amount: 12.4, currency: 'EUR' } }],
      [],
    ]) {
      expect(
        matchReceipts(extracted({ vendor: 'Voli', items }), extracted({ vendor: 'Voli', items }))
          .kind,
      ).toBe('possible');
    }
  });
});
