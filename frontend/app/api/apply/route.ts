/**
 * POST /api/apply — public application submission.
 *
 * A THIN handler (rules.md R-003): authenticate, validate, delegate, shape. Every decision
 * below — dedupe, identifier allocation, token issuance — happens in @sophep/backend and,
 * ultimately, inside one database transaction.
 *
 * Refs: FR-REG-001..012, FR-OPS-004, IR-002
 */

import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import {
  register,
  enqueue,
  buildQrPayload,
  RmsError,
  withContext,
  withIdempotency,
  enforceRateLimit,
  registrationInputSchema,
} from '@sophep/backend'

export async function POST(req: Request) {
  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'INVALID_TRANSITION', message: 'Malformed request body', retryable: false } },
      { status: 400 },
    )
  }

  // FR-REG-003: validated server-side regardless of what the client checked.
  const parsed = registrationInputSchema.safeParse({ ...(payload as object), source: 'online' })
  if (!parsed.success) {
    return NextResponse.json({ error: fieldErrors(parsed.error) }, { status: 400 })
  }

  const input = parsed.data

  const idempotencyKey = req.headers.get('Idempotency-Key')

  // The raw token lives only in this variable, only on the request that actually registered.
  // It is deliberately NOT part of the idempotent return value: that value is persisted to
  // `idempotency_keys.response_body`, and a raw token must never be stored anywhere (R-022,
  // FR-IDT-006). A replay therefore answers with the display id alone — correct, because the
  // confirmation email already carries the status link.
  let statusUrl: string | undefined

  try {
    // Order matters: the transaction is OUTER. The idempotency claim and the work it guards
    // commit or roll back together, so a failure cannot leave a key claimed for work that
    // never happened.
    const { value: result, replayed } = await withContext(
      { clientIp: clientIpOf(req) },
      async (tx) => {
        // Counted in the DATABASE so the 3/hour ceiling is genuinely global. Middleware's
        // in-memory bucket stays as a cheap first line, but on Vercel each instance has its
        // own memory, so its real budget is N x configured — and this is the limit that keeps
        // fabricated records out of the applicant table on registration day (NFR-SEC-005,
        // audit S-4).
        //
        // Inside the transaction, so a rolled-back registration does not consume budget, and
        // BEFORE the idempotency claim, so a replayed key does not either.
        await enforceRateLimit(tx, 'apply', clientIpOf(req) ?? 'unknown')

        return withIdempotency(
          tx,
          {
            key: idempotencyKey,
            endpoint: '/api/apply',
            body: input,
            cycleId: input.cycleId,
            statusCode: 201,
          },
          async () => {
        const registered = await register(tx, input)

        const baseUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
        statusUrl = buildQrPayload(baseUrl, registered.token.raw)

        // FR-NOT-001: ENQUEUED, never sent inline. A slow email provider must not be able to
        // hold up an application submission (CON-004, rules.md R-030).
        await enqueue(tx, {
          cycleId: input.cycleId,
          applicantId: registered.applicantId,
          toEmail: input.email,
          templateKey: 'registration.confirmation',
          variables: {
            fullName: input.fullName,
            displayId: registered.displayId,
            statusUrl,
          },
        })

            return { displayId: registered.displayId }
          },
        )
      },
    )

    // The raw token appears in statusUrl here, in this response, once. It is never persisted
    // and never logged (rules.md R-022).
    return NextResponse.json(
      { ...result, ...(statusUrl ? { statusUrl } : {}), ...(replayed ? { replayed: true } : {}) },
      { status: replayed ? 200 : 201 },
    )
  } catch (err) {
    if (err instanceof RmsError) {
      return NextResponse.json(err.toBody(), { status: err.status })
    }
    console.error('apply failed', err)
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

function clientIpOf(req: Request): string | undefined {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
}

/** Field-level errors so the form can mark the offending input rather than showing one banner. */
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
