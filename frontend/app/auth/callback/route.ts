/**
 * GET /auth/callback — exchange the emailed one-time code for a session cookie.
 *
 * The other half of the magic link. Supabase sends the volunteer to this URL with a `code`;
 * `exchangeCodeForSession` verifies it against the auth server and writes the session cookies,
 * which is the only reason this must be a server route rather than a client page — the cookies
 * have to be `httpOnly`, and a client cannot set those.
 *
 * A thin handler (R-003): it verifies, sets a cookie, and redirects. No domain logic.
 *
 * Refs: FR-RBAC-001, NFR-SEC-006, rules.md R-003, audit H-6
 */

import { NextResponse, type NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/auth/session'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const next = safeNext(url.searchParams.get('next'))

  if (!code) {
    return NextResponse.redirect(new URL('/staff/sign-in?error=missing_code', url.origin))
  }

  const supabase = await supabaseServer()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Expired, already used, or not ours. All three mean "ask for another link", and saying
    // which would tell someone holding a stale link something about its state.
    console.warn('auth callback exchange failed', error.message)
    return NextResponse.redirect(new URL('/staff/sign-in?error=link_invalid', url.origin))
  }

  // Always relative to OUR origin. `url.origin` rather than a caller-supplied host, so a
  // forged Host header cannot turn a successful sign-in into a redirect somewhere else.
  return NextResponse.redirect(new URL(next, url.origin))
}

/** Same rule as the sign-in page: same-origin absolute paths only, and `//host` is not one. */
function safeNext(next: string | null): string {
  if (!next) return '/'
  if (!next.startsWith('/') || next.startsWith('//')) return '/'
  return next
}
