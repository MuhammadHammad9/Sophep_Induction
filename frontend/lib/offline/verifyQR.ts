/**
 * Offline QR verification at the desk.
 *
 * This is deliberately a THIN wrapper. The verification itself lives in
 * `@sophep/backend/browser`, which is the same module the server uses — so the phone and the
 * API cannot disagree about whether a code is valid. A second implementation here is exactly
 * how they drift, and the drift only shows up with the WiFi off.
 *
 * An earlier local implementation got three things wrong, all silently:
 *   - it hashed the token's decoded bytes rather than the token string, so the roster lookup
 *     could never match
 *   - it skipped the Ed25519 check entirely, so nothing was actually verified
 *   - its parser required a signature, rejecting a bare token — the common case
 *
 * Refs: FR-CHK-004, FR-CHK-005, FR-CHK-018, E1
 */

import { verifyOffline, base64UrlToBytes, type VerificationOutcome } from '@sophep/backend/browser'
import { getOfflineApplicantByHash, getOfflineCyclePublicKey } from './indexeddb'

export interface OfflineScanResult {
  outcome: VerificationOutcome
  /** Present only when the roster knows this token. Never fabricated. */
  applicant: { applicantId: string; displayId: string; fullName: string } | null
  /**
   * True when the device verified a SIGNATURE but has no roster entry — a genuine late
   * registration. The scan is valid, but the desk knows nothing about the person yet, so the
   * UI must not pretend it does.
   */
  verifiedButUnknown: boolean
}

/**
 * Verify a scanned value using only material safe to hold on a device.
 *
 * Returns a structured outcome rather than throwing: a damaged QR is routine input at a
 * check-in desk, not an exceptional condition, and forcing every caller into a try/catch is
 * how a failure ends up rendered as a success.
 */
export async function verifyOfflineQR(
  scanned: string,
  roster: ReadonlySet<string>,
): Promise<OfflineScanResult> {
  const publicKeyBase64Url = await getOfflineCyclePublicKey()
  const publicKey = publicKeyBase64Url ? base64UrlToBytes(publicKeyBase64Url) : null

  const outcome = verifyOffline(scanned, roster, publicKey)

  if (!outcome.valid) {
    return { outcome, applicant: null, verifiedButUnknown: false }
  }

  const stored = await getOfflineApplicantByHash(outcome.tokenHash)

  return {
    outcome,
    applicant: stored
      ? {
          applicantId: stored.applicantId,
          displayId: stored.displayId,
          fullName: stored.fullName,
        }
      : null,
    verifiedButUnknown: !stored,
  }
}
