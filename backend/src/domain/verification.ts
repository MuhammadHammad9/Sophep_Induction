/**
 * Four-layer token verification.
 *
 * | Layer | Runs | Requires | Catches |
 * |---|---|---|---|
 * | 1 Format    | device, offline | nothing        | garbage and other apps' QR codes |
 * | 2 Roster    | device, offline | cached roster  | everyone registered before sync — the 99% case |
 * | 3 Ed25519   | device, offline | **public** key | applicants registered after sync |
 * | 4 Server    | online          | database       | revocation, cycle, state, single use |
 *
 * Layer 2 is the workhorse and needs no cryptography at all: hash what you scanned, look it up
 * in the cached set. Layer 3 exists only because someone registering at Desk 2 at 11:00 will
 * not appear in the roster Desk 1 downloaded at 09:30 — and Ed25519 lets Desk 1 verify them
 * anyway WITHOUT holding a signing key (E1).
 *
 * Layers 1–3 are pure and run identically on the server and in the browser, so the PWA and the
 * API cannot disagree about whether a code is valid.
 *
 * Refs: FR-CHK-004, FR-CHK-005, FR-CHK-018, E1, rules.md R-021
 */

import { createHash } from 'node:crypto'
import { parseQrPayload, verifyTokenSignature } from './crypto'

export type VerificationLayer = 'format' | 'roster' | 'signature' | 'server'

export type VerificationOutcome =
  | { valid: true; token: string; tokenHashHex: string; layer: VerificationLayer }
  | { valid: false; reason: VerificationFailure; layer: VerificationLayer }

export type VerificationFailure =
  | 'malformed'          // not a SOPHEP code at all
  | 'unknown_token'      // well-formed, unsigned, not in the roster
  | 'bad_signature'      // signed, but not by this cycle's key

/**
 * The offline roster bundle.
 *
 * FR-CHK-018 is emphatic about what this may contain: token hashes and the cycle public key
 * ONLY. No evaluations, no scores, no decisions, no private key material. A device lost at the
 * venue then leaks a set of opaque hashes and a public key — neither of which permits forging
 * anything or learning anything about a person.
 *
 * NFR-PERF-009 budgets 100 KB for 500 applicants, which hex hashes alone would blow; hashes
 * are therefore carried base64url (43 chars each).
 */
export interface RosterBundle {
  cycleId: string
  stageId: string
  /** base64url sha256(token) — a SET, so membership is O(1) on a device holding 500 entries. */
  tokenHashes: string[]
  /** base64url raw Ed25519 public key. */
  publicKey: string
  generatedAt: string
}

/** Hash a raw token to the form used in the roster bundle. */
export function tokenHashB64(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('base64url')
}

export function tokenHashHex(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

/**
 * Verify a scanned value offline, using only material that is safe to hold on a device.
 *
 * `roster` is a Set for membership testing. `publicKey` is the raw 32-byte Ed25519 public key.
 * Neither can be used to create a valid code.
 */
export function verifyOffline(
  scanned: string,
  roster: ReadonlySet<string>,
  publicKey: Buffer | Uint8Array | null,
): VerificationOutcome {
  // ── Layer 1: format ───────────────────────────────────────────────────────────────────
  const parsed = parseQrPayload(scanned)
  if (!parsed) {
    return { valid: false, reason: 'malformed', layer: 'format' }
  }

  const hashB64 = tokenHashB64(parsed.token)

  // ── Layer 2: roster membership — no cryptography, the 99% case ────────────────────────
  if (roster.has(hashB64)) {
    return {
      valid: true,
      token: parsed.token,
      tokenHashHex: tokenHashHex(parsed.token),
      layer: 'roster',
    }
  }

  // ── Layer 3: Ed25519, for applicants registered after this device last synced ─────────
  if (parsed.signature && publicKey) {
    if (verifyTokenSignature(parsed.token, parsed.signature, publicKey)) {
      return {
        valid: true,
        token: parsed.token,
        tokenHashHex: tokenHashHex(parsed.token),
        layer: 'signature',
      }
    }
    return { valid: false, reason: 'bad_signature', layer: 'signature' }
  }

  // Well-formed, unsigned, and not in this device's roster. Could be a genuinely late
  // registration from a desk that issues unsigned tokens, or a code from another cycle.
  // The device cannot tell the difference, so it must not guess: layer 4 decides.
  return { valid: false, reason: 'unknown_token', layer: 'roster' }
}

/**
 * What the volunteer sees for each outcome (spec §7.2, §19.2).
 *
 * `dismissRequired` is the part that matters most in practice. Successes auto-clear after
 * 2.5 s so the volunteer never taps — 200 scans × one tap is 200 chances to double-tap and
 * 200 wasted seconds. Failures REQUIRE dismissal, because a failure that scrolls past
 * unnoticed becomes a person nobody checked in.
 */
export interface ScanPresentation {
  tone: 'success' | 'warning' | 'error' | 'info'
  headline: string
  guidance?: string
  dismissRequired: boolean
}

export function presentFailure(reason: VerificationFailure): ScanPresentation {
  switch (reason) {
    case 'malformed':
      return {
        tone: 'error',
        headline: 'Not a valid SOPHEP code',
        guidance: 'Search for them by name or ID instead.',
        dismissRequired: true,
      }
    case 'bad_signature':
      return {
        tone: 'error',
        headline: 'This code is from a different cycle',
        guidance: 'Register them as a new applicant.',
        dismissRequired: true,
      }
    case 'unknown_token':
      return {
        tone: 'info',
        headline: 'Not in this device’s list',
        guidance: 'Reconnect to check, or search by name.',
        dismissRequired: true,
      }
  }
}
