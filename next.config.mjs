/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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

export default nextConfig;
