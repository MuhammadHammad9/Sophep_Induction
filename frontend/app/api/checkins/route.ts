/**
 * POST /api/checkins — check an applicant in.
 *
 * Thin handler (R-003). Accepts either a scanned QR value or an applicant id from manual
 * search, resolves it, and delegates. Every decision lives in @sophep/backend and, ultimately,
 * in one database transaction.
 *
 * Refs: FR-CHK-001..011, FR-OPS-004
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  withContext,
  checkIn,
  resolveScannedToken,
  RmsError,
  withIdempotency,
} from '@sophep/backend'
import { requireStaff, unauthorized, hasCapability, forbidden } from '@/lib/auth/session'

const bodySchema = z
  .object({
    stageId: z.string().uuid(),
    scanned: z.string().trim().min(1).max(512).optional(),
    applicantId: z.string().uuid().optional(),
    trackId: z.string().uuid().optional(),
    method: z.enum(['qr', 'manual_search', 'register_and_checkin', 'bulk_reconcile']).default('qr'),
    // FR-CHK-016: kept only for replay ordering. Server time is authoritative for every
    // business decision.
    clientTs: z.string().datetime().optional(),
    clientRequestId: z.string().uuid().optional(),
  })
  .refine((v) => v.scanned || v.applicantId, {
    message: 'Provide either a scanned code or an applicant id',
  })

export async function POST(req: Request) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Malformed body', retryable: false } },
      { status: 400 },
    )
  }

  const parsed = bodySchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: parsed.error.issues[0]?.message ?? 'Invalid request',
          retryable: false,
        },
      },
      { status: 400 },
    )
  }

  const input = parsed.data

  const idempotencyKey = req.headers.get('Idempotency-Key')

  try {
    const result = await withIdempotency(idempotencyKey, async () => {
      return await withContext(staff.context, async (tx) => {
        let applicantId = input.applicantId

        if (!applicantId && input.scanned) {
          const resolved = await resolveScannedToken(tx, input.scanned)

          // Layer 4. The device may have accepted this offline; the server is the authority on
          // revocation, expiry and cycle.
          if (!resolved) {
            throw new RmsError('TOKEN_INVALID', 'Not a valid SOPHEP code')
          }
          if (resolved.revoked) {
            throw new RmsError('TOKEN_INVALID', 'This code has been replaced — refresh the status page')
          }
          if (resolved.expired) {
            throw new RmsError('TOKEN_EXPIRED', 'This code has expired')
          }
          applicantId = resolved.applicantId
        }

        return checkIn(tx, {
          applicantId: applicantId!,
          stageId: input.stageId,
          ...(input.trackId ? { trackId: input.trackId } : {}),
          method: input.method,
          ...(input.clientTs ? { clientTs: new Date(input.clientTs) } : {}),
          ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        })
      })
    })

    // 200 rather than 201 for a repeat: nothing was created, and the client renders this

    // AMBER, not red (FR-CHK-006, R-027).
    return NextResponse.json(result, { status: result.outcome === 'already' ? 200 : 201 })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('check-in failed', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Check-in failed. Try again, or use manual search.',
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}
