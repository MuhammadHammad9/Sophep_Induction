import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import {
  register,
  checkIn,
  RmsError,
  withContext,
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

  // Inject walk_in_digital source
  const parsed = registrationInputSchema.safeParse({ ...(payload as object), source: 'walk_in_digital' })
  if (!parsed.success) {
    return NextResponse.json({ error: fieldErrors(parsed.error) }, { status: 400 })
  }

  const input = parsed.data
  const stageId = (payload as { stageId?: string }).stageId

  if (!stageId) {
    return NextResponse.json(
      { error: { code: 'INVALID_REQUEST', message: 'stageId is required for fast-track', retryable: false } },
      { status: 400 },
    )
  }

  try {
    const result = await withContext({ clientIp: clientIpOf(req) }, async (tx) => {
      // 1. Register the applicant
      const registered = await register(tx, input)

      // 2. Immediately check them in to the provided stage
      const checkInResult = await checkIn(tx, {
        applicantId: registered.applicantId,
        stageId: stageId,
        method: 'register_and_checkin',
      })

      // The applicant needs completion if they went through the fast track, but we don't have a specific column for needs_completion.
      // The fact they were registered via walk_in_digital and lack preferences will naturally flag them for completion if needed.
      
      return { 
        displayId: registered.displayId, 
        checkInOutcome: checkInResult.outcome,
        position: checkInResult.position,
        queueEntryId: checkInResult.queueEntryId 
      }
    })

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

function clientIpOf(req: Request): string | undefined {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
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
