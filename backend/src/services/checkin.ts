/**
 * Check-in and cycle key management.
 *
 * Refs: FR-CHK-001..011, FR-CHK-018, FR-IDT-007..011, E1
 */

import type { Tx } from './db'
import { RmsError, fromPostgresError } from '../domain/errors'
import { hashToken } from '../domain/identity'
import {
  generateCycleKeypair,
  signToken,
  encryptionKeyFromEnv,
  parseQrPayload,
} from '../domain/crypto'
import { tokenHashB64, type RosterBundle } from '../domain/verification'

// ── Cycle keys ──────────────────────────────────────────────────────────────────────────

/**
 * Create the cycle's Ed25519 keypair if it does not have one.
 *
 * FR-IDT-011: one keypair per cycle, so a token from a previous cycle fails verification
 * against the current one. Without that, a Fall QR would still scan in Spring and check
 * someone in to an induction they never applied to.
 */
export async function ensureCycleKeypair(tx: Tx, cycleId: string): Promise<Buffer> {
  const rows = await tx<Array<{ qr_public_key: Buffer | null }>>`
    SELECT qr_public_key FROM cycles WHERE id = ${cycleId}::uuid
  `
  const existing = rows[0]?.qr_public_key
  if (existing) return Buffer.from(existing)

  const keypair = generateCycleKeypair(encryptionKeyFromEnv())

  await tx`
    UPDATE cycles
       SET qr_public_key      = ${keypair.publicKey}::bytea,
           qr_private_key_enc = ${keypair.privateKeyEncrypted}::bytea
     WHERE id = ${cycleId}::uuid
  `

  // The public key is auditable; the private key never appears in an audit row, a log, or a
  // response body (rules.md R-021, NFR-MAIN-006).
  await tx`
    SELECT fn_audit(${cycleId}::uuid, 'cycle.keypair_generated', 'cycle', ${cycleId}::uuid,
                    NULL, ${tx.json({ public_key_b64: keypair.publicKey.toString('base64') })}::jsonb, NULL)
  `

  return keypair.publicKey
}

/**
 * Sign a raw token for its cycle, producing the `<token>.<signature>` QR suffix.
 *
 * Runs on the server only. The decrypted seed exists for the duration of one signature and is
 * zeroed afterwards — see signToken.
 */
export async function signTokenForCycle(
  tx: Tx,
  cycleId: string,
  rawToken: string,
): Promise<string> {
  const rows = await tx<Array<{ qr_private_key_enc: Buffer | null }>>`
    SELECT qr_private_key_enc FROM cycles WHERE id = ${cycleId}::uuid
  `
  const enc = rows[0]?.qr_private_key_enc
  if (!enc) {
    throw new Error(`cycle ${cycleId} has no signing key — call ensureCycleKeypair first`)
  }
  return signToken(rawToken, Buffer.from(enc), encryptionKeyFromEnv())
}

/**
 * Build the offline roster bundle.
 *
 * FR-CHK-018: token hashes and the public key ONLY. NFR-PERF-009 budgets 100 KB for 500
 * applicants — base64 hashes are 44 bytes each, so 500 costs about 22 KB, comfortably inside
 * it even with JSON overhead.
 */
export async function buildRosterBundle(
  tx: Tx,
  cycleId: string,
  stageId: string,
): Promise<RosterBundle> {
  const [cycle] = await tx<Array<{ qr_public_key: Buffer | null }>>`
    SELECT qr_public_key FROM cycles WHERE id = ${cycleId}::uuid
  `
  if (!cycle?.qr_public_key) {
    throw new Error(`cycle ${cycleId} has no public key`)
  }

  const rows = await tx<Array<{ token_hash_b64: string }>>`
    SELECT token_hash_b64 FROM fn_roster_bundle(${cycleId}::uuid)
  `

  return {
    cycleId,
    stageId,
    // Normalise base64 → base64url so the device compares against the same alphabet the
    // verifier produces. A mismatch here would silently fail every layer-2 lookup and push
    // every scan to layer 3 or the network — which is exactly the failure offline mode exists
    // to avoid, and it would only show up with the WiFi off.
    tokenHashes: rows.map((r) =>
      Buffer.from(r.token_hash_b64, 'base64').toString('base64url'),
    ),
    publicKey: Buffer.from(cycle.qr_public_key).toString('base64url'),
    generatedAt: new Date().toISOString(),
  }
}

