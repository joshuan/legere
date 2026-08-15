import { z } from 'zod';

// Typed fields: the facts a document of a given type states, as data (docs/03 §3.3.10a, ADR-022).
//
// The registry below is deliberately a constant and not a table: the day schemas become
// admin-editable they move into the database without the stored answers changing shape, because
// every answer names the schema slug and version it speaks. Field labels are not here either —
// they are message-catalog keys derived from the slug and the field key (docs/10 §10.3).

export const documentFieldKindSchema = z.enum(['string', 'number', 'date', 'money', 'table']);
export type DocumentFieldKind = z.infer<typeof documentFieldKindSchema>;

export type DocumentFieldColumn = {
  readonly key: string;
  readonly kind: 'string' | 'number';
  // Whether this column's values join the FTS projection (docs/04 §4.3).
  readonly searchable?: boolean;
  // Guidance for the model, English (the reference language of everything shipped).
  readonly hint: string;
};

export type DocumentFieldSpec = {
  readonly key: string;
  readonly kind: DocumentFieldKind;
  readonly searchable?: boolean;
  // Whether the value belongs on a card (docs/11 §11.3): the summary line is these, in order.
  readonly summary?: boolean;
  readonly hint: string;
  // For `table` only: what a row is made of.
  readonly columns?: readonly DocumentFieldColumn[];
};

export type DocumentFieldSchema = {
  readonly typeSlug: string;
  readonly version: number;
  readonly fields: readonly DocumentFieldSpec[];
};

