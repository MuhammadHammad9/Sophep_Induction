import type { NextConfig } from 'next'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load the repo-root .env files.
 *
 * Next.js reads .env from its own project directory (`frontend/`), but this is an npm
 * workspace and the environment is shared with `backend/` — migrations, the seed script and
 * the test suite all read the same DATABASE_URL. Duplicating secrets into two files is how
 * they drift, and a drifted credential is a confusing failure rather than an obvious one.
 *
 * `.env.local` takes precedence over `.env`, matching the Next.js convention.
 * Values already present in the environment always win, so Vercel and CI are unaffected.
 */
function loadRootEnv(): void {
  for (const name of ['.env.local', '.env']) {
    const path = resolve(import.meta.dirname, '..', name)
    if (!existsSync(path)) continue

    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (!match) continue
      const [, key, rawValue] = match
      if (!key || process.env[key]) continue
      process.env[key] = rawValue!.trim().replace(/^["']|["']$/g, '')
    }
  }
}

loadRootEnv()

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Next 16 writes its own CLAUDE.md and AGENTS.md into this directory. This repository
  // already has a deliberate agent-context setup at the root — CLAUDE.md plus the blocking
  // constraints in rules.md — and a second, generated context file competing with it is
  // exactly the confusion that setup exists to prevent.
  agentRules: false,

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
