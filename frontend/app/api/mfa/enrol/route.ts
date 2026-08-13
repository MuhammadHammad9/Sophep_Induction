/**
 * POST /api/mfa/enrol — stage a TOTP secret and return the enrolment material.
 * PUT  /api/mfa/enrol — prove one code and switch the second factor on.
 *
 * Thin handlers (R-003): authenticate, delegate, shape. Everything that matters — who may see
 * a secret, what happens to the replay watermark, whether enabling and initialising it share a
 * transaction — lives in `@sophep/backend` and migration 0045.
 *
 * Refs: FR-RBAC-008, NFR-SEC-001, rules.md R-003, audit H-6
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withContext, beginEnrolment, confirmEnrolment, RmsError } from '@sophep/backend'
import { requireStaff, unauthorized, invalid } from '@/lib/auth/session'

export async function POST() {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  try {
    const offer = await withContext(staff.context, (tx) => beginEnrolment(tx, staff.email))

    // The provisioning URI CONTAINS the secret. It is returned once, rendered once, and never
    // persisted or logged — the same discipline a raw access token gets at registration
    // (R-022's reasoning, applied to a different secret).
    return NextResponse.json(offer, {
      status: 201,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate, private' },
    })
  } catch (err) {
    return errorResponse(err, 'Could not start enrolment')
  }
}

const confirmSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator'),
})

export async function PUT(req: Request) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  const parsed = confirmSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'Invalid code')
  }

  try {
    await withContext(staff.context, (tx) => confirmEnrolment(tx, parsed.data.code))
    return NextResponse.json({ enrolled: true })
  } catch (err) {
    return errorResponse(err, 'Could not confirm enrolment')
  }
}

function errorResponse(err: unknown, fallback: string) {
  if (err instanceof RmsError) {
    return NextResponse.json(err.toBody(), { status: err.status })
  }
  console.error('mfa enrolment failed', err)
  return NextResponse.json(
    { error: { code: 'INVALID_TRANSITION', message: fallback, retryable: true } },
    { status: 500 },
  )
}
