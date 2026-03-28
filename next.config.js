/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable server-side features for better-sqlite3
  serverExternalPackages: ['better-sqlite3'],

  // Allow external images for next/image optimization
  // Explicit allowlist — wildcard hostname enables SSRF/open-proxy abuse
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'oaidalleapiprodscus.blob.core.windows.net' },
      { protocol: 'https', hostname: 'api.dicebear.com' },
    ],
  },
};

module.exports = nextConfig;
