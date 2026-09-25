import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// Locale is not in the URL (ADR-016, docs/10 §10.3). Resolution order: NEXT_LOCALE cookie (written
// after login and profile changes) → Accept-Language → en.
import { pickLocale, TIME_ZONE } from './locale';
export { pickLocale, TIME_ZONE } from './locale';

const LOCALE_COOKIE = 'NEXT_LOCALE';

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
