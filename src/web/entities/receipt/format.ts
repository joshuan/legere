// Receipt amounts use the selected interface locale, consistently during SSR and hydration.
export function moneyValue(value: unknown, locale: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('amount' in value) || !('currency' in value)) return null;
  if (typeof value.amount !== 'number' || typeof value.currency !== 'string') return null;
  return `${value.amount.toLocaleString(locale)} ${value.currency}`;
}
