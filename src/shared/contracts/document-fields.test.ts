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

const flight = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'flight');
if (flight === undefined) throw new Error('The flight schema left the registry');

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
    expect(fieldSchemaFor('flight')?.typeSlug).toBe('flight');
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

// One schema for the three papers an airline prints (docs/03 §3.3.10a): the answers below are
// shaped like the e-ticket, the itinerary receipt and the boarding pass this schema was written
// from — the same booking fields throughout, and a coupon per passenger per leg.
describe('the flight schema (docs/03 §3.3.10a)', () => {
  const flightSpec = (key: string) => {
    const found = flight.fields.find((field) => field.key === key);
    if (found === undefined) throw new Error(`No field ${key} on the flight schema`);
    return found;
  };

  // The one leg the four passengers of the e-ticket share; only who, where they sit and which
  // ticket is theirs differs between the rows.
  const leg = {
    flightNumber: 'TK 1082',
    from: 'IST Istanbul',
    to: 'TIV Tivat',
    date: '2026-07-14',
    departure: '10:25',
    arrival: '11:55',
    class: 'Economy',
  };

  const eTicket = {
    airline: 'Turkish Airlines',
    bookingReference: 'K3M9QL',
    totalPrice: { amount: 1284.6, currency: 'EUR' },
    coupons: [
      { passenger: 'MARKOVIC/MILAN MR', seat: '12A', ticketNumber: '235 2400161930', ...leg },
      { passenger: 'MARKOVIC/ANA MRS', seat: '12B', ticketNumber: '235 2400161931', ...leg },
      { passenger: 'MARKOVIC/LUKA MSTR', seat: '12C', ticketNumber: '235 2400161932', ...leg },
      { passenger: 'MARKOVIC/SARA MISS', seat: '12D', ticketNumber: '235 2400161933', ...leg },
    ],
  };

  // Issued before check-in: two passengers, one leg, and not a seat on the paper.
  const itinerary = {
    airline: 'Air Serbia',
    bookingReference: 'QW7HTZ',
    totalPrice: { amount: '245,80', currency: 'eur' },
    coupons: [
      {
        passenger: 'PETROVIC/IVAN',
        flightNumber: 'JU 570',
        from: 'BEG Belgrade',
        to: 'SVO Moscow',
        date: '2026-03-02',
        departure: '18:40',
        arrival: '23:35',
        class: 'Y',
        ticketNumber: '115 2201849771',
      },
      {
        passenger: 'PETROVIC/MARIJA',
        flightNumber: 'JU 570',
        from: 'BEG Belgrade',
        to: 'SVO Moscow',
        date: '2026-03-02',
        departure: '18:40',
        arrival: '23:35',
        class: 'Y',
        ticketNumber: '115 2201849772',
      },
    ],
  };

  // One passenger, one leg, no price and no ticket number — a boarding pass states neither.
  const boardingPass = {
    airline: 'Wizz Air',
    bookingReference: 'X8LP2R',
    totalPrice: null,
    coupons: [
      {
        passenger: 'MARKOVIC/MILAN',
        flightNumber: 'W6 4321',
        from: 'BUD Budapest',
        to: 'TGD Podgorica',
        date: '2026-07-28',
        departure: '06:15',
        arrival: '08:05',
        seat: '18F',
        ticketNumber: '',
      },
    ],
  };

  it('draws the coupon columns the details table draws, in the schema order', () => {
    const columns = flightSpec('coupons').columns ?? [];
    expect(columns.map((column) => column.key)).toEqual([
      'passenger',
      'flightNumber',
      'from',
      'to',
      'date',
      'departure',
      'arrival',
      'seat',
      'class',
      'ticketNumber',
    ]);
    // Who and where, not when and in which seat: those are what a person searches a flight by.
    expect(
      columns.filter((column) => column.searchable === true).map((column) => column.key),
    ).toEqual(['passenger', 'flightNumber', 'from', 'to', 'ticketNumber']);
  });

  it('reads a single-leg ticket issued for four passengers as four coupons', () => {
    const values = sanitizeFieldValues(flight, eTicket);
    expect(values['airline']).toBe('Turkish Airlines');
    expect(values['bookingReference']).toBe('K3M9QL');
    expect(values['totalPrice']).toEqual({ amount: 1284.6, currency: 'EUR' });
    // Compared as text because the order of the cells is the order the details table draws them in
    // (docs/11 §11.5) — the schema's, whatever order the answer arrived in.
    expect(JSON.stringify(values['coupons'])).toBe(
      JSON.stringify([
        {
          passenger: 'MARKOVIC/MILAN MR',
          flightNumber: 'TK 1082',
          from: 'IST Istanbul',
          to: 'TIV Tivat',
          date: '2026-07-14',
          departure: '10:25',
          arrival: '11:55',
          seat: '12A',
          class: 'Economy',
          ticketNumber: '235 2400161930',
        },
        {
          passenger: 'MARKOVIC/ANA MRS',
          flightNumber: 'TK 1082',
          from: 'IST Istanbul',
          to: 'TIV Tivat',
          date: '2026-07-14',
          departure: '10:25',
          arrival: '11:55',
          seat: '12B',
          class: 'Economy',
          ticketNumber: '235 2400161931',
        },
        {
          passenger: 'MARKOVIC/LUKA MSTR',
          flightNumber: 'TK 1082',
          from: 'IST Istanbul',
          to: 'TIV Tivat',
          date: '2026-07-14',
          departure: '10:25',
          arrival: '11:55',
          seat: '12C',
          class: 'Economy',
          ticketNumber: '235 2400161932',
        },
        {
          passenger: 'MARKOVIC/SARA MISS',
          flightNumber: 'TK 1082',
          from: 'IST Istanbul',
          to: 'TIV Tivat',
          date: '2026-07-14',
          departure: '10:25',
          arrival: '11:55',
          seat: '12D',
          class: 'Economy',
          ticketNumber: '235 2400161933',
        },
      ]),
    );
  });

  it('reads a two-passenger itinerary as two coupons, priced as the paper prints it', () => {
    const values = sanitizeFieldValues(flight, itinerary);
    // "245,80" and "eur" are how the paper and the model write it; the value is still the value.
    expect(values['totalPrice']).toEqual({ amount: 245.8, currency: 'EUR' });
    expect(values['coupons']).toEqual([
      {
        passenger: 'PETROVIC/IVAN',
        flightNumber: 'JU 570',
        from: 'BEG Belgrade',
        to: 'SVO Moscow',
        date: '2026-03-02',
        departure: '18:40',
        arrival: '23:35',
        class: 'Y',
        ticketNumber: '115 2201849771',
      },
      {
        passenger: 'PETROVIC/MARIJA',
        flightNumber: 'JU 570',
        from: 'BEG Belgrade',
        to: 'SVO Moscow',
        date: '2026-03-02',
        departure: '18:40',
        arrival: '23:35',
        class: 'Y',
        ticketNumber: '115 2201849772',
      },
    ]);
  });

  it('reads a boarding pass as one coupon and no price at all', () => {
    const values = sanitizeFieldValues(flight, boardingPass);
    expect(Object.keys(values)).toEqual(['airline', 'bookingReference', 'coupons']);
    // A cell the pass does not print — the ticket number here — is simply not on the row.
    expect(values['coupons']).toEqual([
      {
        passenger: 'MARKOVIC/MILAN',
        flightNumber: 'W6 4321',
        from: 'BUD Budapest',
        to: 'TGD Podgorica',
        date: '2026-07-28',
        departure: '06:15',
        arrival: '08:05',
        seat: '18F',
      },
    ]);
  });

  it('drops a price with no currency without discarding the coupons beside it', () => {
    const values = sanitizeFieldValues(flight, {
      airline: '  Air Serbia  ',
      bookingReference: 'QW7HTZ',
      // An amount without its currency is not a fact (docs/03 §3.3.10a).
      totalPrice: { amount: 245.8 },
      coupons: ['not a row', { seat: '' }, { passenger: 'PETROVIC/IVAN', flightNumber: 'JU 570' }],
    });
    expect(values).toEqual({
      airline: 'Air Serbia',
      bookingReference: 'QW7HTZ',
      coupons: [{ passenger: 'PETROVIC/IVAN', flightNumber: 'JU 570' }],
    });
  });

  it('carries the airline, the booking reference and the price on the card', () => {
    const summary = summaryValuesOf(flight, sanitizeFieldValues(flight, eTicket));
    expect(summary).toEqual({
      airline: 'Turkish Airlines',
      bookingReference: 'K3M9QL',
      totalPrice: { amount: 1284.6, currency: 'EUR' },
    });
    expect(Object.keys(summary ?? {})).toEqual(['airline', 'bookingReference', 'totalPrice']);
    // The coupons are not on the card: a table of four rows is not a line of secondary text.
    expect(summaryValuesOf(flight, sanitizeFieldValues(flight, boardingPass))).toEqual({
      airline: 'Wizz Air',
      bookingReference: 'X8LP2R',
    });
  });

  it('is found by the passenger, the flight, the airports and the ticket number', () => {
    const text = extractedSearchTextOf(flight, sanitizeFieldValues(flight, itinerary));
    expect(text).toBe(
      [
        'Air Serbia',
        'QW7HTZ',
        'PETROVIC/IVAN',
        'JU 570',
        'BEG Belgrade',
        'SVO Moscow',
        '115 2201849771',
        'PETROVIC/MARIJA',
        'JU 570',
        'BEG Belgrade',
        'SVO Moscow',
        '115 2201849772',
      ].join('\n'),
    );
    // The date, the times, the seat and the class are on the row and out of the index: nobody
    // looks a flight up by "18:40".
    expect(text).not.toContain('18:40');
    expect(text).not.toContain('2026-03-02');
  });
});
