/**
 * Identifier formatting and token generation.
 *
 * Refs: FR-IDT-001, FR-IDT-005, FR-IDT-006, FR-IDT-008, FR-IDT-010
 */

import { describe, it, expect } from 'vitest'
import {
  formatDisplayId,
  parseDisplayId,
  generateToken,
  hashToken,
  tokenHashEquals,
  buildQrPayload,
  DISPLAY_ID_PATTERN,
} from '../../src/domain/identity'

describe('formatDisplayId', () => {
  it('produces the documented format', () => {
    expect(formatDisplayId('SPH', 'SP', 2026, 42)).toBe('SPH-SP26-0042')
  })

  it('zero-pads to four digits and grows beyond them', () => {
    expect(formatDisplayId('SPH', 'SP', 2026, 1)).toBe('SPH-SP26-0001')
    expect(formatDisplayId('SPH', 'SP', 2026, 12345)).toBe('SPH-SP26-12345')
  })

  /**
   * The reason the format changed from the originally proposed `SP26-0001`: Spring 2026 and
   * Fall 2026 produced identical prefixes, so two cycles in one year collided semantically.
   * An identifier that is ambiguous across cycles is worthless in a dispute a year later.
   */
  it('distinguishes seasons within the same year', () => {
    expect(formatDisplayId('SPH', 'SP', 2026, 1)).not.toBe(formatDisplayId('SPH', 'FA', 2026, 1))
  })

  it('rejects a malformed society code', () => {
    expect(() => formatDisplayId('SOPHEP', 'SP', 2026, 1)).toThrow()
    expect(() => formatDisplayId('sp', 'SP', 2026, 1)).toThrow()
  })

  it('rejects a non-positive sequence', () => {
    expect(() => formatDisplayId('SPH', 'SP', 2026, 0)).toThrow()
  })

  it('matches the shared pattern', () => {
    expect(DISPLAY_ID_PATTERN.test(formatDisplayId('SPH', 'FA', 2027, 7))).toBe(true)
  })
})

describe('parseDisplayId', () => {
  it('round-trips', () => {
    const id = formatDisplayId('SPH', 'SP', 2026, 42)
    expect(parseDisplayId(id)).toEqual({
      societyCode: 'SPH',
      season: 'SP',
      year: 2026,
      sequence: 42,
    })
  })

  it('accepts lowercase and surrounding whitespace', () => {
    // Volunteers retype identifiers off paper slips under time pressure.
    expect(parseDisplayId('  sph-sp26-0042 ')?.sequence).toBe(42)
  })

  it('returns null for anything else', () => {
    for (const bad of ['', 'SPH-XX26-0042', 'SP26-0042', 'not an id']) {
      expect(parseDisplayId(bad), bad).toBeNull()
    }
  })
})

describe('generateToken', () => {
  it('produces at least 128 bits of entropy, URL-safe', () => {
    const { raw } = generateToken()
    // 16 bytes base64url encodes to 22 characters with no padding.
    expect(raw).toHaveLength(22)
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken().raw))
    expect(tokens.size).toBe(1000)
  })

  it('returns a 32-byte sha256 hash alongside the raw value', () => {
    const { raw, hash } = generateToken()
    expect(hash).toHaveLength(32)
    expect(hash.equals(hashToken(raw))).toBe(true)
  })
})

describe('tokenHashEquals', () => {
  it('matches identical hashes and rejects different ones', () => {
    const a = hashToken('same')
    expect(tokenHashEquals(a, hashToken('same'))).toBe(true)
    expect(tokenHashEquals(a, hashToken('different'))).toBe(false)
  })

  it('rejects mismatched lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch; the guard must absorb that, because a
    // truncated token from a damaged QR is a routine input, not an exceptional one.
    expect(tokenHashEquals(hashToken('x'), Buffer.alloc(16))).toBe(false)
  })
})

describe('buildQrPayload', () => {
  /**
   * A full HTTPS URL rather than a bare token, so any phone camera opens the status page.
   * The custom scanner is then an optimisation rather than a dependency — which matters when
   * a volunteer's device fails at 10:15 on the day.
   */
  it('builds a camera-resolvable URL', () => {
    expect(buildQrPayload('https://apply.sophep.org', 'kTn3xQ8vLp2wRb9Y')).toBe(
      'https://apply.sophep.org/q/kTn3xQ8vLp2wRb9Y',
    )
  })

  it('appends the Phase 2 signature', () => {
    expect(buildQrPayload('https://apply.sophep.org', 'tok', 'sig')).toBe(
      'https://apply.sophep.org/q/tok.sig',
    )
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(buildQrPayload('https://apply.sophep.org/', 'tok')).toBe(
      'https://apply.sophep.org/q/tok',
    )
  })
})
