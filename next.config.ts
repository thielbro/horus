import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Pin the file-tracing root to this app dir. Without it, Next walks up past the
  // worktree to a parent lockfile and nests the standalone output under the full
  // path (breaking `node server.js`). cwd is the app root during `next build`.
  outputFileTracingRoot: process.cwd(),
  // src/lib/mt-sidecar.ts uses process.cwd()/fs to locate mt_server.py, which
  // makes @vercel/nft conservatively trace the whole project root — dragging the
  // desktop/ tree (including desktop/release/*.exe prior installers) into the
  // standalone server bundle and bloating the installer ~6x. None of these dirs
  // are needed by the Next runtime, so exclude them from the trace.
  outputFileTracingExcludes: {
    '/*': [
      'desktop/**/*',
      '.git/**/*',
      'dev-notes/**/*',
      'tests/**/*',
      '**/*.exe',
      '**/*.blockmap',
    ],
  },
  serverExternalPackages: ['ws'],
  transpilePackages: ['react-map-gl', 'mapbox-gl', 'maplibre-gl'],
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: wss: data: blob:;" },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
        ],
      },
    ];
  },
};

export default nextConfig;
