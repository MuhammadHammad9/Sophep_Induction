/**
 * Applicant identifiers and access tokens.
 *
 * Two rules govern this file and neither is negotiable:
 *
 *  - The raw token is generated here, returned to the caller ONCE, and never persisted.
 *    Only sha256(token) reaches the database (FR-IDT-006, rules.md R-022).
 *  - Sequence allocation happens in the database, in-transaction. Nothing in this file
 *    computes an identifier from a count (FR-IDT-003, rules.md R-020).
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'

/** SPH-SP26-0042 — society, season+year, zero-padded per-cycle sequence. */
export const DISPLAY_ID_PATTERN = /^[A-Z]{3}-(SP|FA|SU)\d{2}-\d{4,}$/

export type Season = 'SP' | 'FA' | 'SU'

/**
 * Format an identifier from its parts.
 *
 * The season marker is what distinguishes Spring 2026 from Fall 2026. The originally proposed
 * `SP26-0001` could not: two cycles in the same year collided semantically, and an ID that is
 * ambiguous across cycles is worse than useless in a dispute a year later.
 *
 * FR-IDT-001
 */
export function formatDisplayId(
  societyCode: string,
  season: Season,
  year: number,
  sequence: number,
): string {
  if (!/^[A-Z]{3}$/.test(societyCode)) {
    throw new Error(`society code must be three uppercase letters, got "${societyCode}"`)
  }
  if (sequence < 1) {
    throw new Error(`sequence must be positive, got ${sequence}`)
  }
  const yy = String(year % 100).padStart(2, '0')
  return `${societyCode}-${season}${yy}-${String(sequence).padStart(4, '0')}`
}

export interface ParsedDisplayId {
  societyCode: string
  season: Season
  year: number
  sequence: number
}

export function parseDisplayId(displayId: string): ParsedDisplayId | null {
  const m = /^([A-Z]{3})-(SP|FA|SU)(\d{2})-(\d{4,})$/.exec(displayId.trim().toUpperCase())
  if (!m) return null
  const [, societyCode, season, yy, seq] = m
  return {
    societyCode: societyCode!,
    season: season as Season,
    year: 2000 + Number(yy),
    sequence: Number(seq),
  }
}

/**
 * A newly minted token. `raw` exists only in memory and only until it has been rendered into
 * a QR code and an email — it is deliberately not part of any persisted type.
 */
export interface IssuedToken {
  raw: string
  hash: Buffer
}

/**
 * Generate an access token.
 *
 * 16 bytes is 128 bits of entropy, which is the floor FR-IDT-005 sets. base64url so the value
 * survives a URL path segment without escaping — the QR payload is a full HTTPS URL precisely
 * so that any phone camera opens the status page as a fallback, and percent-encoding in that
 * path would break the "just point your camera at it" property.
 *
 * FR-IDT-005
 */
export function generateToken(): IssuedToken {
  const raw = randomBytes(16).toString('base64url')
  return { raw, hash: hashToken(raw) }
}

/** sha256 of the raw token. The only form that is ever stored. FR-IDT-006 */
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest()
}

/**
 * Constant-time comparison of two token hashes.
 *
 * FR-IDT-010 requires this. A plain `===` leaks timing information that lets an attacker
 * recover a valid token byte by byte — slowly, but a token is valid for 60 days.
 */
export function tokenHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Build the QR payload.
 *
 * A full HTTPS URL, not a bare token. The original proposal was a bare token, which requires
 * a custom scanner app; a URL means the default camera on any phone opens the status page, so
 * the custom scanner becomes an optimisation rather than a dependency.
 *
 * The signature is appended in Phase 2 once cycle keypairs exist, giving `/q/<token>.<sig>`.
 * Ed25519, never HMAC — HMAC would require shipping the signing secret to every volunteer's
 * phone (E1, rules.md R-021).
 *
 * FR-IDT-008
 */
export function buildQrPayload(baseUrl: string, rawToken: string, signature?: string): string {
  const suffix = signature ? `${rawToken}.${signature}` : rawToken
  return `${baseUrl.replace(/\/+$/, '')}/q/${suffix}`
}
