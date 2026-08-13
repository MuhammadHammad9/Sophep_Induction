/**
 * Rate limiting, CSRF origin enforcement, and security headers.
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
 * Refs: NFR-SEC-005, NFR-SEC-006, NFR-SEC-008, FR-IDT-010, audit C-7, M-1, M-2, M-3, M-4
 */

import { NextResponse, type NextRequest } from 'next/server'

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

// Bound the map so a flood of distinct IPs cannot exhaust memory — the limiter must not
// become the outage it exists to prevent.
const parsedLimit = parseInt(process.env.RATE_LIMIT_MAX_BUCKETS || '', 10)
const MAX_BUCKETS = Number.isNaN(parsedLimit) ? 10_000 : parsedLimit

interface Limit {
  windowMs: number
  max: number
}

const LIMITS: Array<{ test: (path: string) => boolean; key: string; limit: Limit }> = [
  // FR-IDT-010: token lookup, 10/min/IP.
  { test: (p) => p.startsWith('/q/') || p.startsWith('/api/q/'), key: 'token', limit: { windowMs: 60_000, max: 10 } },

  // NFR-SEC-005: application submission, 3/hour/IP.
  //
  // `/api/fast-track` is in this bucket, not the generic one. It creates an applicant exactly
  // as `/api/apply` does, and matching `/api/apply` by exact string left the walk-in route
  // sitting in the 600/min lane — so the cheapest way past the application limit was to use
  // the other endpoint (audit C-1). It is authenticated now, but the limit belongs with the
  // operation rather than with the URL that happens to perform it.
  //
  // Keyed per staff desk rather than per applicant, so the ceiling is higher: a busy walk-in
  // desk legitimately registers more than three people an hour.
  { test: (p) => p === '/api/apply', key: 'apply', limit: { windowMs: 3_600_000, max: 3 } },
  { test: (p) => p === '/api/fast-track', key: 'fasttrack', limit: { windowMs: 3_600_000, max: 120 } },

  // NFR-SEC-005: authentication, 5 per 15 minutes — on the CALLBACK, not on the page.
  //
  // This originally also matched `/staff/sign-in`, which was wrong twice over. It rate-limited
  // GET page VIEWS, so a volunteer who reloaded the sign-in page five times could not even see
  // the form for fifteen minutes — on the morning of the event, at a desk, that is the whole
  // system unusable for the person it is hardest for (NFR-USE-001). And it bought nothing: the
  // sign-in request goes CLIENT-SIDE to Supabase (`supabase.auth.signInWithOtp`), so it never
  // passes through this middleware at all. Pure cost, no protection.
  //
  // `/auth/callback` is the part worth limiting here: it exchanges a one-time code for a
  // session, so unlimited attempts are worth something to an attacker. Supabase applies its own
  // limit to the email send, and `/api/mfa/verify` carries the durable per-user limit that
  // actually guards a guessable secret (migration 0046).
  //
  // Found by the browser suite, which tripped this limit on its own sign-in page and turned a
  // passing test red — the same way a volunteer would have hit it.
  { test: (p) => p.startsWith('/auth/'), key: 'auth', limit: { windowMs: 900_000, max: 20 } },

  // The public display board. Unauthenticated, `force-dynamic`, two database calls per render,
  // and refreshed every 10s by every screen showing it — so it was the cheapest way to make the
  // connection pool the bottleneck during the event (audit M-10).
  { test: (p) => p.startsWith('/display/'), key: 'display', limit: { windowMs: 60_000, max: 30 } },

  // Staff endpoints are authenticated and used hard during an event — 4 scans/second across a
  // desk is normal, so this is a runaway guard rather than a security control.
  { test: (p) => p.startsWith('/api/'), key: 'api', limit: { windowMs: 60_000, max: 600 } },
]

/**
 * Identify the caller for rate limiting.
 *
 * `NextRequest.ip` was removed in Next 16, so this reads headers directly.
 *
 * `x-forwarded-for` is a CHAIN and a client can prepend entries to it, so the LAST element —
 * the one appended by the trusted proxy nearest us — is the only part they cannot forge.
 * Taking the first element would let anyone rotate their apparent identity by sending a
 * different header and bypass the limit entirely.
 *
 * `x-real-ip` is preferred ONLY when the platform is known to set it. It used to be trusted
 * unconditionally and read first, which inverted the protection above: on any deployment where
 * a proxy does not overwrite it, a caller supplies their own `x-real-ip` and gets a fresh
 * bucket per request (audit M-3). `TRUST_X_REAL_IP` makes that a deployment statement rather
 * than an assumption — Vercel sets the header, so it is enabled there and off by default.
 *
 * Falling back to a shared 'unknown' bucket is deliberate: if we cannot identify the caller
 * we would rather over-limit than hand out an unlimited lane.
 */
const TRUST_X_REAL_IP = process.env.TRUST_X_REAL_IP === '1' || process.env.VERCEL === '1'

