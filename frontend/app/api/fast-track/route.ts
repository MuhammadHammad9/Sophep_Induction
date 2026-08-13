/**
 * POST /api/fast-track — register a walk-in and check them in, in one transaction.
 *
 * FR-CHK-010: someone arrives who never applied online. A volunteer takes their name, phone and
 * email at the desk and they join the queue immediately; the record is deliberately partial and
 * is completed later. Optimising for the fifteen seconds at the desk is the entire point
 * (design principle 7).
 *
 * ── THIS ENDPOINT HAD NO AUTHENTICATION AT ALL ──
 *
 * Not `requireStaff`, not a capability check, nothing. It accepted a JSON body from anyone on
 * the internet and performed the two most consequential writes in the system — creating an
 * applicant and placing them in the live interview queue — under an EMPTY security context.
 * Its page handed out the open cycle id and the active stage id unauthenticated, so an attacker
 * did not even have to guess them.
 *
 *     for i in $(seq 1 5000); do curl -X POST .../api/fast-track -d '{...}'; done
 *
 * That is anonymous mass-injection of fabricated applicants into the queue during the event,
 * consuming panel time that real people are waiting for. It also bypassed the 3-per-hour
 * application limit, because middleware matched `/api/apply` by exact string.
 *
 * The only thing containing it was a typo: the route sent `source: 'walk_in_digital'` while
 * `registrationChannels` defines `walkin_digital`, so Zod rejected every request with a 400.
 * Fixing that typo alone would have opened the hole for real — which is why the fix is
 * authentication first, spelling second.
 *
 * Refs: FR-CHK-010, FR-REG-002, FR-OPS-004, IR-002, rules.md R-003, R-032, audit C-1
 */

import { NextResponse } from 'next/server'
import { z, ZodError } from 'zod'
import {
  register,
  checkIn,
  RmsError,
  withContext,
  withIdempotency,
  registrationInputSchema,
} from '@sophep/backend'
import { requireStaff, hasCapability, unauthorized, forbidden } from '@/lib/auth/session'

/**
 * `stageId` was read off the raw body with `(payload as { stageId?: string }).stageId` and
 * passed straight into a `::uuid` cast — a non-UUID produced an unhandled 22P02 and a 500
 * rather than a 400. Validated here with everything else.
 */
const fastTrackSchema = registrationInputSchema
  .omit({ source: true })
  .extend({ stageId: z.string().uuid('A valid stage is required') })

export async function POST(req: Request) {
  const staff = await requireStaff()
  if (!staff) return unauthorized()

  // Both capabilities, because this endpoint does both things. Requiring only one would let a
  // role that may register but not check in do both by choosing this route over the other two.
  if (!(await hasCapability(staff, 'applicant.register'))) {
    return forbidden('applicant.register')
  }
  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Malformed request body', retryable: false } },
      { status: 400 },
    )
  }

  const parsed = fastTrackSchema.safeParse({
    ...(payload as object),
    // 'walkin_digital', not 'walk_in_digital'. FR-REG-002: every channel produces an identical
    // record structure, so the channel is recorded on the record rather than changing its shape.
    source: 'walkin_digital',
    // FR-CHK-010: the record is knowingly incomplete — no preferences, no answers — and must be
    // flagged as such so it appears in the completion queue rather than looking finished.
    needsCompletion: true,
  })
  if (!parsed.success) {
    return NextResponse.json({ error: fieldErrors(parsed.error) }, { status: 400 })
  }

  // `source` is omitted from the request schema and supplied here, not taken from the caller.
  // This route IS the walk-in desk; letting a body claim `online` would misreport the channel
  // on a record that a dedupe review later depends on (FR-REG-002).
  const { stageId, ...rest } = parsed.data
  const input = { ...rest, source: 'walkin_digital' as const }

  // A desk on a flaky connection double-taps. Without a key, the second tap creates a second
  // applicant with a second identifier for the same person standing there (R-051, FR-OPS-004).
  const idempotencyKey = req.headers.get('Idempotency-Key')

  try {
    const { value: result } = await withContext(
      { ...staff.context, clientIp: clientIpOf(req) },
      async (tx) =>
        withIdempotency(
          tx,
          {
            key: idempotencyKey,
            endpoint: '/api/fast-track',
            body: { ...input, stageId },
            cycleId: input.cycleId,
            statusCode: 201,
          },
          async () => {
            const registered = await register(tx, input)

            const checkInResult = await checkIn(tx, {
              applicantId: registered.applicantId,
              stageId,
              method: 'register_and_checkin',
            })

            return {
              displayId: registered.displayId,
              applicantId: registered.applicantId,
              outcome: checkInResult.outcome,
              position: checkInResult.position,
              queueEntryId: checkInResult.queueEntryId,
              needsCompletion: true,
            }
          },
        ),
    )

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('fast-track failed', err)
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_TRANSITION',
          message: 'Something went wrong. Please try again.',
          retryable: true,
        },
      },
      { status: 500 },
    )
  }
}

/**
 * The LAST element of x-forwarded-for, not the first.
 *
 * The header is a chain and a client can prepend entries to it, so the first element is
 * attacker-chosen. The last is the one appended by the proxy nearest us — the only part that
 * cannot be forged. This value reaches `audit_events.client_ip`, so taking the first element
 * meant an attacker chose what the audit log recorded about them.
 */
function clientIpOf(req: Request): string | undefined {
  const realIp = req.headers.get('x-real-ip')?.trim()
  if (realIp) return realIp
  return req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
}

function fieldErrors(error: ZodError) {
  const detail: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form'
    detail[key] ??= issue.message
  }
  return {
    code: 'INVALID_TRANSITION' as const,
    message: 'Please check the highlighted fields',
    detail,
    retryable: false,
  }
}
