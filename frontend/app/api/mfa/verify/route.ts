/**
 * POST /api/mfa/verify — answer the sign-in challenge.
 *
 * On success the spent step is recorded so the code cannot be replayed inside its 30-second
 * window (RFC 6238 §5.2), and a short-lived cookie records that this browser has satisfied the
 * challenge. The cookie is a CONVENIENCE marker, not the control: `requireStaff` re-derives
 * whether MFA is required from memberships on every request, and a forged cookie only skips a
 * prompt for a session that has already authenticated.
 *
 * Rate limiting is the middleware's `auth` bucket — 5 attempts per 15 minutes. A six-digit code
 * is 10^6, so an unlimited endpoint is brute-forceable in minutes; that limit is what makes the
 * code length adequate rather than decorative (NFR-SEC-005).
 *
 * Refs: FR-RBAC-008, NFR-SEC-001, NFR-SEC-005, rules.md R-003, audit H-6
 */

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { z } from 'zod'
import { withContext, verifyChallenge, enforceRateLimit, RmsError } from '@sophep/backend'
import { requireStaff, unauthorized, invalid, MFA_COOKIE } from '@/lib/auth/session'

const bodySchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator'),
})

export async function POST(req: Request) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Invalid code')
  }

  try {
    await withContext(staff.context, async (tx) => {
      // GLOBAL, not per-instance. The in-memory limiter in middleware gives each serverless
      // instance its own budget, and against a six-digit code that difference is the whole
      // control — 10^6 with five attempts per 15 minutes is hopeless, five attempts PER
      // INSTANCE across an autoscaling fleet is not (audit S-4).
      //
      // Keyed on the user, not the IP: an attacker with a stolen session cookie changes IP
      // freely, and the thing being protected is this account's second factor.
      await enforceRateLimit(tx, 'mfa', staff.userId)
      await verifyChallenge(tx, parsed.data.code)
    })

    const jar = await cookies()
    jar.set(MFA_COOKIE, staff.userId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      // One event day. Long enough that a volunteer is not re-challenged between the desk and
      // the panel room; short enough that a borrowed phone is not a standing key.
      maxAge: 12 * 60 * 60,
    })

    return NextResponse.json({ verified: true })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('mfa verify failed', err)
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Could not verify', retryable: true } },
      { status: 500 },
    )
  }
}
