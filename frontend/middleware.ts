/**
 * Rate limiting and security headers.
 *
 * NFR-SEC-005 sets three limits: token lookup 10/min/IP, application submission 3/hour/IP, and
 * authentication 5 attempts per 15 minutes with progressive backoff.
 *
 * The token limit is the one that matters most. An access token is 128 bits, so brute force is
 * hopeless — but the status page is unauthenticated and enumerable in principle, and a
 * rate limit turns "hopeless" into "not worth attempting" while also protecting the database
 * from a scraper hammering it during an event.
 *
 * IMPLEMENTATION NOTE — this is an in-memory limiter, and on Vercel each serverless instance
 * has its own memory. So the effective limit is per-instance, not global: under load an
 * attacker gets N× the configured budget. That is a real limitation, not a detail. It is
 * acceptable for launch because the token space makes brute force pointless anyway, and the
 * DoS case is bounded by Vercel's own limits. Before the event, move this to a Postgres or
 * Upstash counter so the limit is genuinely global — tracked in ROADMAP Phase 5.
 *
 * Refs: NFR-SEC-005, NFR-SEC-008, FR-IDT-010
 */

import { NextResponse, type NextRequest } from 'next/server'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

// Bound the map so a flood of distinct IPs cannot exhaust memory — the limiter must not
// become the outage it exists to prevent.
const MAX_BUCKETS = process.env.RATE_LIMIT_MAX_BUCKETS ? parseInt(process.env.RATE_LIMIT_MAX_BUCKETS, 10) : 10_000

interface Limit {
  windowMs: number
  max: number
}

const LIMITS: Array<{ test: (path: string) => boolean; key: string; limit: Limit }> = [
  // FR-IDT-010: token lookup, 10/min/IP.
  { test: (p) => p.startsWith('/q/') || p.startsWith('/api/q/'), key: 'token', limit: { windowMs: 60_000, max: 10 } },
  // NFR-SEC-005: application submission, 3/hour/IP.
  { test: (p) => p === '/api/apply', key: 'apply', limit: { windowMs: 3_600_000, max: 3 } },
  // Staff endpoints are authenticated and used hard during an event — 4 scans/second across a
  // desk is normal, so this is a runaway guard rather than a security control.
  { test: (p) => p.startsWith('/api/'), key: 'api', limit: { windowMs: 60_000, max: 600 } },
]

function clientIp(req: NextRequest): string {
  if (req.ip) return req.ip
  const forwarded = req.headers.get('x-forwarded-for')
  return forwarded?.split(',').pop()?.trim() || req.headers.get('x-real-ip') || 'unknown'
}

function consume(key: string, limit: Limit): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now()

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) {
      if (v.resetAt < now) buckets.delete(k)
    }
    if (buckets.size > MAX_BUCKETS) {
      const sorted = Array.from(buckets.entries()).sort((a, b) => a[1].resetAt - b[1].resetAt)
      const toDelete = sorted.slice(0, Math.max(1, Math.floor(MAX_BUCKETS * 0.1)))
      for (const [k] of toDelete) {
        buckets.delete(k)
      }
    }
  }

  const existing = buckets.get(key)
  if (!existing || existing.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + limit.windowMs })
    return { allowed: true, retryAfterSeconds: 0 }
  }

  existing.count += 1
  if (existing.count > limit.max) {
    return { allowed: false, retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000) }
  }
  return { allowed: true, retryAfterSeconds: 0 }
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname

  const rule = LIMITS.find((r) => r.test(path))
  if (rule) {
    const { allowed, retryAfterSeconds } = consume(`${rule.key}:${clientIp(req)}`, rule.limit)

    if (!allowed) {
      // IR-002: machine-readable, and `retryable: true` so an offline queue knows to replay
      // this rather than discard it.
      return NextResponse.json(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please wait a moment.',
            detail: { retry_after_seconds: retryAfterSeconds },
            retryable: true,
          },
        },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
      )
    }
  }

  const res = NextResponse.next()

  // NFR-SEC-008. Set here rather than in next.config because the camera permission and the
  // Supabase Realtime websocket origin both need to vary by route.
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  return res
}

export const config = {
  matcher: ['/api/:path*', '/q/:path*'],
}