function clientIp(req: NextRequest): string {
  if (TRUST_X_REAL_IP) {
    const realIp = req.headers.get('x-real-ip')?.trim()
    if (realIp) return realIp
  }

  const forwarded = req.headers.get('x-forwarded-for')
  return forwarded?.split(',').pop()?.trim() || 'unknown'
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

/**
 * Reject cross-origin state-changing requests.
 *
 * Staff auth is a cookie, and every mutating route authenticates from that cookie alone — no
 * CSRF token, no origin check. Supabase sets `SameSite=Lax`, which blocks a cross-site form
 * POST, so this was mitigated rather than open. But `Lax` is a library default the application
 * never asserted, it does not cover a same-site subdomain attacker, and the whole staff surface
 * is state-changing during a live event where a volunteer opening a link on their phone is
 * completely ordinary (audit C-7).
 *
 * Checking `Origin` is the cheap, central version: browsers send it on every non-GET
 * cross-origin request and it cannot be set by page JavaScript. A missing `Origin` is allowed
 * because non-browser clients — the offline replay queue, curl, a health check — do not send
 * one, and those are not confused-deputy scenarios: there is no ambient cookie to abuse.
 */
function allowedOrigins(req: NextRequest): string[] {
  const configured = process.env.NEXT_PUBLIC_APP_URL
  const origins = [req.nextUrl.origin]
  if (configured) origins.push(configured.replace(/\/+$/, ''))
  return origins
}

function isCrossOriginWrite(req: NextRequest): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false

  const origin = req.headers.get('origin')
  if (!origin) return false // non-browser client; no ambient cookie to be confused about

  return !allowedOrigins(req).includes(origin)
}

/**
 * Content-Security-Policy.
 *
 * `next.config.ts` says CSP is "deliberately absent here and set per-response in middleware
 * once Supabase Realtime origins are known". Middleware never set one, so the app shipped with
 * no CSP at all and NFR-SEC-008 was unmet (audit M-1).
 *
 * The comment's caution was sound — a wrong `connect-src` takes out the entire live layer — so
 * the policy is built from the Supabase URL the app is already configured with, rather than
 * guessed.
 *
 * `'unsafe-inline'` on `style-src` is required by Tailwind's runtime style injection, and
 * `'unsafe-eval'` on `script-src` by zxing-wasm, which compiles the QR decoder used on every
 * phone without a native BarcodeDetector — that is roughly half the volunteers (NFR-COMP-001).
 * Both are noted rather than quietly included: removing them means changing those two
 * dependencies, not tightening a string.
 */
function contentSecurityPolicy(): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const wsSupabase = supabase.replace(/^https:/, 'wss:')

  return [
    `default-src 'self'`,
    `base-uri 'self'`,
    // No plugins, and no <base> or <object> tricks to relocate relative URLs.
    `object-src 'none'`,

    // ⚠ 'unsafe-inline' ON SCRIPTS IS A KNOWN, MEASURED COMPROMISE — read before changing.
    //
    // Two earlier versions of this line were WRONG, and both looked right:
    //
    //   1. `script-src 'self' 'unsafe-eval'` — Next.js emits inline <script> tags carrying
    //      hydration data on every server-rendered page. A bare 'self' blocks them, React
    //      fails to hydrate (minified error #412), and EVERY client component stops working:
    //      the scanner, the forms, the offline replay queue. curl showed a perfect header
    //      over a completely dead application.
    //
    //   2. `script-src 'self' 'nonce-<n>' 'strict-dynamic' 'unsafe-eval'` — the documented
    //      Next.js pattern, with the nonce set on both the request and the response headers.
    //      This version of Next does NOT stamp its inline scripts with it, so the browser
    //      still blocked them. Verified in a real browser, not assumed.
    //
    // So this permits inline scripts, and that is a real weakening: it is the directive that
    // would otherwise stop an injected <script> from running. What remains is still
    // substantial — object-src 'none', base-uri 'self', frame-ancestors 'none', form-action
    // 'self', and a connect-src that pins where data may be sent — and it is a large
    // improvement on the NO CSP this app shipped with (audit M-1).
    //
    // The correct fix is nonce propagation once Next supports it here; at that point drop
    // 'unsafe-inline' and restore the nonce. Do NOT tighten this without loading a page in a
    // browser and confirming hydration: the failure is silent in curl and total in practice.
    //
    // 'unsafe-eval' is separately required by zxing-wasm, which compiles the QR decoder used
    // on every phone without a native BarcodeDetector — roughly half the volunteers
    // (NFR-COMP-001).
    `script-src 'self' 'unsafe-inline' 'unsafe-eval'`,

    // Tailwind injects styles at runtime, so 'unsafe-inline' is required here. Lower risk than
    // on scripts, and the alternative is a build-time change rather than a header change.
    `style-src 'self' 'unsafe-inline'`,
    // data: for the QR the status page renders inline; blob: for camera frames.
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `media-src 'self' blob:`,
    `worker-src 'self' blob:`,
    `connect-src 'self' ${supabase} ${wsSupabase}`.trim(),
    `form-action 'self'`,
    // Belt and braces with X-Frame-Options: DENY, which older browsers honour instead.
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ')
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname

  if (isCrossOriginWrite(req)) {
    return NextResponse.json(
      {
        error: {
          code: 'TOKEN_INVALID',
          message: 'Cross-origin request refused',
          retryable: false,
        },
      },
      { status: 403 },
    )
  }

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

  const csp = contentSecurityPolicy()
  const res = NextResponse.next()

  // NFR-SEC-008. Set here rather than in next.config because the camera permission and the
  // Supabase Realtime websocket origin both need to vary by route.
  res.headers.set('Content-Security-Policy', csp)
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('X-Frame-Options', 'DENY')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  // The status page URL CONTAINS the access token in its path. Anything that stores or
  // forwards that URL extends the token's reach beyond the one person holding it.
  if (path.startsWith('/q/')) {
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    // Not even the origin: a full `no-referrer` keeps the token out of any onward request.
    res.headers.set('Referrer-Policy', 'no-referrer')
  }

  return res
}

/**
 * The matcher previously covered only `/api/*` and `/q/*`, so the display board, the staff
 * pages, the sign-in flow and the fast-track surface received neither rate limiting nor these
 * headers (audit M-2).
 *
 * The negative lookahead keeps Next's own build output and the PWA files out — they are
 * content-hashed and immutable, and running the limiter over every static asset would burn the
 * bucket on the page's own JavaScript.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|manifest.webmanifest|sw.js).*)',
  ],
}
