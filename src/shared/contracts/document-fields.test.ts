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
import type { DocumentFieldSchema, ExtractedFieldSource, ExtractedFields } from './document-fields';

const receipt = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'receipt');
if (receipt === undefined) throw new Error('The receipt schema left the registry');

const flight = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'flight');
if (flight === undefined) throw new Error('The flight schema left the registry');

const invoice = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'invoice');
if (invoice === undefined) throw new Error('The invoice schema left the registry');

const labReport = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'lab-report');
if (labReport === undefined) throw new Error('The lab-report schema left the registry');

const civilCertificate = DOCUMENT_FIELD_SCHEMAS.find(
  (schema) => schema.typeSlug === 'civil-certificate',
);
if (civilCertificate === undefined)
  throw new Error('The civil-certificate schema left the registry');

const idCard = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'id-card');
if (idCard === undefined) throw new Error('The id-card schema left the registry');

const passport = DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === 'passport');
if (passport === undefined) throw new Error('The passport schema left the registry');

const spec = (key: string) => {
  const found = receipt.fields.find((field) => field.key === key);
  if (found === undefined) throw new Error(`No field ${key} on the receipt schema`);
  return found;
};

// The fill-blanks rule as the `fields` step applies it (docs/03 §3.3.10a, docs/05 §5.5 step 5):
// the stored answer stands where it says MANUAL, the fresh reading fills the rest, and the whole
// of it is keyed on the schema's slug — which is why a version bump re-reads rather than replaces.
function applyFillBlanks(
  schema: DocumentFieldSchema,
  stored: ExtractedFields | null,
  answer: unknown,
): ExtractedFields {
  const read = sanitizeFieldValues(schema, answer);
  const previous = stored !== null && stored.schema.slug === schema.typeSlug ? stored : null;
  const values: Record<string, unknown> = {};
  const sources: Record<string, ExtractedFieldSource> = {};
  for (const field of schema.fields) {
    if (previous !== null && previous.sources[field.key] === 'MANUAL') {
      const kept = previous.values[field.key];
      if (kept !== undefined) {
        values[field.key] = kept;
        sources[field.key] = 'MANUAL';
        continue;
      }
    }
    const value = read[field.key];
    if (value !== undefined) {
      values[field.key] = value;
      sources[field.key] = 'AUTO';
    }
  }
  return { schema: { slug: schema.typeSlug, version: schema.version }, values, sources };
}