export const DOCUMENT_FIELD_SCHEMAS: readonly DocumentFieldSchema[] = [
  // v2 (docs/03 §3.3.10a): a till receipt's second job in an archive is answering "which line of the
  // bank statement is this", so beside what the paper says it bought, it now says how it was paid —
  // the descriptor a statement prints, the method, the masked card and the minute of the purchase.
  {
    typeSlug: 'receipt',
    version: 2,
    fields: [
      {
        key: 'vendor',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The merchant as printed at the head of the receipt, in its own script and case — the shop as it names itself, which is not how a bank statement spells it',
      },
      {
        key: 'statementDescriptor',
        kind: 'string',
        searchable: true,
        hint: 'The same merchant the way a card statement prints it: trading name, town and two-letter country code, in capitals and spaced as one line, e.g. "TROPIC MALOPRODAJA VISEGRAD BA". Composed from what the receipt shows — its name, the town of the shop, its country — because this is the string that matches a statement line back to this paper',
      },
      {
        key: 'purchasedAt',
        kind: 'date',
        summary: true,
        hint: 'The purchase date printed on the receipt, as yyyy-mm-dd',
      },
      {
        key: 'purchasedTime',
        kind: 'string',
        hint: 'The time printed beside that date, as hh:mm on a 24-hour clock — two receipts from the same shop on the same day are told apart by it, and by nothing else',
      },
      {
        key: 'total',
        kind: 'money',
        summary: true,
        hint: 'The grand total actually paid, with its ISO 4217 currency — discounts already taken off. The currency is stated here and only here: every other amount on this receipt is a bare number in it',
      },
      {
        key: 'taxAmount',
        kind: 'number',
        hint: 'The tax the receipt totals up — "PDV", "НДС", "VAT", "porez" — as a bare number in the receipt\'s own currency. The sum of the rates table where the receipt breaks the tax down by rate',
      },
      {
        key: 'paymentMethod',
        kind: 'string',
        hint: 'How it was paid: exactly "card" or "cash", read off the markings where the paper does not say it in words. Card — a masked card number, a POS/TID/MID/RRN/AID line, "Безналичными", "Электронными", "СБП", "Platna kartica", or a VISA/Mastercard/МИР logo spelled out. Cash — "Наличными", "Сдача", "Gotovina", "Cash". Neither marking on the paper → null, rather than a guess',
      },
      {
        key: 'card',
        kind: 'string',
        searchable: true,
        hint: 'The card digits exactly as the receipt masks them, e.g. "*8534" or "************1234" — the stars kept, because the printed form is what a person recognises. A cash receipt names none',
      },
      {
        key: 'vendorTaxId',
        kind: 'string',
        searchable: true,
        hint: 'The merchant\'s tax number as printed — "ИНН", "PIB", "JIB", "OIB", "VAT ID" — the digits only, without the label',
      },
      {
        key: 'receiptNumber',
        kind: 'string',
        searchable: true,
        hint: 'The number this receipt is filed under: the fiscal receipt number, the "чек №", or the order number where the paper is a webshop\'s',
      },
      {
        key: 'items',
        kind: 'table',
        hint: 'The line items of the receipt, in printed order — one row per position, a weighed good included',
        columns: [
          { key: 'name', kind: 'string', searchable: true, hint: 'The item as printed' },
          {
            key: 'quantity',
            kind: 'number',
            hint: 'How many, or how much: a count of pieces, or the weight the scales printed, e.g. 0.542',
          },
          {
            key: 'unitPrice',
            kind: 'number',
            hint: 'What one of them costs — per piece, or per kilogram where the line is weighed — as a bare number in the receipt currency',
          },
          { key: 'amount', kind: 'number', hint: 'The line total, in the receipt currency' },
          {
            key: 'discount',
            kind: 'number',
            hint: 'What was taken off this line — the "скидка" or "popust" printed against it — as a bare positive number; a line sold at full price carries none',
          },
        ],
      },
    ],
  },
  // v2 (docs/03 §3.3.10a): a card in a wallet says which state issued it, and the document's own
  // `country` — one coarse code for where the paper belongs — is not that answer.
  {
    typeSlug: 'passport',
    version: 2,
    fields: [
      {
        key: 'holder',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: "The holder's full name as printed, in the document's own script",
      },
      {
        key: 'number',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The passport number, exactly as printed',
      },
      {
        key: 'issuingCountry',
        kind: 'string',
        searchable: true,
        hint: 'The state that issued this passport, as the document itself names it on the cover or in the data page — the country of issue, and not the country the archive keeping the paper sits in',
      },
      {
        key: 'issuedBy',
        kind: 'string',
        searchable: true,
        hint: 'The issuing authority as printed',
      },
      { key: 'issuedAt', kind: 'date', hint: 'The date of issue, as yyyy-mm-dd' },
      { key: 'expiresAt', kind: 'date', summary: true, hint: 'The expiry date, as yyyy-mm-dd' },
      { key: 'birthDate', kind: 'date', hint: "The holder's date of birth, as yyyy-mm-dd" },
    ],
  },
  // v2 (docs/03 §3.3.10a): the same issuing state as the passport, and the two things a driving
  // licence prints that no other card in a wallet does — the birth date and the vehicle classes.
  {
    typeSlug: 'id-card',
    version: 2,
    fields: [
      {
        key: 'holder',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: "The holder's full name as printed, in the document's own script",
      },
      {
        key: 'number',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The card or licence number, exactly as printed',
      },
      {
        key: 'issuingCountry',
        kind: 'string',
        searchable: true,
        hint: 'The state that issued this card, as the card itself names it — the country printed at its head, in the coat of arms or under the authority. A Russian driving licence kept in a Serbian drawer answers Russia',
      },
      {
        key: 'issuedBy',
        kind: 'string',
        searchable: true,
        hint: 'The issuing authority as printed',
      },
      { key: 'issuedAt', kind: 'date', hint: 'The date of issue, as yyyy-mm-dd' },
      { key: 'expiresAt', kind: 'date', summary: true, hint: 'The expiry date, as yyyy-mm-dd' },
      { key: 'birthDate', kind: 'date', hint: "The holder's date of birth, as yyyy-mm-dd" },
      {
        key: 'categories',
        kind: 'string',
        hint: 'The vehicle categories a driving licence grants, exactly as the card prints them and in its own order — "B, B1, M", "A1 A B CE" — the letters and their separators, without the dates printed against them. A card that is not a licence has none',
      },
    ],
  },
  // One schema for every paper an airline prints (docs/03 §3.3.10a): an e-ticket, an itinerary
  // receipt and a boarding pass differ in which fields they fill, not in what they are. The booking
  // is stated once and the coupons table carries a row per passenger per leg.
  {
    typeSlug: 'flight',
    version: 1,
    fields: [
      {
        key: 'airline',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The airline the ticket was issued by, as the paper names it; where a code-share prints two carriers, the one whose name heads the document',
      },
      {
        key: 'bookingReference',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The booking reference the paper repeats on every page — six letters and digits, printed as "Booking reference", "Reservation code", "PNR" or "Record locator". Not the ticket number',
      },
      {
        key: 'totalPrice',
        kind: 'money',
        summary: true,
        hint: 'What the whole booking cost, with its ISO 4217 currency, where the paper states a price — the total for all passengers, taxes and fees included. A boarding pass states none: answer null',
      },
      {
        key: 'coupons',
        kind: 'table',
        hint: 'One row per passenger per leg, in the order the paper lists them: a single-leg ticket for four passengers is four rows, a two-passenger itinerary is two, a boarding pass is one. A leg flown by every passenger on the booking is still one row each',
        columns: [
          {
            key: 'passenger',
            kind: 'string',
            searchable: true,
            hint: 'The passenger of this coupon, spelled as the ticket spells them — surname first where it is printed that way',
          },
          {
            key: 'flightNumber',
            kind: 'string',
            searchable: true,
            hint: 'The flight as printed: the carrier code and its number, e.g. "TK 1030"',
          },
          {
            key: 'from',
            kind: 'string',
            searchable: true,
            hint: 'Where this leg departs from — the three-letter airport code with the city beside it where the paper prints both, e.g. "IST Istanbul"',
          },
          {
            key: 'to',
            kind: 'string',
            searchable: true,
            hint: 'Where this leg arrives, written the same way as the departure airport',
          },
          {
            key: 'date',
            kind: 'string',
            hint: 'The day this leg departs, as yyyy-mm-dd, taken from the departure date printed beside the flight',
          },
          {
            key: 'departure',
            kind: 'string',
            hint: 'The departure time as printed, local to the departure airport, e.g. "18:45"',
          },
          {
            key: 'arrival',
            kind: 'string',
            hint: 'The arrival time as printed, local to the arrival airport',
          },
          {
            key: 'seat',
            kind: 'string',
            hint: 'The seat as printed, e.g. "12A" — a ticket issued before check-in names none',
          },
          {
            key: 'class',
            kind: 'string',
            hint: 'The cabin or fare as printed — "Economy", "Business", or the single booking-class letter where that is all the paper gives',
          },
          {
            key: 'ticketNumber',
            kind: 'string',
            searchable: true,
            hint: 'The ticket number in the airline\'s own digits, e.g. "235 2400161930" — one per passenger, repeated on each of that passenger\'s coupons, and not the booking reference',
          },
        ],
      },
    ],
  },
  // One `invoice` for a bill however many providers it collects (docs/03 §3.3.10a): the paper is one
  // bill with one payable total, and its lines each name whose service they are. The bill states its
  // currency once, on `totalDue`; every amount on a line is a bare number in it.
  {
    typeSlug: 'invoice',
    version: 1,
    fields: [
      {
        key: 'vendor',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The biller whose name heads the paper and whose account the money is asked for — on a combined municipal bill the collector everyone pays, not the providers its lines name',
      },
      {
        key: 'accountNumber',
        kind: 'string',
        searchable: true,
        hint: 'The customer\'s own account with this biller, as printed — "лицевой счёт", "šifra kupca", "customer number", "account no." — the number a payment quotes to be credited to this household, and not the number of the bill',
      },
      {
        key: 'invoiceNumber',
        kind: 'string',
        searchable: true,
        hint: "The bill's own number, exactly as printed — what tells this month's paper from last month's",
      },
      {
        key: 'billingPeriod',
        kind: 'string',
        summary: true,
        hint: 'The month the bill charges for, as yyyy-mm — the period the lines are accrued for ("за июль 2026", "obračunski period 07/2026"), which is usually the month before the one it was issued in. A bill covering a stretch that is not a month: the month it begins in',
      },
      { key: 'issuedAt', kind: 'date', hint: 'The day the bill was made out, as yyyy-mm-dd' },
      {
        key: 'dueAt',
        kind: 'date',
        summary: true,
        hint: 'The last day it can be paid without a penalty, as yyyy-mm-dd — "оплатить до", "rok plaćanja", "due date", "payment by"',
      },
      {
        key: 'totalDue',
        kind: 'money',
        summary: true,
        hint: 'The figure actually asked for, with its ISO 4217 currency: the "к оплате" / "za uplatu" / "total due" line at the foot, with debt carried over and penalties folded in wherever the paper folds them in — not the sum of this month\'s lines where the two differ. The currency is stated here and only here: the line amounts are bare numbers in it',
      },
      {
        key: 'previousBalance',
        kind: 'money',
        hint: 'What was owed before this bill, with its currency — the "задолженность", "dug" or "previous balance" row, negative where the paper shows an overpayment. A bill settled last month states zero or nothing at all',
      },
      {
        key: 'paidAt',
        kind: 'date',
        hint: 'The day this bill was paid, as yyyy-mm-dd, where the paper itself knows it: a bank stamp, a "плачено"/"paid" mark, a payment slip printed on the same sheet. A bill that has not been paid on the paper says nothing here, and a person notes the day after paying',
      },
      {
        key: 'paymentReference',
        kind: 'string',
        searchable: true,
        hint: 'The string a bank statement carries back to this paper — "poziv na broj", "назначение платежа", the payment reference, or the digits under the barcode — copied exactly, digits, dashes and all',
      },
      {
        key: 'items',
        kind: 'table',
        hint: 'One row per line the bill charges, in printed order — the positions, not the totals row under them. A single-provider bill names the same provider on every row; the combined municipal bill names a different one per line, several of them under the one payable total',
        columns: [
          {
            key: 'provider',
            kind: 'string',
            searchable: true,
            hint: "Who renders this line's service — on a combined bill the water, heating or waste company printed beside the line; on a single-provider bill the vendor again, on every row",
          },
          {
            key: 'service',
            kind: 'string',
            searchable: true,
            hint: 'What is charged for, as the line names it — "холодная вода", "odvoz smeća", "grid access", a standing charge, a service fee',
          },
          {
            key: 'quantity',
            kind: 'number',
            hint: 'How much was consumed or charged for, as a bare number: the cubic metres, kilowatt-hours, square metres or months on the line',
          },
          {
            key: 'unit',
            kind: 'string',
            hint: 'What that quantity is counted in, as printed — "m3", "kWh", "Gcal", "м2", "мес."',
          },
          {
            key: 'rate',
            kind: 'number',
            hint: "The price of one unit, as the line prints it — a bare number in the bill's currency",
          },
          {
            key: 'accrued',
            kind: 'number',
            hint: 'What this line comes to before any adjustment — the "начислено" / "obračunato" amount, quantity times rate as the paper prints it',
          },
          {
            key: 'adjustment',
            kind: 'number',
            hint: 'What is added to or taken off this line, signed as it changes the amount: a recalculation for an earlier period (перерасчёт) positive or negative as printed, a discount (popust) negative. A line with neither carries none',
          },
          {
            key: 'due',
            kind: 'number',
            hint: 'What this line itself asks for — its own "к оплате" / "za plaćanje" after the adjustment — a bare number in the bill\'s one currency',
          },
        ],
      },
    ],
  },
  // One row per analyte, panels flattened (docs/03 §3.3.10a): the headings a lab report groups its
  // results under are typography, not structure. The value is a string because "positive" is a
  // result, and the date that matters is the one the sample was taken on.
  {
    typeSlug: 'lab-report',
    version: 1,
    fields: [
      {
        key: 'patient',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The person the sample was taken from, as the report prints the name — not the doctor who ordered the analysis, whose name is usually beside it, and not whoever paid for it',
      },
      {
        key: 'facility',
        kind: 'string',
        searchable: true,
        hint: 'The laboratory or clinic that ran the analysis and signs the result, as printed at the head of the report. Where a collection point and a laboratory are both named, the laboratory that produced the numbers',
      },
      {
        key: 'orderNumber',
        kind: 'string',
        searchable: true,
        hint: 'The number this report is filed under at the laboratory — "order", "accession", "заказ №", "broj uputa", "lab ID", often repeated in the barcode — exactly as printed, and not the patient\'s card or insurance number',
      },
      {
        key: 'collectedAt',
        kind: 'date',
        summary: true,
        hint: 'The day the sample was taken, as yyyy-mm-dd — "дата взятия", "uzorkovanje", "collected", "sample date". This is the day the result speaks about; where the paper prints only one date, it is this one',
      },
      {
        key: 'reportedAt',
        kind: 'date',
        hint: 'The day the laboratory issued the result, as yyyy-mm-dd — "дата выдачи", "izdato", "reported", the day beside the signature — a day or two after the sample was taken, and sometimes longer',
      },
      {
        key: 'results',
        kind: 'table',
        hint: 'One row per analyte, in printed order, with the panels flattened: a blood count, a biochemistry panel and a single serology test on one report are rows of one table. A heading grouping them is not a row of its own, and neither is a subtotal',
        columns: [
          {
            key: 'analyte',
            kind: 'string',
            searchable: true,
            hint: 'What was measured, as the report names it — "Hemoglobin", "Гемоглобин", "Glucose", "TSH", "Anti-HBs" — the analyte alone, without the panel heading above it and without the method in brackets after it',
          },
          {
            key: 'value',
            kind: 'string',
            hint: 'The result as printed: the number where the analyte is measured, the word where it is judged — "positive", "negative", "not detected". Copied as it stands, "<" or ">" kept where the instrument prints one, comma or dot as the report uses, and the unit left to its own column',
          },
          {
            key: 'unit',
            kind: 'string',
            hint: 'What the result is counted in, as printed — "g/L", "10^9/L", "mmol/L", "мкМЕ/мл". A qualitative result has none',
          },
          {
            key: 'reference',
            kind: 'string',
            hint: 'The normal interval printed beside the result — "4.0–9.0", "< 5.7", "negative", "муж. 130–160" — copied whole, exactly as it stands, including the sex or age it is qualified by',
          },
          {
            key: 'flag',
            kind: 'string',
            hint: 'The mark the report puts against a result outside its interval — "H", "L", "↑", "↓", "abnormal", an asterisk — or the short note printed in that column instead. A result inside the interval carries none',
          },
        ],
      },
    ],
  },
  // The state papers on numbered blanks (docs/03 §3.3.10a): a registry office prints a birth, a
  // death, a marriage or a divorce on a form that never expires, and whose number is the form's.
  // Who the paper is about stays on the document's people links (§3.3.19) — it is not a field here.
  {
    typeSlug: 'civil-certificate',
    version: 1,
    fields: [
      {
        key: 'certificateNumber',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The number of the blank itself, series and number together as printed — "II-МЮ № 123456", "Ser. A No. 004512" — the identifier struck on the form, which is not the number of the act record behind it',
      },
      {
        key: 'actNumber',
        kind: 'string',
        searchable: true,
        hint: 'The number of the record in the registry book — "запись акта о рождении №", "matični broj upisa", "entry no." — the number a duplicate of this certificate is later issued against',
      },
      {
        key: 'actDate',
        kind: 'date',
        hint: 'The day that record was entered in the registry book, as yyyy-mm-dd — days or weeks after the event itself, and often years before this particular blank was printed',
      },
      {
        key: 'issuedBy',
        kind: 'string',
        searchable: true,
        hint: 'The registry office that issued it, as printed — the ЗАГС, the matična služba, the register office — with the district and town the paper names',
      },
      {
        key: 'eventDate',
        kind: 'date',
        summary: true,
        hint: 'The day of the event this paper certifies — the birth, the death, the marriage, the divorce — as yyyy-mm-dd. Not the day the certificate was made out',
      },
      {
        key: 'eventPlace',
        kind: 'string',
        searchable: true,
        hint: 'Where that event happened, as printed — the town, with the district, republic or country where the paper spells them out',
      },
      {
        key: 'issuedAt',
        kind: 'date',
        hint: 'The day this blank was made out and handed over, as yyyy-mm-dd — on a duplicate drawn decades after the event, its own recent day',
      },
    ],
  },
];

