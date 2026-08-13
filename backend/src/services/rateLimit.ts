/**
 * Globally-shared rate limiting.
 *
 * `middleware.ts` keeps an in-memory limiter and always will: it is cheap, it runs before any
 * database connection, and for the hot event paths — 4 scans a second across a desk — a runaway
 * guard is all that is wanted. But serverless memory is per-instance, so that limiter's real
 * budget is N× the configured one under load.
 *
 * That is fine for a limit protecting the database from a scraper. It is not fine for a limit
 * that IS the security control:
 *
 *   - A TOTP code is six digits. Five attempts per 15 minutes makes guessing hopeless; five per
 *     instance across an autoscaling fleet does not. The limit is what makes six digits an
 *     adequate secret.
 *   - Application submission is 3/hour/IP (NFR-SEC-005), and bypassing it is how the applicant
 *     table fills with fabricated records on registration day.
 *
 * So those two paths call this instead — one atomic UPSERT in Postgres, which every request on
 * these paths is already talking to. No third-party service enters the request path (CON-004,
 * R-030).
 *
 * Refs: NFR-SEC-005, NFR-SEC-001, CON-004, rules.md R-030, audit S-4
 */

import type { Tx } from './db'
import { RmsError } from '../domain/errors'

export interface RateLimitVerdict {
  allowed: boolean
  retryAfterSeconds: number
}

/** The named limits, so a caller cannot quietly invent a looser one at the call site. */
export const RATE_LIMITS = {
  /** NFR-SEC-005: authentication, 5 attempts per 15 minutes. */
  mfa: { max: 5, windowSec: 900 },
  /** NFR-SEC-005: application submission, 3/hour/IP. */
  apply: { max: 3, windowSec: 3600 },
  /** Sign-in link requests. Each one sends an email from the society's domain. */
  signin: { max: 5, windowSec: 900 },
} as const

export type RateLimitBucket = keyof typeof RATE_LIMITS

export async function consumeRateLimit(
  tx: Tx,
  bucket: RateLimitBucket,
  identity: string,
): Promise<RateLimitVerdict> {
  const { max, windowSec } = RATE_LIMITS[bucket]

  const rows = await tx<Array<{ allowed: boolean; retry_after_seconds: number }>>`
    SELECT * FROM fn_rate_limit_consume(${`${bucket}:${identity}`}, ${max}::int, ${windowSec}::int)
  `

  const row = rows[0]
  return {
    allowed: row?.allowed ?? false, // fail CLOSED: an unreadable counter denies (R-014)
    retryAfterSeconds: Number(row?.retry_after_seconds ?? windowSec),
  }
}

/**
 * Consume, and throw the IR-002 error if the budget is spent.
 *
 * `retryable: true` on the resulting error is deliberate and load-bearing: the offline replay
 * queue reads it to decide between retrying an operation and setting it aside for a human, and
 * a rate limit is the definition of "try again shortly" rather than "this will never work".
 */
export async function enforceRateLimit(
  tx: Tx,
  bucket: RateLimitBucket,
  identity: string,
): Promise<void> {
  const verdict = await consumeRateLimit(tx, bucket, identity)
  if (!verdict.allowed) {
    throw new RmsError('RATE_LIMITED', 'Too many attempts. Please wait and try again.', {
      retry_after_seconds: verdict.retryAfterSeconds,
    })
  }
}
