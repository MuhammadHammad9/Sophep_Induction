/**
 * The error contract.
 *
 * Errors are machine-readable so clients can REACT, not merely display a string — the offline
 * check-in queue needs to know whether a failure is worth replaying, and a UI needs to know
 * whether to offer a retry button or a different action entirely.
 *
 * IR-002, IR-003, rules.md R-057
 */

/** The fourteen defined codes. This list is closed — adding one is a spec change. */
export const ERROR_CODES = [
  'INVALID_TRANSITION',
  'IDEMPOTENCY_KEY_REUSED',
  'QUEUE_EMPTY',
  'RECUSAL_CONFLICT',
  'STAGE_CLOSED',
  'STAGE_HAS_ACTIVE_INTERVIEWS',
  'DUPLICATE_APPLICANT',
  'DUAL_CONTROL_REQUIRED',
  'CYCLE_ARCHIVED',
  'RATE_LIMITED',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'ALLOCATION_IN_PROGRESS',
  'PREFLIGHT_FAILED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorBody {
  error: {
    code: ErrorCode
    message: string
    detail?: Record<string, unknown>
    retryable: boolean
  }
}

/**
 * `retryable` is about whether repeating the identical request could succeed later, not about
 * whether the user can do something else. RATE_LIMITED is retryable; DUPLICATE_APPLICANT is
 * not, because the resolution is a human decision, not a wait.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'ALLOCATION_IN_PROGRESS',
])

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  QUEUE_EMPTY: 404,
  RECUSAL_CONFLICT: 409,
  STAGE_CLOSED: 409,
  STAGE_HAS_ACTIVE_INTERVIEWS: 409,
  DUPLICATE_APPLICANT: 409,
  DUAL_CONTROL_REQUIRED: 403,
  CYCLE_ARCHIVED: 409,
  RATE_LIMITED: 429,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  ALLOCATION_IN_PROGRESS: 409,
  PREFLIGHT_FAILED: 422,
}

export class RmsError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, unknown> | undefined
  readonly status: number

  constructor(code: ErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'RmsError'
    this.code = code
    this.detail = detail
    this.status = HTTP_STATUS[code]
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.code)
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail ? { detail: this.detail } : {}),
        retryable: this.retryable,
      },
    }
  }
}

/**
 * Map a Postgres error onto the contract.
 *
 * The transition functions RAISE with the code as the message text, so the database and the
 * API speak the same vocabulary. A code the database raises that is not in the contract is a
 * bug in the migration, not something to paper over here — it surfaces as an unmapped 500.
 */
export function fromPostgresError(err: unknown): RmsError | null {
  const message = (err as { message?: string })?.message ?? ''

  for (const code of ERROR_CODES) {
    if (message.startsWith(code)) {
      return new RmsError(code, message)
    }
  }

  // 23505 unique_violation on an applicant identity index. Reaching here means the
  // application-layer dedupe was bypassed or raced — the index is the backstop (E4).
  const pgCode = (err as { code?: string })?.code
  if (pgCode === '23505' && /uq_applicant_(email|phone|roll)/.test(message)) {
    return new RmsError('DUPLICATE_APPLICANT', 'An applicant with these details already exists')
  }

  return null
}
