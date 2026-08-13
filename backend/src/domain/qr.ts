/**
 * QR verification — the shared, BROWSER-SAFE implementation.
 *
 * This is the code that runs on a volunteer's phone with the WiFi off, and the identical code
 * that runs on the server. That is the whole point: if the two sides disagree about whether a
 * code is valid, the disagreement only surfaces at a check-in desk, offline, with a queue
 * waiting — the worst possible place to discover it.
 *
 * It therefore imports NOTHING from `node:crypto`. Hashing and signature verification both go
 * through @noble, which is pure JavaScript and behaves identically in Node and in a browser.
 *
 * A previous browser-side implementation got three things wrong, and each would have failed
 * silently:
 *
 *   1. It hashed the token's DECODED BYTES while the server hashes the token STRING. Those
 *      produce different digests, so layer 2 could never match the roster and every scan would
 *      have fallen through to the network — precisely the thing offline mode exists to avoid.
 *   2. It skipped Ed25519 entirely ("would go here"), so a late registration was accepted on
 *      roster membership alone or not at all — there was no forgery check.
 *   3. Its regex required a signature, so a BARE token — the 99% case — did not parse.
 *
 * Refs: FR-CHK-004, FR-CHK-005, FR-IDT-008, FR-IDT-011, E1, rules.md R-021
 */

import * as ed from '@noble/ed25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha512 } from '@noble/hashes/sha2.js'

// noble v2 ships no hash of its own. Wired here as well as in crypto.ts because this module
// is the one that loads in the browser, where crypto.ts is never imported.
ed.etc.sha512Sync = (...messages: Uint8Array[]) => sha512(ed.etc.concatBytes(...messages))
ed.etc.sha512Async = async (...messages: Uint8Array[]) =>
  sha512(ed.etc.concatBytes(...messages))

// ── Encoding helpers, Buffer-free so they work in a browser ─────────────────────────────

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(bytes).toString('base64')

  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(value: string): Uint8Array {
  // Strip any padding the caller supplied BEFORE re-padding. A signature copied from a header
  // or a URL may arrive either way, and re-padding an already-padded value produces an
  // invalid string — which would surface as "this code is from a different cycle" at a desk.
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)

  if (typeof atob === 'function') {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Uint8Array((globalThis as any).Buffer.from(padded, 'base64'))
}

const textEncoder = new TextEncoder()

/**
 * sha256 of the raw token STRING, base64url encoded.
 *
 * The server computes `sha256(token, 'utf8')`. This must produce the identical value or every
 * roster lookup fails — so it hashes the UTF-8 bytes of the string, NOT the bytes the token
 * decodes to. The parity is asserted in tests/unit/qr.test.ts.
 */
export function tokenHashBase64Url(rawToken: string): string {
  return bytesToBase64Url(sha256(textEncoder.encode(rawToken)))
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────

export interface ParsedQrPayload {
  token: string
  signature: string | null
}

/**
 * Parse `<token>.<signature>` out of a scanned value.
 *
 * A BARE token must parse: roster-hash membership needs no signature, and that is the common
 * case. The full HTTPS URL must also parse, because the QR encodes one so any phone camera
 * opens the status page as a fallback (FR-IDT-008).
 */
export function parseQrPayload(scanned: string): ParsedQrPayload | null {
  let value = scanned.trim()
  if (!value) return null

  const urlMatch = /\/q\/([^/?#\s]+)/.exec(value)
  if (urlMatch?.[1]) {
    value = urlMatch[1]
  } else if (value.includes('://')) {
    return null // a URL, but not one of ours
  }

  const dot = value.indexOf('.')
  const token = dot === -1 ? value : value.slice(0, dot)
  const signature = dot === -1 ? null : value.slice(dot + 1)

  // Tokens are 16 random bytes base64url — 22 characters, no padding.
  if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return null
  if (signature !== null && !/^[A-Za-z0-9_-]+$/.test(signature)) return null

  return { token, signature }
}

// ── Verification ────────────────────────────────────────────────────────────────────────

export function verifyTokenSignature(
  rawToken: string,
  signatureBase64Url: string,
  publicKey: Uint8Array,
): boolean {
  try {
    return ed.verify(
      base64UrlToBytes(signatureBase64Url),
      textEncoder.encode(rawToken),
      publicKey,
    )
  } catch {
    // A damaged QR is routine input at a desk, not an exceptional condition.
    return false
  }
}

export type VerificationLayer = 'format' | 'roster' | 'signature' | 'server'

export type VerificationFailure =
  | 'malformed' // not a SOPHEP code at all
  | 'unknown_token' // well-formed, unsigned, not in this device's roster
  | 'bad_signature' // signed, but not by this cycle's key

export type VerificationOutcome =
  | { valid: true; token: string; tokenHash: string; layer: VerificationLayer }
  | { valid: false; reason: VerificationFailure; layer: VerificationLayer }

/**
 * The four-layer check, layers 1–3 (layer 4 is the server).
 *
 * Nothing here can FORGE a code: the device holds a set of opaque hashes and a PUBLIC key.
 * That is the entire correction to E1 — v1 would have required the signing secret on every
 * phone in order to do this at all.
 */
export function verifyOffline(
  scanned: string,
  roster: ReadonlySet<string>,
  publicKey: Uint8Array | null,
): VerificationOutcome {
  // Layer 1 — format.
  const parsed = parseQrPayload(scanned)
  if (!parsed) {
    return { valid: false, reason: 'malformed', layer: 'format' }
  }

  const tokenHash = tokenHashBase64Url(parsed.token)

  // Layer 2 — roster membership. No cryptography at all, and the 99% case.
  if (roster.has(tokenHash)) {
    return { valid: true, token: parsed.token, tokenHash, layer: 'roster' }
  }

  // Layer 3 — Ed25519, for someone who registered after this device last synced.
  if (parsed.signature && publicKey) {
    if (verifyTokenSignature(parsed.token, parsed.signature, publicKey)) {
      return { valid: true, token: parsed.token, tokenHash, layer: 'signature' }
    }
    return { valid: false, reason: 'bad_signature', layer: 'signature' }
  }

  // Well-formed, unsigned, and unknown to this device. It could be a genuinely late
  // registration or a code from another cycle — the device cannot tell, so it must not guess.
  // Layer 4 decides.
  return { valid: false, reason: 'unknown_token', layer: 'roster' }
}
