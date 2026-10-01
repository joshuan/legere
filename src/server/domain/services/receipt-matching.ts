import type {
  ReceiptMatchConflict,
  ReceiptMatchKind,
  ReceiptMatchReason,
} from '../../../shared/contracts/receipt-duplicates';
import type { ReceiptExtraction } from '../../../shared/contracts/receipts';
import { moneyValueSchema } from '../../../shared/contracts/document-fields';

type Values = Record<string, unknown>;
export type ReceiptMatch = {
  kind: ReceiptMatchKind;
  reasons: ReceiptMatchReason[];
  conflicts: ReceiptMatchConflict[];
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').toLocaleLowerCase('en').trim() : '';
}
function identifier(value: unknown): string {
  return text(value).replace(/[^\p{L}\p{N}]/gu, '');
}
function equalKnown(first: string, second: string): boolean {
  return first !== '' && first === second;
}
function distinctKnown(first: string, second: string): boolean {
  return first !== '' && second !== '' && first !== second;
}
const LEGAL_WORDS = new Set([
  'doo',
  'доо',
  'llc',
  'ltd',
  'inc',
  'pos',
  'bank',
  'banka',
  'unknown',
  'неизвестно',
]);
function merchantWords(values: Values): Set<string>[] {
  return [text(values.vendor), text(values.statementDescriptor)].map(
    (name) =>
      new Set(
        name
          .normalize('NFKD')
          .replace(/\p{M}/gu, '')
          .split(/[^\p{L}\p{N}]+/u)
          .filter((word) => word.length >= 3 && !LEGAL_WORDS.has(word)),
      ),
  );
}
function minute(value: unknown): number | null {
  const parsed = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(text(value));
  if (parsed === null) return null;
  const hour = Number(parsed[1]);
  const min = Number(parsed[2]);
  return hour < 24 && min < 60 ? hour * 60 + min : null;
}
function card(value: unknown): string {
  const digits = text(value).replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}
function isRecord(value: unknown): value is Values {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function items(values: Values): { count: number; signature: string | null } {
  if (!Array.isArray(values.items)) return { count: 0, signature: null };
  const rows = values.items.filter(isRecord);
  const signatures = rows
    .flatMap((item) => {
      const name = identifier(item.name);
      if (name.length < 3) return [];
      // Line amounts are bare numbers in the receipt's currency; only the grand total is money.
      if (
        typeof item.amount !== 'number' ||
        !Number.isFinite(item.amount) ||
        typeof item.quantity !== 'number' ||
        !Number.isFinite(item.quantity)
      )
        return [];
      return [JSON.stringify([name, item.quantity, item.amount])];
    })
    .sort();
  return {
    count: rows.length,
    signature: signatures.length === rows.length ? JSON.stringify(signatures) : null,
  };
}

/** Suggestions only. Equality of date and amount alone never identifies a purchase. */
export function matchReceipts(
  first: ReceiptExtraction | null,
  second: ReceiptExtraction | null,
): ReceiptMatch {
  const a = first?.values ?? {};
  const b = second?.values ?? {};
  const reasons: ReceiptMatchReason[] = [];
  const conflicts: ReceiptMatchConflict[] = [];
  const dateA = text(a.purchasedAt);
  const dateB = text(b.purchasedAt);
  const parsedDate = new Date(`${dateA}T00:00:00.000Z`);
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(dateA) &&
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === dateA &&
    equalKnown(dateA, dateB);
  const totalA = moneyValueSchema.safeParse(a.total);
  const totalB = moneyValueSchema.safeParse(b.total);
  const total =
    totalA.success &&
    totalB.success &&
    totalA.data.amount === totalB.data.amount &&
    totalA.data.currency === totalB.data.currency;
  if (date) reasons.push('date');
  else if (distinctKnown(dateA, dateB)) conflicts.push('date');
  if (total) reasons.push('total');
  if (totalA.success && totalB.success) {
    if (totalA.data.amount !== totalB.data.amount) conflicts.push('total');
    if (totalA.data.currency !== totalB.data.currency) conflicts.push('currency');
  }
  const wordsA = merchantWords(a);
  const wordsB = merchantWords(b);
  // A shared city or generic word in two longer names is not a merchant identity.
  const merchant = wordsA.some((left) =>
    wordsB.some((right) => {
      const overlap = [...left].filter((word) => right.has(word)).length;
      return overlap > 0 && overlap / Math.min(left.size, right.size) >= 0.8;
    }),
  );
  if (merchant) reasons.push('merchant');
  else if (wordsA.some((words) => words.size > 0) && wordsB.some((words) => words.size > 0))
    conflicts.push('merchant');

  const tax =
    identifier(a.vendorTaxId).length >= 5 &&
    equalKnown(identifier(a.vendorTaxId), identifier(b.vendorTaxId));
  const number =
    identifier(a.receiptNumber).length >= 3 &&
    equalKnown(identifier(a.receiptNumber), identifier(b.receiptNumber));
  if (tax) reasons.push('taxId');
  else if (distinctKnown(identifier(a.vendorTaxId), identifier(b.vendorTaxId)))
    conflicts.push('taxId');
  if (number) reasons.push('number');
  else if (distinctKnown(identifier(a.receiptNumber), identifier(b.receiptNumber)))
    conflicts.push('number');
  const timeA = minute(a.purchasedTime);
  const timeB = minute(b.purchasedTime);
  const distance = timeA === null || timeB === null ? null : Math.abs(timeA - timeB);
  const closeTime = distance !== null && distance <= 10;
  if (closeTime) reasons.push('time');
  else if (distance !== null) conflicts.push('time');
  const sameCard = equalKnown(card(a.card), card(b.card));
  if (sameCard) reasons.push('card');
  else if (distinctKnown(card(a.card), card(b.card))) conflicts.push('card');
  const itemsA = items(a);
  const itemsB = items(b);
  const sameItems =
    itemsA.count > 0 && itemsA.signature !== null && itemsA.signature === itemsB.signature;
  if (sameItems) reasons.push('items');
  else if (itemsA.count > 0 && itemsB.count > 0) conflicts.push('items');

  const result = (kind: ReceiptMatchKind): ReceiptMatch => ({ kind, reasons, conflicts });
  if (!date || !total || (!merchant && !tax && !(sameCard && closeTime))) return result('manual');
  if (distance !== null && distance > 30 && !number) return result('manual');
  if (itemsA.count > 0 !== itemsB.count > 0 && (closeTime || tax || number)) return result('parts');
  if ((number || sameItems) && !conflicts.includes('taxId') && !conflicts.includes('card'))
    return result('duplicate');
  return result('possible');
}
