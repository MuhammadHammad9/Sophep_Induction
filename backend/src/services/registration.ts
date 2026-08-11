/**
 * Registration.
 *
 * One code path for all three channels (FR-REG-001, FR-REG-002). Paper is an input method, not
 * a separate pipeline — one set of edge cases, and one thing for a volunteer to learn under
 * pressure. A second, looser path for walk-ins is how walk-ins become second-class records.
 *
 * Duplicate handling is split deliberately:
 *   - `checkDuplicates` reports what matched and how.
 *   - `register` performs the write, carrying the human's decision as `overrideReason`.
 *
 * The resolution is a HUMAN decision (FR-REG-007), so the service never picks for them. The
 * partial unique indexes remain as a backstop for accidents and races (E4).
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './db'
import { RmsError, fromPostgresError } from '../domain/errors'
import { generateToken, type IssuedToken } from '../domain/identity'
import { registrationInputSchema, type RegistrationInput } from '../domain/schemas'

export interface DuplicateMatch {
  applicantId: string
  displayId: string
  fullName: string
  state: string
  matchKind: 'email' | 'phone' | 'roll' | 'name_similarity'
  isHardBlock: boolean
  similarity: number
}

export interface DuplicateReport {
  hardBlocks: DuplicateMatch[]
  softWarnings: DuplicateMatch[]
  get blocked(): boolean
}

/**
 * FR-REG-006: exact match on normalised email, phone or roll number blocks the registration
 * and displays the existing record. FR-REG-010: a trigram name match combined with a shared
 * department preference warns without blocking — a name match alone is far too common to block
 * on, and a false block at the desk costs more than a duplicate record does.
 */
export async function checkDuplicates(
  tx: Tx,
  input: {
    cycleId: string
    email: string
    phone: string
    rollNumber?: string | null
    fullName?: string
    preferences?: string[]
  },
): Promise<DuplicateReport> {
  const rows = await tx<
    Array<{
      applicant_id: string
      display_id: string
      full_name: string
      state: string
      match_kind: DuplicateMatch['matchKind']
      is_hard_block: boolean
      similarity: number
    }>
  >`
    SELECT * FROM fn_find_duplicates(
      ${input.cycleId}::uuid,
      ${input.email},
      ${input.phone},
      ${input.rollNumber ?? null},
      ${input.fullName ?? null},
      ${input.preferences?.length ? input.preferences : null}::uuid[]
    )
  `

  // The same existing applicant can match on several signals at once (same person re-typing
  // their details). Deduplicate by applicant so the desk sees one record with its reasons,
  // not the same person listed three times.
  const seen = new Map<string, DuplicateMatch>()
  for (const r of rows) {
    const existing = seen.get(r.applicant_id)
    const match: DuplicateMatch = {
      applicantId: r.applicant_id,
      displayId: r.display_id,
      fullName: r.full_name,
      state: r.state,
      matchKind: r.match_kind,
      isHardBlock: r.is_hard_block,
      similarity: Number(r.similarity),
    }
    // A hard block always wins over a soft warning for the same person.
    if (!existing || (match.isHardBlock && !existing.isHardBlock)) {
      seen.set(r.applicant_id, match)
    }
  }

  const all = [...seen.values()]
  const hardBlocks = all.filter((m) => m.isHardBlock)
  const softWarnings = all.filter((m) => !m.isHardBlock)

  return {
    hardBlocks,
    softWarnings,
    get blocked() {
      return hardBlocks.length > 0
    },
  }
}

export interface RegistrationResult {
  applicantId: string
  displayId: string
  sequence: number
  /**
   * The raw token, present exactly once, here. It is never persisted and never logged
   * (rules.md R-022). Render it into the QR and the email, then let it go out of scope.
   */
  token: IssuedToken
  tokenExpiresAt: Date
}

/**
 * Register an applicant and issue their access token.
 *
 * Both happen in the caller's transaction, so an applicant can never exist without a token —
 * a record with no way for its owner to check their status is a support call at best and an
 * uncontactable person at worst.
 */
