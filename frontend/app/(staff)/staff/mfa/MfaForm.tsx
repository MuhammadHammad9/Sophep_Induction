'use client'

/**
 * The enrolment and challenge form.
 *
 * The QR is rendered as an inline SVG built here rather than fetched from an image service.
 * That is not a preference: the provisioning URI CONTAINS the shared secret, and sending it to
 * a third-party chart API would hand every staff member's second factor to someone else — the
 * exact class of mistake errata E1 is about. It also keeps the page inside the CSP, which has
 * no external image origin.
 *
 * Accessibility is blocking here (rules.md §6): associated labels, `inputmode="numeric"` so the
 * phone shows a number pad, 44px targets, visible focus, and every outcome announced through
 * `role="alert"` rather than only appearing.
 */

import { useState, useEffect, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

interface Offer {
  provisioningUri: string
  manualKey: string
}

export function MfaForm({
  mode,
  next,
  email,
}: {
  mode: 'enrol' | 'challenge'
  next: string
  email: string
}) {
  const router = useRouter()
  const [offer, setOffer] = useState<Offer | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Stage the secret as soon as the enrolment screen opens. Doing it on submit instead would
  // mean generating a secret the user has had no chance to scan.
  useEffect(() => {
    if (mode !== 'enrol') return
    let cancelled = false
    void (async () => {
      const res = await fetch('/api/mfa/enrol', { method: 'POST' })
      if (cancelled) return
      if (res.ok) setOffer((await res.json()) as Offer)
      else setError('Could not start enrolment. Reload the page to try again.')
    })()
    return () => {
      cancelled = true
    }
  }, [mode])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)

    const res = await fetch(mode === 'enrol' ? '/api/mfa/enrol' : '/api/mfa/verify', {
      method: mode === 'enrol' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })

    if (res.ok) {
      // For enrolment the challenge cookie is not yet set, so bounce through the challenge
      // rather than landing on a privileged page that will immediately redirect back.
      router.replace(mode === 'enrol' ? `/staff/mfa?challenge=1&next=${encodeURIComponent(next)}` : next)
      router.refresh()
      return
    }

    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    setError(body?.error?.message ?? 'That did not work. Check the code and try again.')
    setCode('')
    setBusy(false)
  }

  return (
    <div className="mt-6 space-y-6">
      {mode === 'enrol' && (
        <div className="rounded-card border border-border bg-surface p-4">
          {offer ? (
            <>
              <p className="text-small">
                Scan this with Google Authenticator, 1Password, or any TOTP app.
              </p>
              <div className="mt-3 flex justify-center">
                <QrCode text={offer.provisioningUri} />
              </div>
              <p className="mt-3 text-small text-text-muted">
                Cannot scan? Enter this key manually for <span className="id-text">{email}</span>:
              </p>
              <code className="mt-1 block break-all rounded-control bg-background p-2 text-small">
                {offer.manualKey}
              </code>
            </>
          ) : (
            <p className="text-small text-text-muted">Preparing your authenticator setup…</p>
          )}
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="mfa-code" className="block text-small font-medium">
            Six-digit code
          </label>
          <input
            id="mfa-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="id-text mt-1 min-h-[44px] w-full rounded-control border border-border
                       bg-surface px-3 text-id-md tracking-[0.3em] focus:outline-none
                       focus-visible:ring-2 focus-visible:ring-offset-2
                       focus-visible:ring-state-called"
          />
        </div>

        <button
          type="submit"
          disabled={busy || code.length !== 6 || (mode === 'enrol' && !offer)}
          className="min-h-[44px] w-full rounded-control bg-state-called px-4 font-medium
                     text-white focus:outline-none focus-visible:ring-2
                     focus-visible:ring-offset-2 focus-visible:ring-state-called
                     disabled:opacity-50"
        >
          {busy ? 'Checking…' : mode === 'enrol' ? 'Confirm and enable' : 'Verify'}
        </button>

        {/* NFR-A11Y-005: announced, not merely rendered. */}
        <div role="alert" aria-live="assertive">
          {error && (
            <p className="rounded-card border border-state-blocked/30 bg-state-blocked-fill p-3 text-small text-state-blocked">
              {error}
            </p>
          )}
        </div>
      </form>
    </div>
  )
}

/**
 * A minimal QR encoder, inline.
 *
 * Byte mode, error correction level L, sized to whatever version fits the URI. Deliberately not
 * a dependency and deliberately not a hosted image: the payload is a shared secret, so it must
 * never leave this page. ~90 lines is a fair price for that.
 */
function QrCode({ text }: { text: string }) {
  const modules = encodeQr(text)
  const n = modules.length
  const quiet = 4
  const size = n + quiet * 2

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={240}
      height={240}
      role="img"
      aria-label="Authenticator setup QR code"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      {modules.map((row, y) =>
        row.map((on, x) =>
          on ? <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} fill="#000" /> : null,
        ),
      )}
    </svg>
  )
}

