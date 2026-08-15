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
  {
    typeSlug: 'receipt',
    version: 1,
    fields: [
      {
        key: 'vendor',
        kind: 'string',
        searchable: true,
        summary: true,
        hint: 'The merchant, as printed on the receipt',
      },
      {
        key: 'purchasedAt',
        kind: 'date',
        summary: true,
        hint: 'The purchase date printed on the receipt, as yyyy-mm-dd',
      },
      {
        key: 'total',
        kind: 'money',
        summary: true,
        hint: 'The grand total actually paid, with its ISO 4217 currency',
      },
      {
        key: 'items',
        kind: 'table',
        hint: 'The line items of the receipt, in printed order',
        columns: [
          { key: 'name', kind: 'string', searchable: true, hint: 'The item as printed' },
          { key: 'quantity', kind: 'number', hint: 'How many, when printed' },
          { key: 'amount', kind: 'number', hint: 'The line total, in the receipt currency' },
        ],
      },
    ],
  },
  {
    typeSlug: 'passport',
    version: 1,
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
  {
    typeSlug: 'id-card',
    version: 1,
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
        key: 'issuedBy',
        kind: 'string',
        searchable: true,
        hint: 'The issuing authority as printed',
      },
      { key: 'issuedAt', kind: 'date', hint: 'The date of issue, as yyyy-mm-dd' },
      { key: 'expiresAt', kind: 'date', summary: true, hint: 'The expiry date, as yyyy-mm-dd' },
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
  return column.kind === 'string' ? cleanString(raw, MAX_CELL_CHARS) : cleanNumber(raw);
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