export async function register(
  tx: Tx,
  rawInput: RegistrationInput,
  opts: { tokenTtlDays?: number } = {},
): Promise<RegistrationResult> {
  // FR-REG-003: server-side validation, always, regardless of what the client checked.
  const input = registrationInputSchema.parse(rawInput)

  // A hard block may only be bypassed with a written reason (FR-REG-007, FR-REG-008).
  if (!input.overrideReason) {
    const dupes = await checkDuplicates(tx, {
      cycleId: input.cycleId,
      email: input.email,
      phone: input.phone,
      rollNumber: input.rollNumber,
      fullName: input.fullName,
      preferences: input.preferences,
    })

    if (dupes.blocked) {
      throw new RmsError('DUPLICATE_APPLICANT', 'An applicant with these details already exists', {
        matches: dupes.hardBlocks,
      })
    }
  }

  let applicant: { id: string; display_id: string; sequence: number; cycle_id: string }
  try {
    const rows = await tx<Array<{ id: string; display_id: string; sequence: number; cycle_id: string }>>`
      SELECT id, display_id, sequence, cycle_id FROM fn_register_applicant(
        ${input.cycleId}::uuid,
        ${input.fullName},
        ${input.email},
        ${input.phone},
        ${input.source}::registration_channel,
        ${input.rollNumber ?? null},
        ${tx.json(input.answers as Parameters<typeof tx.json>[0])}::jsonb,
        ${input.preferences.length ? input.preferences : null}::uuid[],
        ${input.overrideReason ?? null},
        ${input.needsCompletion}
      )
    `
    const row = rows[0]
    if (!row) throw new Error('fn_register_applicant returned no row')
    applicant = row
  } catch (err) {
    const mapped = fromPostgresError(err)
    if (mapped) throw mapped
    throw err
  }

  // FR-IDT-012: tokens expire 60 days after the cycle's final decision date. That date is not
  // known at registration, so a conservative TTL is set now and extended when decisions are
  // scheduled. Erring short would lock an applicant out of their own result.
  const ttlDays = opts.tokenTtlDays ?? 120
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)

  const token = generateToken()

  await tx`
    SELECT fn_issue_token(
      ${applicant.id}::uuid,
      ${token.hash}::bytea,
      ${expiresAt}::timestamptz,
      'initial issuance'
    )
  `

  return {
    applicantId: applicant.id,
    displayId: applicant.display_id,
    sequence: applicant.sequence,
    token,
    tokenExpiresAt: expiresAt,
  }
}

/**
 * FR-CHK-009: search on any 4 consecutive digits of the identifier, the last 4 digits of the
 * phone, or a partial name. This is the fallback when a camera fails, so it runs against
 * whatever the volunteer can read off a slip or hear across a desk.
 */
export async function searchApplicants(
  tx: Tx,
  cycleId: string,
  q: string,
  limit = 20,
): Promise<Array<{ applicantId: string; displayId: string; fullName: string; state: string }>> {
  const term = q.trim()
  const digits = term.replace(/\D/g, '')

  const rows = await tx<
    Array<{ id: string; display_id: string; full_name: string; state: string }>
  >`
    SELECT id, display_id, full_name, state
      FROM applicants
     WHERE cycle_id = ${cycleId}::uuid
       AND (
             display_id ILIKE ${'%' + term + '%'}
         OR  full_name  ILIKE ${'%' + term + '%'}
         OR  (${digits.length >= 4} AND display_id LIKE ${'%' + digits + '%'})
         OR  (${digits.length >= 4} AND phone_norm LIKE ${'%' + digits})
       )
     ORDER BY
       -- Exact identifier match first: a volunteer who typed a full ID wants that person,
       -- not a name that happens to contain the same characters.
       (display_id ILIKE ${term}) DESC,
       display_id ASC
     LIMIT ${limit}
  `

  return rows.map((r) => ({
    applicantId: r.id,
    displayId: r.display_id,
    fullName: r.full_name,
    state: r.state,
  }))
}

/** Screening. FR-CYC / spec §5.1: SUBMITTED → ELIGIBLE or SCREENED_OUT. */
export async function screenApplicant(
  tx: Tx,
  applicantId: string,
  outcome: 'eligible' | 'screened_out',
  reason?: string,
): Promise<void> {
  try {
    await tx`
      SELECT fn_application_transition(
        ${applicantId}::uuid,
        ${outcome}::applicant_state,
        ${reason ?? null}
      )
    `
  } catch (err) {
    const mapped = fromPostgresError(err)
    if (mapped) throw mapped
    throw err
  }
}

/** Generate an idempotency key for a client-initiated write (FR-OPS-004, R-051). */
export function newIdempotencyKey(): string {
  return randomUUID()
}
