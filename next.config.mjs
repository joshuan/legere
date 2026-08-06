import createNextIntlPlugin from 'next-intl/plugin';

// Locale is resolved per request, not from the URL (ADR-016, docs/10 §10.3).
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Nothing is served that says what it is built on; the Express instance disables its own header
  // in server/main.ts (docs/12 §12.8).
  poweredByHeader: false,
  // The app runs inside a custom Express server (docs/02 §2.2); Next only renders pages/assets.
  eslint: {
    // Linting is a dedicated pipeline step (`npm run lint`), not part of `next build`.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type-checking is a dedicated pipeline step (`npm run typecheck`), not part of `next build`.
    ignoreBuildErrors: true,
  },
};

export default withNextIntl(nextConfig);
