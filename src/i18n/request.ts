import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Locale is not in the URL (ADR-016, docs/10 §10.3). Resolution order: NEXT_LOCALE cookie (written
// after login and profile changes) → Accept-Language → en.
export const LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

const LOCALE_COOKIE = 'NEXT_LOCALE';

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
      const [tag = '', qPart] = part.trim().split(';q=');
      return { tag: tag.trim().toLowerCase(), q: qPart === undefined ? 1 : Number(qPart) };
    })
    .filter((entry) => entry.tag !== '' && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q)
    .find((entry) => LOCALES.some((locale) => entry.tag.startsWith(locale)));

  const matched = LOCALES.find((locale) => preferred?.tag.startsWith(locale) === true);
  return matched ?? DEFAULT_LOCALE;
}

export default getRequestConfig(async () => {
  const [cookieStore, headerList] = await Promise.all([cookies(), headers()]);
  const locale = pickLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerList.get('accept-language'),
  );

  // en.json is the reference catalog (ADR-016); ru.json mirrors its keys.
  const messages =
    locale === 'ru'
      ? await import('../../messages/ru.json')
      : await import('../../messages/en.json');

  return { locale, messages: messages.default, timeZone: TIME_ZONE };
});
