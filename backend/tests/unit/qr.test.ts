/**
 * Browser-safe QR verification, and its PARITY with the server.
 *
 * The parity assertions are the important ones. A browser verifier that hashes differently
 * from the server produces a roster that never matches — and that failure only appears with
 * the WiFi off, at a desk, with a queue waiting. It cannot be caught by anything except a test
 * that runs both implementations over the same input.
 *
 * Refs: FR-CHK-004, FR-CHK-005, FR-IDT-008, E1
 */

import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  tokenHashBase64Url,
  parseQrPayload,
  verifyOffline,
  verifyTokenSignature,
  bytesToBase64Url,
  base64UrlToBytes,
} from '../../src/domain/qr'
import { generateCycleKeypair, signToken } from '../../src/domain/crypto'
import { generateToken } from '../../src/domain/identity'
import { tokenHashB64 } from '../../src/domain/verification'

describe('hash parity with the server', () => {
  /**
   * The bug this exists for: a previous browser implementation hashed the token's DECODED
   * BYTES while the server hashes the token STRING. Both "work", neither errors, and the
   * roster silently never matches.
   */
  it('produces the same digest as the server for the same token', () => {
    for (let i = 0; i < 50; i++) {
      const { raw } = generateToken()
      const serverSide = createHash('sha256').update(raw, 'utf8').digest('base64url')
      expect(tokenHashBase64Url(raw)).toBe(serverSide)
    }
  })

  it('agrees with the existing server helper', () => {
    const { raw } = generateToken()
    expect(tokenHashBase64Url(raw)).toBe(tokenHashB64(raw))
  })

  it('is NOT the hash of the decoded bytes — the mistake that was made', () => {
    const { raw } = generateToken()
    const wrong = createHash('sha256')
      .update(Buffer.from(raw, 'base64url'))
      .digest('base64url')

    // If these were ever equal the parity test above would be vacuous.
    expect(tokenHashBase64Url(raw)).not.toBe(wrong)
  })
})

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    for (let i = 0; i < 20; i++) {
      const bytes = new Uint8Array(randomBytes(32))
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes)
    }
  })

  it('matches Node base64url encoding exactly', () => {
    const bytes = new Uint8Array(randomBytes(32))
    expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
  })

  it('accepts values with or without padding', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const encoded = bytesToBase64Url(bytes)
    expect(base64UrlToBytes(encoded)).toEqual(bytes)
    expect(base64UrlToBytes(encoded + '==')).toEqual(bytes)
  })
})

describe('parsing', () => {
  const { raw } = generateToken()

  it('parses a BARE token — the 99% case', () => {
    // The previous implementation required a signature and rejected this outright.
    expect(parseQrPayload(raw)).toEqual({ token: raw, signature: null })
  })

  it('parses token.signature', () => {
    expect(parseQrPayload(`${raw}.abc`)).toEqual({ token: raw, signature: 'abc' })
  })

  it('parses the full URL a camera hands over', () => {
    expect(parseQrPayload(`https://apply.sophep.org/q/${raw}.sig`)).toEqual({
      token: raw,
      signature: 'sig',
    })
  })

  it('rejects other apps’ codes', () => {
    for (const bad of ['', 'hello', 'https://example.com/x', 'short']) {
      expect(parseQrPayload(bad), bad).toBeNull()
    }
  })
})

describe('offline verification', () => {
  const key = randomBytes(32)
  const kp = generateCycleKeypair(key)
  const publicKey = new Uint8Array(kp.publicKey)

  it('layer 2 accepts a token in the roster with no cryptography', () => {
    const { raw } = generateToken()
    const result = verifyOffline(raw, new Set([tokenHashBase64Url(raw)]), null)

    expect(result.valid).toBe(true)
    expect(result.valid && result.layer).toBe('roster')
  })

  it('layer 3 accepts a signed token registered after the last sync', () => {
    // This is the layer that was skipped entirely. Without it a late registration either
    // fails or is waved through unverified.
    const { raw } = generateToken()
    const signature = signToken(raw, kp.privateKeyEncrypted, key)

    const result = verifyOffline(`${raw}.${signature}`, new Set(), publicKey)

    expect(result.valid).toBe(true)
    expect(result.valid && result.layer).toBe('signature')
  })

  it('rejects a signature from a DIFFERENT cycle (FR-IDT-011)', () => {
    const other = generateCycleKeypair(key)
    const { raw } = generateToken()
    const signature = signToken(raw, other.privateKeyEncrypted, key)

    const result = verifyOffline(`${raw}.${signature}`, new Set(), publicKey)

    expect(result.valid).toBe(false)
    expect(!result.valid && result.reason).toBe('bad_signature')
  })

  it('rejects a tampered token', () => {
    const { raw } = generateToken()
    const signature = signToken(raw, kp.privateKeyEncrypted, key)
    const tampered = raw.slice(0, -1) + (raw.endsWith('A') ? 'B' : 'A')

    expect(verifyOffline(`${tampered}.${signature}`, new Set(), publicKey).valid).toBe(false)
  })

  it('defers an unsigned unknown token to the server rather than guessing', () => {
    const { raw } = generateToken()
    const result = verifyOffline(raw, new Set(), publicKey)

    expect(result.valid).toBe(false)
    expect(!result.valid && result.reason).toBe('unknown_token')
  })

  it('cannot forge, holding only the roster and the public key (E1)', () => {
    // The entire correction to E1: a compromised device can VERIFY but not SIGN.
    const { raw } = generateToken()
    const roster = new Set([tokenHashBase64Url(raw)])
    const forged = generateToken()

    expect(verifyOffline(raw, roster, publicKey).valid).toBe(true)
    expect(verifyOffline(forged.raw, roster, publicKey).valid).toBe(false)

    // Even signing with a key they generated themselves does not help — it is not the
    // cycle key.
    const attackerKey = generateCycleKeypair(key)
    const forgedSig = signToken(forged.raw, attackerKey.privateKeyEncrypted, key)
    expect(verifyOffline(`${forged.raw}.${forgedSig}`, roster, publicKey).valid).toBe(false)
  })

  it('never throws on malformed input', () => {
    // A damaged QR is routine at a desk. The previous implementation THREW, which the caller
    // then had to catch and translate — easy to get wrong under pressure.
    for (const bad of ['', 'garbage', 'a.b', 'https://evil.example/q/xx.yy']) {
      expect(() => verifyOffline(bad, new Set(), publicKey)).not.toThrow()
      expect(verifyOffline(bad, new Set(), publicKey).valid).toBe(false)
    }
  })

  it('verifies with an EMPTY public key argument by falling back to the roster', () => {
    // A device that synced before the cycle key existed still works for known applicants.
    const { raw } = generateToken()
    expect(verifyOffline(raw, new Set([tokenHashBase64Url(raw)]), null).valid).toBe(true)
  })
})

describe('signature verification directly', () => {
  const key = randomBytes(32)
  const kp = generateCycleKeypair(key)

  it('round-trips a server signature through the browser verifier', () => {
    // Cross-implementation parity: signed by node:crypto, verified by noble.
    const { raw } = generateToken()
    const signature = signToken(raw, kp.privateKeyEncrypted, key)

    expect(verifyTokenSignature(raw, signature, new Uint8Array(kp.publicKey))).toBe(true)
  })

  it('returns false rather than throwing on a malformed signature', () => {
    for (const bad of ['', 'not-base64url!!', 'AAAA']) {
      expect(verifyTokenSignature('tok', bad, new Uint8Array(kp.publicKey))).toBe(false)
    }
  })
})
