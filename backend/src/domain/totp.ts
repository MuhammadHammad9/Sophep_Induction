/**
 * TOTP — RFC 6238, implemented directly.
 *
 * FR-RBAC-008 requires a second factor for Coordinator, Admin and Super Admin. Those are the
 * accounts that can bump a queue priority, waive an evaluation, void an interview, and — for
 * Super Admin — publish results. A shared laptop left unlocked in a hall is the realistic
 * threat, not a remote attacker.
 *
 * Written here rather than pulled from a dependency because the algorithm is forty lines of
 * standard-library crypto, and a dependency in the authentication path is a supply-chain
 * surface that has to be justified. The RFC 6238 test vectors are asserted in the unit tests.
 *
 * The secret is encrypted at the application layer before storage (NFR-SEC-002), so a database
 * dump does not yield working second factors.
 *
 * Refs: FR-RBAC-008, NFR-SEC-002
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DIGITS = 6
const PERIOD_SECONDS = 30

/**
 * How many steps either side of "now" are accepted.
 *
 * One step (±30 s) tolerates ordinary clock drift and the seconds a person spends typing.
 * Widening it multiplies the window an intercepted code stays usable, so it stays at one.
 */
const DRIFT_STEPS = 1

// RFC 4648 base32, the alphabet every authenticator app expects.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''

  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const bytes: number[] = []

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error('invalid base32 character')

    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** 20 bytes — the RFC 4226 recommendation for HMAC-SHA1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20)
}

/**
 * The provisioning URI an authenticator app scans.
 *
 * The issuer appears twice by convention: as a label prefix for apps that only read the
 * label, and as a parameter for those that read parameters. Getting this wrong shows the
 * account as a bare email with no indication of which system it belongs to — which matters
 * when a committee member has fifteen entries in their app.
 */
export function totpProvisioningUri(secret: Buffer, account: string, issuer = 'SOPHEP'): string {
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?${params}`
}

/** HOTP (RFC 4226) — the counter-based primitive TOTP is built on. */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  // JavaScript numbers are exact to 2^53, far beyond any realistic counter, but the value is
  // still 64-bit on the wire.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', secret).update(buf).digest()

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = digest[digest.length - 1]! & 0x0f
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)

  return String(code % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function totpCode(secret: Buffer, atMs: number = Date.now()): string {
  return hotp(secret, Math.floor(atMs / 1000 / PERIOD_SECONDS))
}

/**
 * Verify a submitted code.
 *
 * Comparison is constant-time. A plain `===` leaks how many leading digits matched, and with
 * a six-digit code and no rate limit that is a genuine shortcut.
 *
 * Returns the matched step so the caller can persist it and refuse replay — RFC 6238 §5.2 is
 * explicit that a code must be accepted only once, otherwise anyone who observes a code over
 * a shoulder has a 30-second window to reuse it.
 */
export function verifyTotp(
  secret: Buffer,
  submitted: string,
  options: { atMs?: number; lastUsedStep?: number } = {},
): { valid: boolean; step?: number } {
  const code = submitted.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return { valid: false }

  const currentStep = Math.floor((options.atMs ?? Date.now()) / 1000 / PERIOD_SECONDS)

  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const step = currentStep + drift

    // Replay guard: never accept a step already used.
    if (options.lastUsedStep !== undefined && step <= options.lastUsedStep) continue

    const expected = Buffer.from(hotp(secret, step))
    const actual = Buffer.from(code)
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
      return { valid: true, step }
    }
  }

  return { valid: false }
}

/** Roles that require a second factor (FR-RBAC-008). */
export const MFA_REQUIRED_ROLES = ['super_admin', 'coordinator', 'admin'] as const

export function requiresMfa(roles: readonly string[]): boolean {
  return roles.some((r) => (MFA_REQUIRED_ROLES as readonly string[]).includes(r))
}
