/**
 * TOTP.
 *
 * The RFC 6238 test vectors are the point of this file: an implementation that agrees with
 * itself but not with the RFC produces codes no authenticator app will ever match, and the
 * failure appears the first time a real committee member tries to sign in.
 *
 * Refs: FR-RBAC-008, RFC 4226, RFC 6238
 */

import { describe, it, expect } from 'vitest'
import {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  totpCode,
  verifyTotp,
  totpProvisioningUri,
  requiresMfa,
} from '../../src/domain/totp'

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890" for SHA1.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii')

describe('RFC 6238 test vectors', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('produces the published code at t=%i', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected)
  })
})

describe('base32', () => {
  it('round-trips', () => {
    const secret = generateTotpSecret()
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true)
  })

  it('matches the RFC 4648 encoding authenticator apps expect', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })

  it('tolerates whitespace and padding, as pasted from a screen', () => {
    const secret = generateTotpSecret()
    const encoded = base32Encode(secret)
    const messy = `${encoded.slice(0, 4)} ${encoded.slice(4)}==`
    expect(base32Decode(messy).equals(secret)).toBe(true)
  })
})

describe('verification', () => {
  it('accepts the current code', () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    expect(verifyTotp(secret, totpCode(secret, now), { atMs: now }).valid).toBe(true)
  })

  it('tolerates one step of clock drift each way', () => {
    // Covers ordinary device drift plus the seconds someone spends typing.
    const secret = generateTotpSecret()
    const now = Date.now()

    expect(verifyTotp(secret, totpCode(secret, now - 30_000), { atMs: now }).valid).toBe(true)
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), { atMs: now }).valid).toBe(true)
  })

  it('rejects a code two steps away', () => {
    // Every extra step widens the window in which an observed code stays usable.
    const secret = generateTotpSecret()
    const now = Date.now()
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), { atMs: now }).valid).toBe(false)
  })

  it('rejects another secret’s code', () => {
    const now = Date.now()
    expect(
      verifyTotp(generateTotpSecret(), totpCode(generateTotpSecret(), now), { atMs: now }).valid,
    ).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    const secret = generateTotpSecret()
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad).valid, bad).toBe(false)
    }
  })

  /**
   * RFC 6238 §5.2: a code must be accepted only once. Without this, anyone who reads a code
   * over a shoulder has a 30-second window to reuse it — which on a shared laptop in a hall
   * is the realistic threat.
   */
  it('refuses to replay a code already used', () => {
    const secret = generateTotpSecret()
    const now = Date.now()
    const code = totpCode(secret, now)

    const first = verifyTotp(secret, code, { atMs: now })
    expect(first.valid).toBe(true)
    expect(first.step).toBeDefined()

    const replay = verifyTotp(secret, code, { atMs: now, lastUsedStep: first.step! })
    expect(replay.valid).toBe(false)
  })

  it('still accepts the NEXT code after one is consumed', () => {
    const secret = generateTotpSecret()
    const now = Date.now()

    const first = verifyTotp(secret, totpCode(secret, now), { atMs: now })
    const later = now + 30_000

    expect(
      verifyTotp(secret, totpCode(secret, later), { atMs: later, lastUsedStep: first.step! }).valid,
    ).toBe(true)
  })
})

describe('provisioning', () => {
  it('builds a scannable otpauth URI naming the issuer twice', () => {
    // Apps vary in whether they read the label prefix or the parameter; without both, the
    // entry shows as a bare email with no indication of which system it belongs to.
    const uri = totpProvisioningUri(generateTotpSecret(), 'president@sophep.local')

    expect(uri.startsWith('otpauth://totp/SOPHEP:president%40sophep.local?')).toBe(true)
    expect(uri).toContain('issuer=SOPHEP')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})

describe('which roles need a second factor', () => {
  it('requires it for privileged roles only (FR-RBAC-008)', () => {
    expect(requiresMfa(['super_admin'])).toBe(true)
    expect(requiresMfa(['coordinator'])).toBe(true)
    expect(requiresMfa(['admin'])).toBe(true)

    // Volunteers and interviewers sign in on the day, often on a borrowed device. Requiring
    // TOTP there would cost more in blocked volunteers than it buys in security.
    expect(requiresMfa(['volunteer'])).toBe(false)
    expect(requiresMfa(['interviewer'])).toBe(false)
  })

  it('requires it if ANY held role does', () => {
    // E13: capabilities are the union across roles, so the strictest requirement wins.
    expect(requiresMfa(['interviewer', 'coordinator'])).toBe(true)
  })
})
