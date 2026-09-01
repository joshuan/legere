import { securityHeaders as sharedSecurityHeaders } from '@joshuan/http/express';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// Product-specific CSP origins remain here; nonce generation, API policy, header hardening, and
// caller-header replacement are shared by every service.
export function securityHeaders(options: {
  readonly usesHttps: boolean;
  readonly bucketOrigin: string | null;
}) {
  const bucket = options.bucketOrigin === null ? [] : [options.bucketOrigin];
  return sharedSecurityHeaders({
    usesHttps: options.usesHttps,
    page: {
      connectOrigins: [...bucket, TURNSTILE_ORIGIN],
      imageOrigins: bucket,
      objectOrigins: bucket,
    },
  });
}
