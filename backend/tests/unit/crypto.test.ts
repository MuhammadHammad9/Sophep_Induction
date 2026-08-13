/**
 * Cycle keys, signatures and offline verification.
 *
 * These assertions are the ones that would have caught errata E1 — the v1 scheme that required
 * shipping the QR signing secret to every volunteer's phone.
 *
 * Refs: FR-IDT-007, FR-IDT-008, FR-IDT-011, FR-CHK-004, FR-CHK-005, E1
 */

import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  generateCycleKeypair,
  signToken,
  verifyTokenSignature,
  encryptSecret,
  decryptSecret,
  parseQrPayload,
  encryptionKeyFromEnv,
} from '../../src/domain/crypto'
import { verifyOffline, tokenHashB64 } from '../../src/domain/verification'
import { generateToken } from '../../src/domain/identity'

const key = () => randomBytes(32)

describe('cycle keypairs', () => {
  it('produces a 32-byte public key and an encrypted private key', () => {
    const kp = generateCycleKeypair(key())
    expect(kp.publicKey).toHaveLength(32)
    // iv(12) + tag(16) + ciphertext(32)
    expect(kp.privateKeyEncrypted).toHaveLength(60)
  })

  it('never stores the private key in the clear', () => {
    const k = key()
    const kp = generateCycleKeypair(k)
    const seed = decryptSecret(kp.privateKeyEncrypted, k)

    // The encrypted blob must not contain the plaintext seed anywhere in it.
    expect(kp.privateKeyEncrypted.includes(seed)).toBe(false)
  })

  it('gives every cycle a different key (FR-IDT-011)', () => {
    const k = key()
    const a = generateCycleKeypair(k)
    const b = generateCycleKeypair(k)
    expect(a.publicKey.equals(b.publicKey)).toBe(false)
  })
})

describe('signing', () => {
  it('round-trips a signature through the PUBLIC key', () => {
    const k = key()
    const kp = generateCycleKeypair(k)
    const { raw } = generateToken()

    const signature = signToken(raw, kp.privateKeyEncrypted, k)

    // The whole point of Ed25519 over HMAC: verification needs only the public key, so a
    // device can verify offline without being able to forge (E1).
    expect(verifyTokenSignature(raw, signature, kp.publicKey)).toBe(true)
  })

  it("rejects another cycle's signature (FR-IDT-011)", () => {
    const k = key()
    const spring = generateCycleKeypair(k)
    const fall = generateCycleKeypair(k)
    const { raw } = generateToken()

    const springSig = signToken(raw, spring.privateKeyEncrypted, k)

    // A Fall QR must not scan successfully at a Spring induction — otherwise someone is
    // checked in to an event they never applied to.
    expect(verifyTokenSignature(raw, springSig, fall.publicKey)).toBe(false)
  })

  it('rejects a tampered token', () => {
    const k = key()
    const kp = generateCycleKeypair(k)
    const { raw } = generateToken()
    const signature = signToken(raw, kp.privateKeyEncrypted, k)

    const tampered = raw.slice(0, -1) + (raw.endsWith('A') ? 'B' : 'A')
    expect(verifyTokenSignature(tampered, signature, kp.publicKey)).toBe(false)
  })

  it('returns false rather than throwing on a malformed signature', () => {
    // A damaged QR is routine input at a desk, not an exceptional condition.
    const kp = generateCycleKeypair(key())
    for (const bad of ['', 'not-base64url!!', 'AAAA']) {
      expect(verifyTokenSignature('tok', bad, kp.publicKey)).toBe(false)
    }
  })
})