function encodeQr(text: string): boolean[][] {
  const data = new TextEncoder().encode(text)

  // Byte-mode capacities at EC level L, versions 1-10. The provisioning URI for a 20-byte
  // secret lands around version 4-6; the table covers well past that.
  const CAP = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271]
  const version = CAP.findIndex((c) => data.length + 2 <= c) + 1
  if (version === 0) throw new Error('provisioning URI too long to encode')

  const n = 17 + version * 4
  const total = CAP[version - 1]!

  // Mode indicator (0100) + length + payload, then the standard pad pattern.
  const bits: number[] = []
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(0b0100, 4)
  push(data.length, version < 10 ? 8 : 16)
  for (const b of data) push(b, 8)
  push(0, Math.min(4, total * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  }
  const PAD = [0xec, 0x11]
  let p = 0
  while (codewords.length < total) codewords.push(PAD[p++ % 2]!)

  // Reed-Solomon over GF(256) for the error-correction codewords.
  const ecCount = EC_COUNT[version - 1]!
  const ec = reedSolomon(codewords, ecCount)
  const all = [...codewords, ...ec]

  // Matrix assembly: function patterns first, then the data spiral, then masking.
  const m: (boolean | null)[][] = Array.from({ length: n }, () => Array<boolean | null>(n).fill(null))
  const setFinder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
        const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
        m[rr]![cc] = inner && (ring || core)
      }
    }
  }
  setFinder(0, 0)
  setFinder(0, n - 7)
  setFinder(n - 7, 0)

  for (let i = 8; i < n - 8; i++) {
    m[6]![i] = i % 2 === 0
    m[i]![6] = i % 2 === 0
  }
  if (version > 1) {
    const pos = [6, n - 7]
    for (const r of pos) {
      for (const c of pos) {
        if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            m[r + dr]![c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
          }
        }
      }
    }
  }
  m[n - 8]![8] = true // the always-dark module

  const reserved = (r: number, c: number) =>
    r === 6 || c === 6 || (r < 9 && c < 9) || (r < 9 && c >= n - 8) || (r >= n - 8 && c < 9)

  let bit = 0
  const stream = all.flatMap((cw) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (cw >> s) & 1))
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < n; i++) {
      const up = ((n - 1 - col) >> 1) % 2 === 0
      const row = up ? n - 1 - i : i
      for (const c of [col, col - 1]) {
        if (m[row]![c] !== null || reserved(row, c)) continue
        const v = bit < stream.length ? stream[bit]! : 0
        bit++
        // Mask 0: invert where (row + col) is even. Chosen fixed rather than evaluated —
        // penalty scoring across eight masks is a lot of code for a payload that is always
        // the same shape, and every reader handles mask 0.
        m[row]![c] = ((v ^ ((row + c) % 2 === 0 ? 1 : 0)) & 1) === 1
      }
    }
  }

  // Format information for EC level L with mask 0.
  const FORMAT = 0b111011111000100
  for (let i = 0; i < 15; i++) {
    const on = ((FORMAT >> i) & 1) === 1
    if (i < 6) m[i]![8] = on
    else if (i < 8) m[i + 1]![8] = on
    else if (i === 8) m[8]![7] = on
    else m[8]![14 - i] = on

    if (i < 8) m[8]![n - 1 - i] = on
    else m[n - 15 + i]![8] = on
  }

  return m.map((row) => row.map((v) => v === true))
}

const EC_COUNT = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18]

function reedSolomon(data: number[], ecLen: number): number[] {
  const EXP = new Uint8Array(512)
  const LOG = new Uint8Array(256)
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0)
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!)

  let gen = [1]
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] = (next[j] ?? 0) ^ mul(gen[j]!, EXP[i]!)
      next[j + 1] = (next[j + 1] ?? 0) ^ gen[j]!
    }
    gen = next
  }

  const rem = new Array<number>(ecLen).fill(0)
  for (const d of data) {
    const factor = d ^ rem[0]!
    rem.shift()
    rem.push(0)
    for (let i = 0; i < ecLen; i++) rem[i] = rem[i]! ^ mul(gen[i + 1]!, factor)
  }
  return rem
}
