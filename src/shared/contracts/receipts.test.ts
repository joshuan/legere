import { describe, expect, it } from 'vitest';
import { DEFAULT_RECEIPT_SORT, listReceiptsQuerySchema } from './receipts';

describe('receipt list query', () => {
  it('defaults to the purchase-date order and normalises ISO codes and numeric bounds', () => {
    expect(
      listReceiptsQuerySchema.parse({
        q: '  voli  ',
        country: 'me',
        currency: 'eur',
        amountMin: '10.25',
        amountMax: '40',
        purchasedFrom: '2026-01-01',
        purchasedTo: '2026-01-31',
      }),
    ).toMatchObject({
      limit: 30,
      sort: DEFAULT_RECEIPT_SORT,
      q: 'voli',
      country: 'ME',
      currency: 'EUR',
      amountMin: 10.25,
      amountMax: 40,
      purchasedFrom: '2026-01-01',
      purchasedTo: '2026-01-31',
    });
  });

  it('refuses reversed ranges and days that do not exist', () => {
    expect(
      listReceiptsQuerySchema.safeParse({
        purchasedFrom: '2026-02-20',
        purchasedTo: '2026-02-10',
      }).success,
    ).toBe(false);
    expect(listReceiptsQuerySchema.safeParse({ amountMin: '20', amountMax: '10' }).success).toBe(
      false,
    );
    expect(listReceiptsQuerySchema.safeParse({ purchasedFrom: '2026-02-31' }).success).toBe(false);
  });
});