describe('secret encryption', () => {
  it('round-trips', () => {
    const k = key()
    const secret = randomBytes(32)
    expect(decryptSecret(encryptSecret(secret, k), k).equals(secret)).toBe(true)
  })

  it('fails loudly under the wrong key', () => {
    const secret = randomBytes(32)
    expect(() => decryptSecret(encryptSecret(secret, key()), key())).toThrow()
  })

  it('detects tampering — GCM is authenticated', () => {
    const k = key()
    const blob = encryptSecret(randomBytes(32), k)
    blob[40] = blob[40]! ^ 0xff
    expect(() => decryptSecret(blob, k)).toThrow()
  })

  it('rejects a key of the wrong length rather than padding it', () => {
    expect(() => encryptSecret(Buffer.alloc(4), Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('encryptionKeyFromEnv', () => {
  it('throws when unset rather than inventing a key', () => {
    // A silently-generated key would encrypt every cycle's signing key with a value that
    // vanishes on restart, and the failure would surface on the day.
    expect(() => encryptionKeyFromEnv({})).toThrow(/APP_ENCRYPTION_KEY is not set/)
  })

  it('rejects a key that does not decode to 32 bytes', () => {
    expect(() => encryptionKeyFromEnv({ APP_ENCRYPTION_KEY: 'dG9vc2hvcnQ=' })).toThrow(/32 bytes/)
  })

  it('accepts a valid base64 key', () => {
    const k = randomBytes(32).toString('base64')
    expect(encryptionKeyFromEnv({ APP_ENCRYPTION_KEY: k })).toHaveLength(32)
  })
})

describe('parseQrPayload', () => {
  const { raw } = generateToken()

  it('accepts a bare token', () => {
    expect(parseQrPayload(raw)).toEqual({ token: raw, signature: null })
  })

  it('accepts token.signature', () => {
    expect(parseQrPayload(`${raw}.abc123`)).toEqual({ token: raw, signature: 'abc123' })
  })

  it('accepts the full URL a phone camera hands over', () => {
    // FR-IDT-008: the QR encodes an HTTPS URL so any camera app opens the status page as a
    // fallback. The scanner must cope with receiving that whole URL.
    expect(parseQrPayload(`https://apply.sophep.org/q/${raw}.sig`)).toEqual({
      token: raw,
      signature: 'sig',
    })
  })

  it('rejects other apps’ QR codes', () => {
    for (const bad of ['', 'hello world', 'https://example.com/other', 'short']) {
      expect(parseQrPayload(bad), bad).toBeNull()
    }
  })
})

describe('four-layer offline verification', () => {
  const k = key()
  const kp = generateCycleKeypair(k)

  it('layer 2: accepts a token in the cached roster, with no cryptography', () => {
    const { raw } = generateToken()
    const roster = new Set([tokenHashB64(raw)])

    const result = verifyOffline(raw, roster, null)

    expect(result.valid).toBe(true)
    // The 99% case does not touch the signature at all — no secret, no public key, no maths.
    expect(result.valid && result.layer).toBe('roster')
  })

  it('layer 3: accepts a signed token registered after the last sync', () => {
    const { raw } = generateToken()
    const signature = signToken(raw, kp.privateKeyEncrypted, k)

    // Empty roster: this device synced before the applicant registered at another desk.
    const result = verifyOffline(`${raw}.${signature}`, new Set(), kp.publicKey)

    expect(result.valid).toBe(true)
    expect(result.valid && result.layer).toBe('signature')
  })

  it('layer 1: rejects garbage without consulting anything', () => {
    const result = verifyOffline('not a code', new Set(), kp.publicKey)
    expect(result.valid).toBe(false)
    expect(!result.valid && result.reason).toBe('malformed')
  })

  it("rejects a signature from another cycle's key", () => {
    const other = generateCycleKeypair(k)
    const { raw } = generateToken()
    const signature = signToken(raw, other.privateKeyEncrypted, k)

    const result = verifyOffline(`${raw}.${signature}`, new Set(), kp.publicKey)

    expect(result.valid).toBe(false)
    expect(!result.valid && result.reason).toBe('bad_signature')
  })

  it('defers an unsigned unknown token to the server rather than guessing', () => {
    const { raw } = generateToken()
    const result = verifyOffline(raw, new Set(), kp.publicKey)

    expect(result.valid).toBe(false)
    expect(!result.valid && result.reason).toBe('unknown_token')
  })

  it('needs no secret material on the device', () => {
    // The device holds a roster of hashes and a PUBLIC key. Neither can produce a valid code.
    // This is the assertion that E1 was about: verification is possible, forgery is not.
    const { raw } = generateToken()
    const roster = new Set([tokenHashB64(raw)])

    expect(verifyOffline(raw, roster, kp.publicKey).valid).toBe(true)

    const forged = generateToken()
    expect(verifyOffline(forged.raw, roster, kp.publicKey).valid).toBe(false)
  })
})
