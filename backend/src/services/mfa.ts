/**
 * MFA enrolment and challenge.
 *
 * The split of responsibility is the whole design, and it is forced rather than chosen:
 *
 *   - The DATABASE decides who may see a secret. `fn_totp_secret_for_self` takes no argument,
 *     so there is no identifier to point at another account, and `users.totp_secret_enc` is not
 *     SELECT-able by the application role by any other route (migration 0037).
 *   - The APPLICATION does the arithmetic, because the secret is AES-256-GCM and pgcrypto
 *     implements CBC and ECB but not GCM. Postgres physically cannot decrypt it — which is
 *     exactly the property NFR-SEC-002 asked for.
 *
 * The plaintext secret exists only inside these functions, only for the duration of one
 * verification, and is zeroed afterwards. It is never returned to a caller, never logged, and
 * never stored anywhere but the encrypted column.
 *
 * Refs: FR-RBAC-008, NFR-SEC-001, NFR-SEC-002, rules.md R-032, audit H-6
 */

import type { Tx } from './db'
import { RmsError } from '../domain/errors'
import { encryptSecret, decryptSecret, encryptionKeyFromEnv } from '../domain/crypto'
import { generateTotpSecret, totpProvisioningUri, verifyTotp, base32Encode } from '../domain/totp'

export interface MfaStatus {
  required: boolean
  enrolled: boolean
}

export async function mfaStatus(tx: Tx): Promise<MfaStatus> {
  const rows = await tx<Array<{ required: boolean; enrolled: boolean }>>`
    SELECT * FROM fn_mfa_status()
  `
  return { required: rows[0]?.required ?? false, enrolled: rows[0]?.enrolled ?? false }
}

export interface EnrolmentOffer {
  /** For an authenticator app to scan. Contains the secret — render once, never persist. */
  provisioningUri: string
  /** The same secret, for someone typing it in because their camera will not focus. */
  manualKey: string
}

/**
 * Stage a new secret and hand back the enrolment material.
 *
 * The secret is generated here and encrypted before it touches the database. It is returned to
 * the caller exactly once, in this response, in the same way a raw access token is at
 * registration — and like that token it must not be logged or persisted anywhere else (R-022's
 * reasoning applies verbatim, even though this is not a token).
 *
 * `totp_enabled` stays false until `confirmEnrolment` succeeds. A volunteer who scans the code
 * badly and is immediately locked out has no route back in on the morning of the event; proving
 * one working code first is what prevents that.
 */
export async function beginEnrolment(
  tx: Tx,
  accountEmail: string,
): Promise<EnrolmentOffer> {
  const secret = generateTotpSecret()
  try {
    const encrypted = encryptSecret(secret, encryptionKeyFromEnv())
    await tx`SELECT fn_totp_begin_enrolment(${encrypted}::bytea)`

    return {
      provisioningUri: totpProvisioningUri(secret, accountEmail),
      manualKey: base32Encode(secret),
    }
  } finally {
    // Shrink the window in which the plaintext sits in a reachable buffer.
    secret.fill(0)
  }
}

/**
 * Confirm enrolment by proving one code, then enable the second factor.
 *
 * Enabling and initialising the replay watermark happen in ONE database call, because a crash
 * between them would leave MFA enabled with a NULL watermark — which accepts a replay of the
 * very code that was just used to enrol.
 */
export async function confirmEnrolment(tx: Tx, code: string): Promise<void> {
  const { step } = await verifyAgainstOwnSecret(tx, code, { allowUnenrolled: true })
  await tx`SELECT fn_totp_confirm_enrolment(${step}::bigint)`
}

/**
 * Answer an MFA challenge at sign-in.
 *
 * On success the spent step is recorded, so the code cannot be used again inside its 30-second
 * window — RFC 6238 §5.2. `fn_record_totp_use` refuses to advance anyone else's watermark
 * (migration 0038), so this cannot be turned into a lockout against another account.
 */
export async function verifyChallenge(tx: Tx, code: string): Promise<void> {
  const { step, userId } = await verifyAgainstOwnSecret(tx, code, { allowUnenrolled: false })
  await tx`SELECT fn_record_totp_use(${userId}::uuid, ${step}::bigint)`
}

async function verifyAgainstOwnSecret(
  tx: Tx,
  code: string,
  options: { allowUnenrolled: boolean },
): Promise<{ step: number; userId: string }> {
  const rows = await tx<Array<{ secret: Uint8Array | null; user_id: string; last_step: string | null }>>`
    SELECT fn_totp_secret_for_self() AS secret,
           fn_current_user_id()      AS user_id,
           (SELECT totp_last_used_step FROM users WHERE id = fn_current_user_id()) AS last_step
  `
  const row = rows[0]
  if (!row?.user_id) {
    throw new RmsError('TOKEN_INVALID', 'Sign in before completing this step')
  }
  if (!row.secret || row.secret.length === 0) {
    if (options.allowUnenrolled) {
      throw new RmsError('INVALID_TRANSITION', 'Start enrolment before confirming a code')
    }
    throw new RmsError('INVALID_TRANSITION', 'This account has no authenticator set up')
  }

  const secret = decryptSecret(Buffer.from(row.secret), encryptionKeyFromEnv())
  try {
    const result = verifyTotp(secret, code, {
      // The watermark is NULL during enrolment, which is correct: there is no prior step to
      // be newer than, and the confirming code becomes the first spent one.
      ...(row.last_step !== null ? { lastUsedStep: Number(row.last_step) } : {}),
    })

    if (!result.valid || result.step === undefined) {
      // Deliberately identical for a wrong code and a replayed one. Distinguishing them tells
      // an attacker that the code they captured was genuine and merely stale, which is a
      // stronger signal than they had a moment ago.
      throw new RmsError('TOKEN_INVALID', 'That code is not valid. Check your authenticator.')
    }

    return { step: result.step, userId: row.user_id }
  } finally {
    secret.fill(0)
  }
}
