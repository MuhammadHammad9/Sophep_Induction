/**
 * Cycle signing keys and QR signatures.
 *
 * This file exists because of errata E1, the worst defect in v1.
 *
 * v1 said the QR carried an HMAC signature which the check-in device verified offline using
 * "the cycle's HMAC public verification parameters". There is no such thing. HMAC is
 * SYMMETRIC — verifying one requires the signing secret itself. So v1 required shipping the
 * cycle's QR-signing secret to every volunteer's phone, and anyone who extracted it from a
 * borrowed device, a rooted phone, or cached local storage could mint unlimited valid SOPHEP
 * QR codes. A key-distribution vulnerability described as a resilience feature.
 *
 * The correction has two parts, and the first is that MOST OF THE TIME NO CRYPTOGRAPHY IS
 * NEEDED. The device already caches the day's roster, which holds sha256(token) for every
 * applicant, so offline verification is a set-membership test:
 *
 *     scanned token → sha256 → is this hash in my cached roster?
 *
 * No secret leaves the server. A compromised device leaks the roster it was always going to
 * hold, and leaks no ability to forge anything.
 *
 * Ed25519 covers only the remainder: someone who registered at Desk 2 at 11:00 will not appear
 * in the roster Desk 1 downloaded at 09:30. Being asymmetric, devices carry only the PUBLIC
 * key and can verify without being able to sign — precisely the thing HMAC could never do.
 *
 * Refs: FR-IDT-007, FR-IDT-008, FR-IDT-011, NFR-SEC-002, NFR-SEC-003, E1, rules.md R-021
 */

import {
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
  createPublicKey,
  createPrivateKey,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  type KeyObject,
} from 'node:crypto'
import * as ed from '@noble/ed25519'

// ── Key material ────────────────────────────────────────────────────────────────────────

export interface CycleKeypair {
  /** JWK object for Ed25519 public key. Safe to ship to any device. */
  publicKeyJwk: object
  /** Raw 32-byte Ed25519 seed, encrypted at the application layer. NEVER leaves the server. */
  privateKeyEncrypted: Buffer
}

/**
 * Generate a per-cycle keypair.
 *
 * FR-IDT-011: each cycle uses a distinct keypair, so a token issued in a prior cycle fails
 * signature verification in the current one. Without this a Fall 2026 QR would still scan
 * successfully in Spring 2027 — the applicant would be checked in to an induction they never
 * applied to.
 */
export function generateCycleKeypair(encryptionKey: Buffer): CycleKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  // Export the JWK. The public key is shipped to every device in
  // the offline roster bundle, which has a 100 KB budget for 500 applicants (NFR-PERF-009).
  const jwkPublic = publicKey.export({ format: 'jwk' })
  const rawPrivate = privateKey.export({ format: 'jwk' }).d
  if (!jwkPublic || !rawPrivate) {
    throw new Error('failed to export Ed25519 key material')
  }

  return {
    publicKeyJwk: jwkPublic,
    privateKeyEncrypted: encryptSecret(Buffer.from(rawPrivate, 'base64url'), encryptionKey),
  }
}

/**
 * AES-256-GCM, application layer, on top of the database's own encryption at rest.
 *
 * NFR-SEC-002 requires signing keys to be encrypted with a key held in a managed key service
 * IN ADDITION to storage encryption. The point is that a database dump — a backup file, a
 * support export, a leaked snapshot — must not contain usable signing material.
 */
export function encryptSecret(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes, got ${key.length}`)
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  // iv | authTag | ciphertext — self-describing, so rotation never has to guess a layout.
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

export function decryptSecret(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error(`encryption key must be 32 bytes, got ${key.length}`)
  }
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

/**
 * Read APP_ENCRYPTION_KEY.
 *
 * Deliberately throws rather than falling back to a default. A silently-generated key would
 * encrypt every cycle's signing key with a value that vanishes on restart, and the failure
 * would only surface when a QR needed verifying — on the day.
 */
export function encryptionKeyFromEnv(env = process.env): Buffer {
  const raw = env['APP_ENCRYPTION_KEY']
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — see .env.example')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    )
  }
  return key
}

// ── Signing ─────────────────────────────────────────────────────────────────────────────

function privateKeyObject(rawSeed: Buffer): KeyObject {
  const rawPublic = ed.getPublicKey(rawSeed)
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: rawSeed.toString('base64url'), x: Buffer.from(rawPublic).toString('base64url') },
    format: 'jwk',
  })
}

function publicKeyObject(jwk: any): KeyObject {
  return createPublicKey({
    key: jwk,
    format: 'jwk',
  })
}

/**
 * Sign a raw token with the cycle's private key. Server only, always (rules.md R-021).
 *
 * The signature covers the token STRING, not its hash — the device verifying offline has the
 * token from the QR but not necessarily the hash, and asking it to hash first would make the
 * signature check depend on agreeing about encoding.
 */
export function signToken(rawToken: string, privateKeyEncrypted: Buffer, key: Buffer): string {
  const seed = decryptSecret(privateKeyEncrypted, key)
  try {
    const signature = nodeSign(null, Buffer.from(rawToken, 'utf8'), privateKeyObject(seed))
    return signature.toString('base64url')
  } finally {
    // Reduce the window in which the seed sits in a reachable buffer.
    seed.fill(0)
  }
}

/**
 * Verify a signature with the cycle's PUBLIC key.
 *
 * This is the operation a volunteer's device performs offline. It needs the public key and
 * nothing else — which is the entire reason the scheme is Ed25519 and not HMAC (E1).
 */
export function verifyTokenSignature(
  rawToken: string,
  signatureB64url: string,
  publicKeyJwk: any,
): boolean {
  try {
    return nodeVerify(
      null,
      Buffer.from(rawToken, 'utf8'),
      publicKeyObject(publicKeyJwk),
      Buffer.from(signatureB64url, 'base64url'),
    )
  } catch {
    // Malformed signature, wrong length, bad encoding — all mean "not valid", never a crash.
    // A damaged QR is routine input at a check-in desk, not an exceptional condition.
    return false
  }
}

// ── QR payload ──────────────────────────────────────────────────────────────────────────

export interface ParsedQrPayload {
  token: string
  signature: string | null
}

/**
 * Parse `<token>.<signature>` out of a scanned value.
 *
 * Accepts a bare token (no signature) because roster-hash membership — layer 2, the 99% case —
 * needs no signature at all. Also accepts a full URL, since the QR encodes an HTTPS URL so
 * that any phone camera can open the status page as a fallback (FR-IDT-008).
 */
export function parseQrPayload(scanned: string): ParsedQrPayload | null {
  let value = scanned.trim()
  if (!value) return null

  // Tolerate the full URL form the camera app hands over.
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