describe('fieldSchemaFor (docs/03 §3.3.10a)', () => {
  it('answers the schema of a slug that carries one, and null for the rest', () => {
    expect(fieldSchemaFor('receipt')?.typeSlug).toBe('receipt');
    expect(fieldSchemaFor('passport')?.typeSlug).toBe('passport');
    expect(fieldSchemaFor('id-card')?.typeSlug).toBe('id-card');
    expect(fieldSchemaFor('flight')?.typeSlug).toBe('flight');
    expect(fieldSchemaFor('invoice')?.typeSlug).toBe('invoice');
    expect(fieldSchemaFor('lab-report')?.typeSlug).toBe('lab-report');
    expect(fieldSchemaFor('civil-certificate')?.typeSlug).toBe('civil-certificate');
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

// One `invoice` however many providers a bill collects (docs/03 §3.3.10a): the answers below are
// shaped like the five bills this schema was written from — the combined municipal one that
// collects seven providers onto a single payable total, a Russian gas bill with a recalculation, a
// Montenegrin electricity bill with a discount, a water bill and a webshop's invoice.
describe('the invoice schema (docs/03 §3.3.10a)', () => {
  const invoiceSpec = (key: string) => {
    const found = invoice.fields.find((field) => field.key === key);
    if (found === undefined) throw new Error(`No field ${key} on the invoice schema`);
    return found;
  };

  // One paper, one total, seven companies: water, heating, waste, the collector's own fee, the
  // building, the lift and the flat's insurance, each rendering the line beside its name.
  const combined = {
    vendor: 'JKP Infostan tehnologije',
    accountNumber: '1234567890',
    invoiceNumber: '2026-06/0044182',
    billingPeriod: '2026-06',
    issuedAt: '2026-07-05',
    dueAt: '2026-07-31',
    totalDue: { amount: 4953.59, currency: 'RSD' },
    previousBalance: { amount: 0, currency: 'RSD' },
    paymentReference: '97 12-1234567890',
    items: [
      {
        provider: 'JKP Beogradski vodovod i kanalizacija',
        service: 'Voda i kanalizacija',
        quantity: 12,
        unit: 'm3',
        rate: 92.4,
        accrued: 1108.8,
        due: 1108.8,
      },
      {
        provider: 'JKP Beogradske elektrane',
        service: 'Grejanje',
        quantity: 56.3,
        unit: 'm2',
        rate: 39.7,
        accrued: 2235.11,
        // A recalculation for the heating season just closed, taken off this line.
        adjustment: -180.5,
        due: 2054.61,
      },
      {
        provider: 'JKP Gradska čistoća',
        service: 'Odvoz smeća',
        quantity: 56.3,
        unit: 'm2',
        rate: 6.1,
        accrued: 343.43,
        due: 343.43,
      },
      {
        provider: 'JKP Infostan tehnologije',
        service: 'Naknada za objedinjenu naplatu',
        quantity: 1,
        unit: 'mes.',
        rate: 118,
        accrued: 118,
        due: 118,
      },
      {
        provider: 'Stambena zajednica Ulica 12',
        service: 'Tekuće održavanje zgrade',
        quantity: 56.3,
        unit: 'm2',
        rate: 12.5,
        accrued: 703.75,
        due: 703.75,
      },
      {
        provider: 'Lift servis d.o.o.',
        service: 'Održavanje lifta',
        quantity: 1,
        unit: 'mes.',
        rate: 275,
        accrued: 275,
        due: 275,
      },
      {
        provider: 'Dunav osiguranje a.d.o.',
        service: 'Osiguranje stana',
        quantity: 1,
        unit: 'mes.',
        rate: 350,
        accrued: 350,
        due: 350,
      },
    ],
  };

  // One provider on every line, a recalculation that adds rather than takes off, and last month's
  // debt stated on its own row.
  const gas = {
    vendor: 'ООО «Газпром межрегионгаз Санкт-Петербург»',
    accountNumber: '78123456789',
    invoiceNumber: '07/2026-4412',
    billingPeriod: '2026-07',
    issuedAt: '2026-08-01',
    dueAt: '2026-08-10',
    totalDue: { amount: 1999.6, currency: 'RUB' },
    previousBalance: { amount: 512.4, currency: 'RUB' },
    paymentReference: 'Оплата за газ, л/с 78123456789 за июль 2026',
    items: [
      {
        provider: 'ООО «Газпром межрегионгаз Санкт-Петербург»',
        service: 'Газоснабжение',
        quantity: 42,
        unit: 'м3',
        rate: 8.9,
        accrued: 373.8,
        due: 373.8,
      },
      {
        provider: 'ООО «Газпром межрегионгаз Санкт-Петербург»',
        service: 'Техническое обслуживание ВДГО',
        quantity: 1,
        unit: 'мес.',
        rate: 957,
        accrued: 957,
        adjustment: 156.4,
        due: 1113.4,
      },
    ],
  };

  // The comma and the lowercase code are how the paper and the model write the total; the discount
  // for paying on time is a negative adjustment on the line it applies to.
  const electricity = {
    vendor: 'Elektroprivreda Crne Gore AD Nikšić',
    accountNumber: '2200145566',
    invoiceNumber: '2026-07-018345',
    billingPeriod: '2026-07',
    issuedAt: '2026-08-03',
    dueAt: '2026-08-20',
    totalDue: { amount: '41,86', currency: 'eur' },
    paymentReference: '2200145566-072026',
    items: [
      {
        provider: 'Elektroprivreda Crne Gore AD Nikšić',
        service: 'Aktivna energija — viša tarifa',
        quantity: 148,
        unit: 'kWh',
        rate: 0.0876,
        accrued: 12.96,
        adjustment: '-0,55',
        due: 12.41,
      },
      {
        provider: 'Elektroprivreda Crne Gore AD Nikšić',
        service: 'Naknada za mjerno mjesto',
        quantity: 1,
        unit: 'mj.',
        rate: 1.4,
        accrued: 1.4,
        due: 1.4,
      },
    ],
  };

  // A webshop's invoice: no personal account to quote, and the day it was paid printed on it.
  const webshop = {
    vendor: 'Ninja Store d.o.o.',
    invoiceNumber: 'WS-2026-00871',
    issuedAt: '2026-04-18',
    dueAt: '2026-04-25',
    paidAt: '2026-04-18',
    totalDue: { amount: 89.9, currency: 'EUR' },
    paymentReference: 'WS-2026-00871',
    items: [
      {
        provider: 'Ninja Store d.o.o.',
        service: 'Kettle 1.7l',
        quantity: 1,
        unit: 'kom',
        rate: 64.9,
        accrued: 64.9,
        due: 64.9,
      },
      {
        provider: 'Ninja Store d.o.o.',
        service: 'Delivery',
        quantity: 1,
        unit: 'kom',
        rate: 25,
        accrued: 25,
        due: 25,
      },
    ],
  };

  it('draws the line columns the details table draws, in the schema order', () => {
    const columns = invoiceSpec('items').columns ?? [];
    expect(columns.map((column) => column.key)).toEqual([
      'provider',
      'service',
      'quantity',
      'unit',
      'rate',
      'accrued',
      'adjustment',
      'due',
    ]);
    // Who and what, not how much: a bill is looked for by the company that sent it and the service
    // it charges for.
    expect(
      columns.filter((column) => column.searchable === true).map((column) => column.key),
    ).toEqual(['provider', 'service']);
  });

  it('reads the combined bill as seven lines, each naming its own provider', () => {
    const values = sanitizeFieldValues(invoice, combined);
    // Seven services rendered by seven companies — and one paper, with one total, that collects
    // them: splitting it would invent documents the drawer does not hold (docs/03 §3.3.10a).
    expect(new Set(combined.items.map((line) => line.provider)).size).toBe(7);
    expect(values['items']).toEqual(combined.items);
    expect(values['totalDue']).toEqual({ amount: 4953.59, currency: 'RSD' });
    // Nothing owed from last month, which is a value and not an absence.
    expect(values['previousBalance']).toEqual({ amount: 0, currency: 'RSD' });
  });

  it('draws a line in the schema order whatever order the answer arrived in', () => {
    // Compared as text because the order of the cells is the order the details table draws them
    // in (docs/11 §11.5) — the schema's, not the model's.
    const shuffled = sanitizeFieldValues(invoice, {
      items: [
        {
          due: 2054.61,
          adjustment: -180.5,
          provider: 'JKP Beogradske elektrane',
          rate: 39.7,
          accrued: 2235.11,
          service: 'Grejanje',
          unit: 'm2',
          quantity: 56.3,
        },
      ],
    });
    expect(JSON.stringify(shuffled['items'])).toBe(
      JSON.stringify([
        {
          provider: 'JKP Beogradske elektrane',
          service: 'Grejanje',
          quantity: 56.3,
          unit: 'm2',
          rate: 39.7,
          accrued: 2235.11,
          // The recalculation is signed as it changes the amount: this one takes off.
          adjustment: -180.5,
          due: 2054.61,
        },
      ]),
    );
  });

  it('reads a single-provider bill with the same company on every line', () => {
    const values = sanitizeFieldValues(invoice, gas);
    expect(values['vendor']).toBe('ООО «Газпром межрегионгаз Санкт-Петербург»');
    // The provider of a line on a single-provider bill is the vendor again, row after row.
    expect(values['items']).toEqual([
      {
        provider: 'ООО «Газпром межрегионгаз Санкт-Петербург»',
        service: 'Газоснабжение',
        quantity: 42,
        unit: 'м3',
        rate: 8.9,
        accrued: 373.8,
        due: 373.8,
      },
      {
        provider: 'ООО «Газпром межрегионгаз Санкт-Петербург»',
        service: 'Техническое обслуживание ВДГО',
        quantity: 1,
        unit: 'мес.',
        rate: 957,
        accrued: 957,
        // A recalculation that adds to the line rather than taking off.
        adjustment: 156.4,
        due: 1113.4,
      },
    ]);
    // The debt carried over is its own fact, beside the figure actually asked for.
    expect(values['previousBalance']).toEqual({ amount: 512.4, currency: 'RUB' });
    expect(values['totalDue']).toEqual({ amount: 1999.6, currency: 'RUB' });
    expect(values['paymentReference']).toBe('Оплата за газ, л/с 78123456789 за июль 2026');
  });

  it('normalizes the total as the paper prints it and keeps a discount as a negative line', () => {
    const values = sanitizeFieldValues(invoice, electricity);
    // "41,86" and "eur" are how the bill and the model write it; the value is still the value.
    expect(values['totalDue']).toEqual({ amount: 41.86, currency: 'EUR' });
    expect(values['items']).toEqual([
      {
        provider: 'Elektroprivreda Crne Gore AD Nikšić',
        service: 'Aktivna energija — viša tarifa',
        quantity: 148,
        unit: 'kWh',
        rate: 0.0876,
        accrued: 12.96,
        // The discount for paying on time, printed "-0,55" and meaning it.
        adjustment: -0.55,
        due: 12.41,
      },
      {
        provider: 'Elektroprivreda Crne Gore AD Nikšić',
        service: 'Naknada za mjerno mjesto',
        quantity: 1,
        unit: 'mj.',
        rate: 1.4,
        accrued: 1.4,
        due: 1.4,
      },
    ]);
  });

  it('reads a webshop invoice that names no account and was paid the day it was issued', () => {
    const values = sanitizeFieldValues(invoice, webshop);
    // A field the paper does not carry is simply not there — that is its NONE (docs/03 §3.3.10a).
    expect(Object.keys(values)).toEqual([
      'vendor',
      'invoiceNumber',
      'issuedAt',
      'dueAt',
      'totalDue',
      'paidAt',
      'paymentReference',
      'items',
    ]);
    expect(values['paidAt']).toBe('2026-04-18');
  });

  it('drops a date and a total it cannot read without losing the lines beside them', () => {
    const values = sanitizeFieldValues(invoice, {
      vendor: '  JP Vodovod i kanalizacija Višegrad  ',
      accountNumber: '0071-4429',
      billingPeriod: '2026-05',
      // The day as the paper prints it rather than as a calendar day, and a thousands separator
      // no arithmetic survives.
      dueAt: '20.06.2026',
      totalDue: { amount: '1.284,50', currency: 'BAM' },
      items: [
        {
          provider: 'JP Vodovod i kanalizacija Višegrad',
          service: 'Utrošak vode',
          quantity: 9,
          unit: 'm3',
          rate: 1.42,
          accrued: 12.78,
          due: 12.78,
        },
        'not a line',
        { unit: '' },
      ],
    });
    expect(values).toEqual({
      vendor: 'JP Vodovod i kanalizacija Višegrad',
      accountNumber: '0071-4429',
      billingPeriod: '2026-05',
      items: [
        {
          provider: 'JP Vodovod i kanalizacija Višegrad',
          service: 'Utrošak vode',
          quantity: 9,
          unit: 'm3',
          rate: 1.42,
          accrued: 12.78,
          due: 12.78,
        },
      ],
    });
  });

  it('carries the biller, the period, the due date and the total on the card', () => {
    const summary = summaryValuesOf(invoice, sanitizeFieldValues(invoice, combined));
    expect(summary).toEqual({
      vendor: 'JKP Infostan tehnologije',
      billingPeriod: '2026-06',
      dueAt: '2026-07-31',
      totalDue: { amount: 4953.59, currency: 'RSD' },
    });
    expect(Object.keys(summary ?? {})).toEqual(['vendor', 'billingPeriod', 'dueAt', 'totalDue']);
  });

  it('is found by the account, the numbers, the reference and every provider it collects', () => {
    const text = extractedSearchTextOf(invoice, sanitizeFieldValues(invoice, combined));
    expect(text).toBe(
      [
        'JKP Infostan tehnologije',
        '1234567890',
        '2026-06/0044182',
        '97 12-1234567890',
        'JKP Beogradski vodovod i kanalizacija',
        'Voda i kanalizacija',
        'JKP Beogradske elektrane',
        'Grejanje',
        'JKP Gradska čistoća',
        'Odvoz smeća',
        'JKP Infostan tehnologije',
        'Naknada za objedinjenu naplatu',
        'Stambena zajednica Ulica 12',
        'Tekuće održavanje zgrade',
        'Lift servis d.o.o.',
        'Održavanje lifta',
        'Dunav osiguranje a.d.o.',
        'Osiguranje stana',
      ].join('\n'),
    );
    // The amounts and the days are on the paper and out of the index: nobody looks a bill up by
    // "2235.11".
    expect(text).not.toContain('2235.11');
    expect(text).not.toContain('2026-07-31');
  });
});

// The receipt at v2 (docs/03 §3.3.10a): what a till receipt says about the purchase, and what it
// says about the line of the bank statement that paid for it.
describe('the receipt schema at v2 (docs/03 §3.3.10a)', () => {
  // Photographed on a phone, paid by card: the descriptor a statement would print, the minute, the
  // masked digits, a weighed line and a discounted one.
  const photographed = {
    vendor: 'Tropic maloprodaja d.o.o.',
    statementDescriptor: 'TROPIC MALOPRODAJA VISEGRAD BA',
    purchasedAt: '2026-05-12',
    purchasedTime: '18:42',
    total: { amount: '23,45', currency: 'bam' },
    taxAmount: 3.41,
    paymentMethod: 'card',
    card: '*8534',
    vendorTaxId: '4400958690005',
    receiptNumber: 'FR-000148/26',
    items: [
      { name: 'Hljeb polubijeli 500g', quantity: 1, unitPrice: 1.5, amount: 1.5 },
      // Sold by weight: the quantity is what the scales printed and the unit price is per kilogram.
      { name: 'Banane', quantity: 0.542, unitPrice: 2.79, amount: 1.51 },
      { name: 'Mlijeko 2.8% 1l', quantity: 2, unitPrice: 2.35, amount: 4.3, discount: 0.4 },
    ],
  };

  // Paid in cash, so there is no card and nothing a statement will ever match.
  const cash = {
    vendor: 'Пятёрочка',
    purchasedAt: '2026-05-12',
    purchasedTime: '09:07',
    total: { amount: 412.9, currency: 'RUB' },
    taxAmount: 68.82,
    paymentMethod: 'cash',
    vendorTaxId: '7728029110',
    receiptNumber: '0031-0148',
    items: [{ name: 'Хлеб «Бородинский»', quantity: 1, unitPrice: 54.9, amount: 54.9 }],
  };

  it('states the version the answers speak, and the fields it added', () => {
    expect(receipt.version).toBe(2);
    expect(receipt.fields.map((field) => field.key)).toEqual([
      'vendor',
      'statementDescriptor',
      'purchasedAt',
      'purchasedTime',
      'total',
      'taxAmount',
      'paymentMethod',
      'card',
      'vendorTaxId',
      'receiptNumber',
      'items',
    ]);
    const columns = spec('items').columns ?? [];
    expect(columns.map((column) => column.key)).toEqual([
      'name',
      'quantity',
      'unitPrice',
      'amount',
      'discount',
    ]);
  });

  it('reads a photographed till receipt down to the card, the method and the minute', () => {
    const values = sanitizeFieldValues(receipt, photographed);
    expect(values['statementDescriptor']).toBe('TROPIC MALOPRODAJA VISEGRAD BA');
    expect(values['purchasedTime']).toBe('18:42');
    expect(values['paymentMethod']).toBe('card');
    expect(values['card']).toBe('*8534');
    expect(values['vendorTaxId']).toBe('4400958690005');
    expect(values['receiptNumber']).toBe('FR-000148/26');
    // The currency lives once, on the total; the tax and every line amount are bare numbers in it.
    expect(values['total']).toEqual({ amount: 23.45, currency: 'BAM' });
    expect(values['taxAmount']).toBe(3.41);
    expect(values['items']).toEqual([
      { name: 'Hljeb polubijeli 500g', quantity: 1, unitPrice: 1.5, amount: 1.5 },
      { name: 'Banane', quantity: 0.542, unitPrice: 2.79, amount: 1.51 },
      { name: 'Mlijeko 2.8% 1l', quantity: 2, unitPrice: 2.35, amount: 4.3, discount: 0.4 },
    ]);
  });

  it('reads a receipt paid in cash as having no card at all', () => {
    const values = sanitizeFieldValues(receipt, cash);
    expect(values['paymentMethod']).toBe('cash');
    expect(Object.keys(values)).not.toContain('card');
    expect(Object.keys(values)).not.toContain('statementDescriptor');
  });

  it('leaves the card as it is: the summary line is still the vendor, the day and the total', () => {
    const summary = summaryValuesOf(receipt, sanitizeFieldValues(receipt, photographed));
    expect(summary).toEqual({
      vendor: 'Tropic maloprodaja d.o.o.',
      purchasedAt: '2026-05-12',
      total: { amount: 23.45, currency: 'BAM' },
    });
  });

  it('is found by the descriptor, the card, the tax number and the receipt number', () => {
    const text = extractedSearchTextOf(receipt, sanitizeFieldValues(receipt, photographed));
    expect(text).toBe(
      [
        'Tropic maloprodaja d.o.o.',
        'TROPIC MALOPRODAJA VISEGRAD BA',
        '*8534',
        '4400958690005',
        'FR-000148/26',
        'Hljeb polubijeli 500g',
        'Banane',
        'Mlijeko 2.8% 1l',
      ].join('\n'),
    );
    // How it was paid and at what minute are on the document and out of the index.
    expect(text).not.toContain('18:42');
    expect(text).not.toContain('card');
  });

  it('re-reads a v1 answer at v2 and keeps the field a person corrected', () => {
    // What the document has held since before the bump: a vendor somebody typed, the rest read.
    const stored: ExtractedFields = {
      schema: { slug: 'receipt', version: 1 },
      values: {
        vendor: 'Tropic d.o.o. Višegrad',
        purchasedAt: '2026-05-12',
        total: { amount: 23.45, currency: 'BAM' },
      },
      sources: { vendor: 'MANUAL', purchasedAt: 'AUTO', total: 'AUTO' },
    };

    const next = applyFillBlanks(receipt, stored, photographed);

    // 🔒 A version bump is not a type change: the slug agrees, so the paper is simply read again —
    // the correction survives it and the fields v2 added arrive as the model read them.
    expect(next.schema).toEqual({ slug: 'receipt', version: 2 });
    expect(next.values['vendor']).toBe('Tropic d.o.o. Višegrad');
    expect(next.sources['vendor']).toBe('MANUAL');
    expect(next.values['card']).toBe('*8534');
    expect(next.values['statementDescriptor']).toBe('TROPIC MALOPRODAJA VISEGRAD BA');
    expect(next.sources['card']).toBe('AUTO');
    expect(next.sources['statementDescriptor']).toBe('AUTO');
  });
});

// One row per analyte, panels flattened (docs/03 §3.3.10a): the answer below is shaped like the
// clinical lab report this schema was written from — a blood count, a biochemistry panel and a
// serology test printed under three headings on one sheet, and rows of one table here.
describe('the lab-report schema (docs/03 §3.3.10a)', () => {
  const labSpec = (key: string) => {
    const found = labReport.fields.find((field) => field.key === key);
    if (found === undefined) throw new Error(`No field ${key} on the lab-report schema`);
    return found;
  };

  const report = {
    patient: 'Petrović Ana',
    facility: 'Laboratorija Konzilijum, Beograd',
    orderNumber: 'LK-2026-0418-77',
    collectedAt: '2026-04-18',
    reportedAt: '2026-04-19',
    results: [
      // Krvna slika — the panel heading is not a row of its own.
      { analyte: 'Hemoglobin', value: '143', unit: 'g/L', reference: '130–170' },
      { analyte: 'Eritrociti', value: '4.82', unit: '10^12/L', reference: '4.30–5.70' },
      { analyte: 'Leukociti', value: '11.4', unit: '10^9/L', reference: '4.0–9.0', flag: 'H' },
      { analyte: 'Trombociti', value: '244', unit: '10^9/L', reference: '150–400' },
      // Biohemija — the comma is how the paper prints it, and the column keeps it as printed.
      { analyte: 'Glukoza', value: '5,9', unit: 'mmol/L', reference: '4.1–5.9' },
      {
        analyte: 'Holesterol ukupni',
        value: '6.31',
        unit: 'mmol/L',
        reference: '< 5.2',
        flag: '↑',
      },
      // Serologija — a verdict and a value the instrument could only bound from above.
      {
        analyte: 'Anti-SARS-CoV-2 IgG',
        value: 'positive',
        reference: 'negative',
        flag: 'abnormal',
      },
      { analyte: 'Troponin I', value: '<0.01', unit: 'ng/mL', reference: '< 0.04' },
    ],
  };

  it('draws the result columns the details table draws, in the schema order', () => {
    const columns = labSpec('results').columns ?? [];
    expect(columns.map((column) => column.key)).toEqual([
      'analyte',
      'value',
      'unit',
      'reference',
      'flag',
    ]);
    // What was measured is what a person searches by; a number, its unit and its interval are read
    // on the document and belong out of the index.
    expect(
      columns.filter((column) => column.searchable === true).map((column) => column.key),
    ).toEqual(['analyte']);
  });

  it('reads three panels as one table, verdicts and bounded values included', () => {
    const values = sanitizeFieldValues(labReport, report);
    expect(values['patient']).toBe('Petrović Ana');
    expect(values['facility']).toBe('Laboratorija Konzilijum, Beograd');
    expect(values['orderNumber']).toBe('LK-2026-0418-77');
    expect(values['results']).toEqual(report.results);
    // 🔒 "positive" is a result: a numeric column would have dropped it, and "<0.01" with it.
    expect(values['results']).toContainEqual({
      analyte: 'Anti-SARS-CoV-2 IgG',
      value: 'positive',
      reference: 'negative',
      flag: 'abnormal',
    });
    // A result inside its interval carries no flag, and that absence is not an empty cell. Compared
    // as text because the cells are drawn in the schema's order (docs/11 §11.5), not the answer's.
    expect(JSON.stringify(values['results'])).toContain(
      JSON.stringify({ analyte: 'Hemoglobin', value: '143', unit: 'g/L', reference: '130–170' }),
    );
  });

  it('keeps a result the model answered as a number, printed as it stands', () => {
    const values = sanitizeFieldValues(labReport, {
      results: [
        { analyte: 'Hemoglobin', value: 143, unit: 'g/L', reference: '130–170' },
        { analyte: 'Glukoza', value: 5.9, unit: 'mmol/L' },
      ],
    });
    expect(values['results']).toEqual([
      { analyte: 'Hemoglobin', value: '143', unit: 'g/L', reference: '130–170' },
      { analyte: 'Glukoza', value: '5.9', unit: 'mmol/L' },
    ]);
  });

  it('drops a date it cannot read without losing the analytes beside it', () => {
    const values = sanitizeFieldValues(labReport, {
      patient: '  Petrović Ana  ',
      // The day as the report prints it rather than as a calendar day.
      collectedAt: '18.04.2026',
      reportedAt: '2026-04-19',
      results: ['not a row', { unit: '' }, { analyte: 'Hemoglobin', value: '143' }],
    });
    expect(values).toEqual({
      patient: 'Petrović Ana',
      reportedAt: '2026-04-19',
      results: [{ analyte: 'Hemoglobin', value: '143' }],
    });
  });

  it('carries the patient and the day the sample was taken on the card', () => {
    const summary = summaryValuesOf(labReport, sanitizeFieldValues(labReport, report));
    // 🔒 The day the sample was taken, not the day the printer ran: that is what the result speaks
    // about (docs/03 §3.3.10a).
    expect(summary).toEqual({ patient: 'Petrović Ana', collectedAt: '2026-04-18' });
    expect(Object.keys(summary ?? {})).toEqual(['patient', 'collectedAt']);
  });

  it('is found by the patient, the laboratory, the order number and every analyte', () => {
    const text = extractedSearchTextOf(labReport, sanitizeFieldValues(labReport, report));
    expect(text).toBe(
      [
        'Petrović Ana',
        'Laboratorija Konzilijum, Beograd',
        'LK-2026-0418-77',
        'Hemoglobin',
        'Eritrociti',
        'Leukociti',
        'Trombociti',
        'Glukoza',
        'Holesterol ukupni',
        'Anti-SARS-CoV-2 IgG',
        'Troponin I',
      ].join('\n'),
    );
    // The numbers, their units and their intervals stay on the document.
    expect(text).not.toContain('mmol/L');
    expect(text).not.toContain('6.31');
  });
});

// The state papers on numbered blanks (docs/03 §3.3.10a): the answers below are shaped like a birth
// certificate and a marriage certificate — a form that never expires, whose number is the form's,
// with a registry-book record standing behind it.
describe('the civil-certificate schema (docs/03 §3.3.10a)', () => {
  const birth = {
    certificateNumber: 'II-МЮ № 123456',
    actNumber: '1042',
    actDate: '1990-01-09',
    issuedBy: 'Отдел ЗАГС Кировского района города Санкт-Петербурга',
    eventDate: '1990-01-02',
    eventPlace: 'город Ленинград, РСФСР',
    issuedAt: '1990-01-09',
  };

  // A duplicate drawn thirty years after the wedding: the blank is new, the record is not.
  const marriageDuplicate = {
    certificateNumber: 'Ser. A No. 004512',
    actNumber: '318',
    actDate: '1994-06-11',
    issuedBy: 'Matična služba opštine Stari grad, Beograd',
    eventDate: '1994-06-11',
    eventPlace: 'Beograd, Republika Srbija',
    issuedAt: '2024-09-30',
  };

  it('states the fields of a numbered blank, and nobody it is about', () => {
    expect(civilCertificate.version).toBe(1);
    expect(civilCertificate.fields.map((field) => field.key)).toEqual([
      'certificateNumber',
      'actNumber',
      'actDate',
      'issuedBy',
      'eventDate',
      'eventPlace',
      'issuedAt',
    ]);
    // 🔒 Who the paper is about stays on the document's people links (docs/03 §3.3.10a, §3.3.19):
    // a name copied into a field beside them would be a second vocabulary for the same person.
    for (const key of ['holder', 'patient', 'child', 'name', 'spouse']) {
      expect(civilCertificate.fields.some((field) => field.key === key)).toBe(false);
    }
  });

  it('reads a birth certificate down to the record standing behind the blank', () => {
    const values = sanitizeFieldValues(civilCertificate, birth);
    expect(values).toEqual(birth);
  });

  it('keeps the day of the event apart from the day a duplicate was printed', () => {
    const values = sanitizeFieldValues(civilCertificate, marriageDuplicate);
    expect(values['eventDate']).toBe('1994-06-11');
    expect(values['actDate']).toBe('1994-06-11');
    // The blank is thirty years younger than the marriage it certifies.
    expect(values['issuedAt']).toBe('2024-09-30');
  });

  it('drops a number-shaped date without losing the blank number beside it', () => {
    const values = sanitizeFieldValues(civilCertificate, {
      certificateNumber: '  II-МЮ № 123456  ',
      // A century no registry office ever printed, and a day that is not one.
      actDate: '1890-01-09',
      eventDate: '1990-02-31',
      issuedBy: 'Отдел ЗАГС Кировского района города Санкт-Петербурга',
    });
    expect(values).toEqual({
      certificateNumber: 'II-МЮ № 123456',
      issuedBy: 'Отдел ЗАГС Кировского района города Санкт-Петербурга',
    });
  });

  it('carries the blank number and the day of the event on the card', () => {
    const summary = summaryValuesOf(
      civilCertificate,
      sanitizeFieldValues(civilCertificate, marriageDuplicate),
    );
    expect(summary).toEqual({
      certificateNumber: 'Ser. A No. 004512',
      eventDate: '1994-06-11',
    });
    expect(Object.keys(summary ?? {})).toEqual(['certificateNumber', 'eventDate']);
  });

  it('is found by both numbers, the office and the place of the event', () => {
    const text = extractedSearchTextOf(
      civilCertificate,
      sanitizeFieldValues(civilCertificate, birth),
    );
    expect(text).toBe(
      [
        'II-МЮ № 123456',
        '1042',
        'Отдел ЗАГС Кировского района города Санкт-Петербурга',
        'город Ленинград, РСФСР',
      ].join('\n'),
    );
    // The days are on the paper and out of the index: nobody looks a certificate up by "1990-01-02".
    expect(text).not.toContain('1990-01-02');
  });
});

// The wallet cards at v2 (docs/03 §3.3.10a): both now say which state issued them, and a driving
// licence says the two further things only a licence says.
describe('id-card and passport at v2 (docs/03 §3.3.10a)', () => {
  // The Russian driving licence a Serbian archive holds — which is the whole reason the issuing
  // state is a field: the document's own country row does not answer it.
  const licence = {
    holder: 'ПЕТРОВ ИВАН СЕРГЕЕВИЧ / PETROV IVAN',
    number: '99 12 345678',
    issuingCountry: 'Russia',
    issuedBy: 'ГИБДД 7803',
    issuedAt: '2019-11-14',
    expiresAt: '2029-11-14',
    birthDate: '1985-03-21',
    categories: 'B, B1, M',
  };

  it('states the fields each card carries at v2, in the order the details table draws them', () => {
    expect(idCard.version).toBe(2);
    expect(idCard.fields.map((field) => field.key)).toEqual([
      'holder',
      'number',
      'issuingCountry',
      'issuedBy',
      'issuedAt',
      'expiresAt',
      'birthDate',
      'categories',
    ]);
    expect(passport.version).toBe(2);
    expect(passport.fields.map((field) => field.key)).toEqual([
      'holder',
      'number',
      'issuingCountry',
      'issuedBy',
      'issuedAt',
      'expiresAt',
      'birthDate',
    ]);
  });

  it('reads a driving licence down to the state that issued it and the classes it grants', () => {
    const values = sanitizeFieldValues(idCard, licence);
    expect(values).toEqual(licence);
    // The categories are printed on the card and read off it as printed, separators and all.
    expect(values['categories']).toBe('B, B1, M');
  });

  it('is found by the holder, the number, the issuing state and the authority', () => {
    const text = extractedSearchTextOf(idCard, sanitizeFieldValues(idCard, licence));
    expect(text).toBe(
      ['ПЕТРОВ ИВАН СЕРГЕЕВИЧ / PETROV IVAN', '99 12 345678', 'Russia', 'ГИБДД 7803'].join('\n'),
    );
    // The classes are on the card and out of the index: "B" would match half an archive.
    expect(text).not.toContain('B, B1, M');
  });

  it('re-reads a v1 id-card answer at v2 and keeps the fields a person corrected', () => {
    // What the document has held since before the bump: a holder and a number somebody typed.
    const stored: ExtractedFields = {
      schema: { slug: 'id-card', version: 1 },
      values: {
        holder: 'Петров Иван Сергеевич',
        number: '99 12 345678',
        issuedAt: '2019-11-14',
      },
      sources: { holder: 'MANUAL', number: 'MANUAL', issuedAt: 'AUTO' },
    };

    const next = applyFillBlanks(idCard, stored, licence);

    // 🔒 A version bump is not a type change: the slug agrees, so the card is simply read again —
    // both corrections survive it and the fields v2 added arrive as the model read them.
    expect(next.schema).toEqual({ slug: 'id-card', version: 2 });
    expect(next.values['holder']).toBe('Петров Иван Сергеевич');
    expect(next.values['number']).toBe('99 12 345678');
    expect(next.sources['holder']).toBe('MANUAL');
    expect(next.sources['number']).toBe('MANUAL');
    expect(next.values['issuingCountry']).toBe('Russia');
    expect(next.values['birthDate']).toBe('1985-03-21');
    expect(next.values['categories']).toBe('B, B1, M');
    expect(next.sources['issuingCountry']).toBe('AUTO');
    expect(next.sources['categories']).toBe('AUTO');
    // The field that was read rather than typed is read again, and stays AUTO.
    expect(next.sources['issuedAt']).toBe('AUTO');
  });

  it('re-reads a v1 passport answer at v2 and keeps the field a person corrected', () => {
    const stored: ExtractedFields = {
      schema: { slug: 'passport', version: 1 },
      values: { holder: 'Ana Petrović', number: '008 123456', expiresAt: '2031-05-04' },
      sources: { holder: 'MANUAL', number: 'AUTO', expiresAt: 'AUTO' },
    };

    const next = applyFillBlanks(passport, stored, {
      holder: 'PETROVIC ANA',
      number: '008123456',
      issuingCountry: 'Serbia',
      issuedBy: 'PU Beograd',
      issuedAt: '2021-05-04',
      expiresAt: '2031-05-04',
      birthDate: '1988-07-19',
    });

    expect(next.schema).toEqual({ slug: 'passport', version: 2 });
    expect(next.values['holder']).toBe('Ana Petrović');
    expect(next.sources['holder']).toBe('MANUAL');
    // Read again where nobody had corrected it, the new field included.
    expect(next.values['number']).toBe('008123456');
    expect(next.sources['number']).toBe('AUTO');
    expect(next.values['issuingCountry']).toBe('Serbia');
    expect(next.sources['issuingCountry']).toBe('AUTO');
  });
});
