export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

// Fixed rather than taken from the machine: the server and the browser must agree on what a
// formatted date says, and the server's own zone is a deployment accident. Dates a person reads are
// formatted in the browser, in their own zone (docs/10 §10.3).
export const TIME_ZONE = 'UTC';

function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && LOCALES.some((locale) => locale === value);
}

export function pickLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue;

  const preferred = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...parameters] = part.trim().split(';');
      const quality = parameters
        .map((value) => value.trim())
        .find((value) => /^q\s*=/i.test(value));
      const q = quality === undefined ? 1 : Number(quality.split('=')[1]?.trim());
      return { tag: tag.trim().toLowerCase().split('-')[0], q };
    })
    .filter((entry) => Number.isFinite(entry.q) && entry.q > 0 && entry.q <= 1)
    .sort((a, b) => b.q - a.q)
    .find((entry) => isLocale(entry.tag));

  return isLocale(preferred?.tag) ? preferred.tag : DEFAULT_LOCALE;
}
