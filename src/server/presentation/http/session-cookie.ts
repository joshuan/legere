import type { CookieOptions, Response } from 'express';
import type { AppConfig } from '../../infrastructure/config/app-config';

// Session cookie attributes (docs/08 §8.2): HttpOnly, Secure in production, SameSite=Lax, Path=/,
// Max-Age = SESSION_TTL_DAYS, Domain from COOKIE_DOMAIN when set.
export const SESSION_COOKIE_NAME = 'sid';

// The locale cookie next-intl reads for SSR (docs/10 §10.3). Not HttpOnly: the client reads it too.
export const LOCALE_COOKIE_NAME = 'NEXT_LOCALE';

function baseOptions(config: AppConfig): CookieOptions {
  const domain = config.get('COOKIE_DOMAIN');
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    ...(domain === '' ? {} : { domain }),
  };
}

export function setSessionCookie(res: Response, config: AppConfig, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...baseOptions(config),
    maxAge: config.get('SESSION_TTL_DAYS') * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(SESSION_COOKIE_NAME, baseOptions(config));
}

// Keeps SSR rendering in the user's language after login or a profile change (docs/10 §10.3).
export function setLocaleCookie(res: Response, config: AppConfig, language: string): void {
  const domain = config.get('COOKIE_DOMAIN');
  res.cookie(LOCALE_COOKIE_NAME, language.toLowerCase(), {
    httpOnly: false,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    ...(domain === '' ? {} : { domain }),
  });
}
