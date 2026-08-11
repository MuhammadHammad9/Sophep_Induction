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
  
  try {
    const result = await withIdempotency(idempotencyKey, async () => {
      return await withContext({ clientIp: clientIpOf(req) }, async (tx) => {
        const registered = await register(tx, input)

        const baseUrl = process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
        const statusUrl = buildQrPayload(baseUrl, registered.token.raw)

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

        return { displayId: registered.displayId, statusUrl }
      })
    })

    // The raw token appears in statusUrl here, in this response, once. It is never persisted
    // and never logged (rules.md R-022).
    return NextResponse.json(result, { status: 201 })
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
