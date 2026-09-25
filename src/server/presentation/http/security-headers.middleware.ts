import { securityHeaders as sharedSecurityHeaders } from '@joshuan/http/express';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// Product-specific CSP origins remain here; nonce generation, API policy, header hardening, and
// caller-header replacement are shared by every service.
export function securityHeaders(options: {
  readonly usesHttps: boolean;
  readonly bucketOrigin: string | null;
  readonly development?: boolean;
}) {
  const bucket = options.bucketOrigin === null ? [] : [options.bucketOrigin];
  return sharedSecurityHeaders({
    usesHttps: options.usesHttps,
    page: {
      // Next's development runtime evaluates source maps; production never needs this source.
      scriptOrigins: options.development === true ? ["'unsafe-eval'"] : [],
      connectOrigins: [...bucket, TURNSTILE_ORIGIN],
      imageOrigins: bucket,
      objectOrigins: bucket,
    },
  });
}