// ── Check-in ────────────────────────────────────────────────────────────────────────────

export interface CheckInResult {
  outcome: 'checked_in' | 'already'
  checkInId: string
  applicantId: string
  displayId: string
  fullName: string
  queueEntryId: string
  position: number
  trackId: string
  checkedInAt: Date
  etaSuppressed: boolean
}

export interface TokenResolution {
  applicantId: string
  displayId: string
  fullName: string
  state: string
  cycleId: string
  revoked: boolean
  expired: boolean
}

/** Layer 4: resolve a scanned value against the database. */
export async function resolveScannedToken(
  tx: Tx,
  scanned: string,
): Promise<TokenResolution | null> {
  const parsed = parseQrPayload(scanned)
  if (!parsed) return null

  const rows = await tx<
    Array<{
      applicant_id: string
      display_id: string
      full_name: string
      state: string
      cycle_id: string
      revoked: boolean
      expired: boolean
    }>
  >`SELECT * FROM fn_resolve_token_for_checkin(${hashToken(parsed.token)}::bytea)`

  const row = rows[0]
  if (!row) return null

  return {
    applicantId: row.applicant_id,
    displayId: row.display_id,
    fullName: row.full_name,
    state: row.state,
    cycleId: row.cycle_id,
    revoked: row.revoked,
    expired: row.expired,
  }
}

/**
 * Check an applicant in and enqueue them, in one transaction.
 *
 * Idempotent: a repeat produces `outcome: 'already'` with the ORIGINAL time, which the UI
 * renders amber rather than red (FR-CHK-006, rules.md R-027).
 */
export async function checkIn(
  tx: Tx,
  input: {
    applicantId: string
    stageId: string
    trackId?: string
    method?: 'qr' | 'manual_search' | 'register_and_checkin' | 'bulk_reconcile'
    clientTs?: Date
    clientRequestId?: string
  },
): Promise<CheckInResult> {
  try {
    const rows = await tx<
      Array<{
        outcome: 'checked_in' | 'already'
        check_in_id: string
        applicant_id: string
        display_id: string
        full_name: string
        queue_entry_id: string
        queue_position: number
        track_id: string
        checked_in_at: Date
        eta_suppressed: boolean
      }>
    >`
      SELECT * FROM fn_check_in(
        ${input.applicantId}::uuid,
        ${input.stageId}::uuid,
        ${input.trackId ?? null}::uuid,
        ${input.method ?? 'qr'},
        ${input.clientTs ?? null}::timestamptz,
        ${input.clientRequestId ?? null}::uuid
      )
    `

    const row = rows[0]
    if (!row) throw new Error('fn_check_in returned no row')

    return {
      outcome: row.outcome,
      checkInId: row.check_in_id,
      applicantId: row.applicant_id,
      displayId: row.display_id,
      fullName: row.full_name,
      queueEntryId: row.queue_entry_id,
      position: Number(row.queue_position),
      trackId: row.track_id,
      checkedInAt: row.checked_in_at,
      etaSuppressed: row.eta_suppressed,
    }
  } catch (err) {
    const mapped = fromPostgresError(err)
    if (mapped) throw mapped

    const message = (err as { message?: string })?.message ?? ''
    if (message.startsWith('NOT_ELIGIBLE')) {
      throw new RmsError('INVALID_TRANSITION', 'This applicant is not eligible to check in', {
        detail: message,
      })
    }
    throw err
  }
}

/** Re-export so callers do not need to reach into the domain layer for the common case. */
export { tokenHashB64 }