export function fieldSchemaFor(typeSlug: string | null | undefined): DocumentFieldSchema | null {
  if (typeSlug === null || typeSlug === undefined) return null;
  return DOCUMENT_FIELD_SCHEMAS.find((schema) => schema.typeSlug === typeSlug) ?? null;
}

// --- the stored answer (docs/03 §3.3.10a) -------------------------------------------------------

// AUTO or MANUAL only: a field with no value has no entry, and that is its NONE.
export const extractedFieldSourceSchema = z.enum(['AUTO', 'MANUAL']);
export type ExtractedFieldSource = z.infer<typeof extractedFieldSourceSchema>;

export const extractedFieldsSchema = z.object({
  // Which vocabulary the values speak — kept with them so a reading survives the registry moving on.
  schema: z.object({ slug: z.string(), version: z.number().int() }),
  values: z.record(z.unknown()),
  sources: z.record(extractedFieldSourceSchema),
});
export type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

// The summary-flagged values as stored; the client formats them by this very registry.
export const extractedSummarySchema = z.record(z.unknown());
export type ExtractedSummary = z.infer<typeof extractedSummarySchema>;

export const moneyValueSchema = z.object({
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export type MoneyValue = z.infer<typeof moneyValueSchema>;

// --- per-field validation (docs/03 §3.3.10a: in code, not in the model's gift) ------------------

const MAX_STRING_CHARS = 500;
const MAX_CELL_CHARS = 200;
const MAX_TABLE_ROWS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value === '') return undefined;
  return value.slice(0, maxChars);
}

function cleanNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  // Models print numbers the way receipts do; "12.40" and "12,40" are both the number.
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace(/\s+/g, '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// A real calendar day in a plausible century — the documentDate rule (docs/03 §3.3.10):
// `2026-02-31` parses as a string and means nothing.
function cleanDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2100) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

function cleanMoney(raw: unknown): MoneyValue | undefined {
  if (!isRecord(raw)) return undefined;
  const amount = cleanNumber(raw['amount']);
  const currencyRaw = raw['currency'];
  const currency = typeof currencyRaw === 'string' ? currencyRaw.trim().toUpperCase() : undefined;
  if (amount === undefined || currency === undefined || !/^[A-Z]{3}$/.test(currency)) {
    return undefined;
  }
  return { amount, currency };
}

function cleanCell(column: DocumentFieldColumn, raw: unknown): string | number | undefined {
  if (column.kind !== 'string') return cleanNumber(raw);
  // A column typed `string` because it must hold both — a lab result is 6.31 as readily as it is
  // "positive" — keeps a number the model answered as the digits it printed, rather than dropping
  // half of what the column exists for (docs/03 §3.3.10a).
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  return cleanString(value, MAX_CELL_CHARS);
}

// Row by row, cell by cell: an unreadable cell is dropped, a row with nothing readable goes with it.
function cleanTable(
  spec: DocumentFieldSpec,
  raw: unknown,
): Array<Record<string, string | number>> | undefined {
  if (!Array.isArray(raw) || spec.columns === undefined) return undefined;
  const rows: Array<Record<string, string | number>> = [];
  for (const rowRaw of raw.slice(0, MAX_TABLE_ROWS)) {
    if (!isRecord(rowRaw)) continue;
    const row: Record<string, string | number> = {};
    for (const column of spec.columns) {
      const cell = cleanCell(column, rowRaw[column.key]);
      if (cell !== undefined) row[column.key] = cell;
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return rows.length > 0 ? rows : undefined;
}

// The validated value, or undefined for one that does not parse as its kind — dropped, so an
// invented value in one field cannot discard a good one beside it (docs/05 §5.5 step 5).
export function validateFieldValue(spec: DocumentFieldSpec, raw: unknown): unknown {
  if (raw === null || raw === undefined) return undefined;
  switch (spec.kind) {
    case 'string':
      return cleanString(raw, MAX_STRING_CHARS);
    case 'number':
      return cleanNumber(raw);
    case 'date':
      return cleanDate(raw);
    case 'money':
      return cleanMoney(raw);
    case 'table':
      return cleanTable(spec, raw);
  }
}

// A model's whole answer reduced to the fields that parse. Unknown keys are not values.
export function sanitizeFieldValues(
  schema: DocumentFieldSchema,
  raw: unknown,
): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const values: Record<string, unknown> = {};
  for (const spec of schema.fields) {
    const value = validateFieldValue(spec, raw[spec.key]);
    if (value !== undefined) values[spec.key] = value;
  }
  return values;
}

// --- a person's edit (docs/07 §7.3: PATCH `fields`) ---------------------------------------------

export type FieldPatchIssue = { key: string; reason: 'UNKNOWN_FIELD' | 'INVALID_VALUE' };

// Each key set becomes MANUAL; null clears value and source both. A key the schema does not know,
// or a value the wrong shape for its kind, is an issue the caller is told about — never bent to fit.
export function validateFieldsPatch(
  schema: DocumentFieldSchema,
  patch: Record<string, unknown>,
): { values: Record<string, unknown>; issues: FieldPatchIssue[] } {
  const values: Record<string, unknown> = {};
  const issues: FieldPatchIssue[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    const spec = schema.fields.find((field) => field.key === key);
    if (spec === undefined) {
      issues.push({ key, reason: 'UNKNOWN_FIELD' });
      continue;
    }
    if (raw === null) {
      values[key] = null;
      continue;
    }
    const value = validateFieldValue(spec, raw);
    if (value === undefined) {
      issues.push({ key, reason: 'INVALID_VALUE' });
      continue;
    }
    values[key] = value;
  }
  return { values, issues };
}

// --- projections --------------------------------------------------------------------------------

function searchTermsOf(spec: DocumentFieldSpec, value: unknown): string[] {
  if (spec.kind === 'table') {
    if (!Array.isArray(value) || spec.columns === undefined) return [];
    const searchableColumns = spec.columns.filter((column) => column.searchable === true);
    const terms: string[] = [];
    for (const row of value) {
      if (!isRecord(row)) continue;
      for (const column of searchableColumns) {
        const cell = row[column.key];
        if (typeof cell === 'string' && cell !== '') terms.push(cell);
      }
    }
    return terms;
  }
  if (spec.searchable !== true) return [];
  return typeof value === 'string' && value !== '' ? [value] : [];
}

// What the FTS column reads (docs/04 §4.3): the searchable values, flattened to text.
export function extractedSearchTextOf(
  schema: DocumentFieldSchema,
  values: Record<string, unknown>,
): string | null {
  const terms = schema.fields.flatMap((spec) => searchTermsOf(spec, values[spec.key]));
  return terms.length > 0 ? terms.join('\n') : null;
}

// What a card may show (docs/11 §11.3): the summary-flagged values, in schema order.
export function summaryValuesOf(
  schema: DocumentFieldSchema,
  values: Record<string, unknown>,
): ExtractedSummary | null {
  const summary: Record<string, unknown> = {};
  for (const spec of schema.fields) {
    if (spec.summary !== true) continue;
    const value = values[spec.key];
    if (value !== undefined && value !== null) summary[spec.key] = value;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}
