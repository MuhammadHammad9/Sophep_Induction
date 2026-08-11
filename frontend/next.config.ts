import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Domain logic lives in backend/ and is imported as source (rules.md R-003).
  transpilePackages: ['@sophep/backend'],

  // NFR-SEC-008. CSP is deliberately absent here and set per-response in middleware once
  // Supabase Realtime origins are known — a wrong CSP that blocks the websocket would take
  // out the whole live layer.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          { key: 'Permissions-Policy', value: 'geolocation=(), microphone=(), camera=(self)' },
        ],
      },
    ]
  },
}

export default nextConfig
