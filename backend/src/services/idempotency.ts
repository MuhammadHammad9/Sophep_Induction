/**
 * Durable idempotency.
 *
 * This replaces an in-memory Map, and the difference is not academic. On Vercel every
 * serverless instance has its own memory and it is discarded on restart. A device that has been
 * offline for eight hours replays hundreds of operations; those land on SEVERAL instances, each
 * with an empty map, and none of them recognises a replay. Duplicates get created.
 *
 * It would pass every local test, because one dev server is one instance with one map.
 * FR-CHK-014 requires "100% reconciliation with ZERO duplicate records", which is a claim only
 * the database can make.
 *
 * Refs: FR-CHK-008, FR-CHK-014, FR-OPS-004
 */

import { createHash } from 'node:crypto'
import type { Tx } from './db'
import { RmsError } from '../domain/errors'

/**
 * Hash the request so a genuine replay can be told from a key reused for something else.
 *
 * Keys are sorted before hashing: two JSON objects with the same content but different key
 * order are the same request, and treating them as different would reject a legitimate replay
 * — which on the day means a check-in that never lands.
 */
export function hashRequest(endpoint: string, body: unknown): Buffer {
  return createHash('sha256').update(`${endpoint}\n${stableStringify(body)}`, 'utf8').digest()
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export interface IdempotentResult<T> {
  value: T
  /** True when this returned a stored response rather than doing the work again. */
  replayed: boolean
}

/**
 * Run `work` at most once for a given key.
 *
 * The caller supplies the key — for offline replay it is the `client_request_id` the device
 * generated when it queued the operation, so the SAME key survives the whole journey from a
 * disconnected phone to the server hours later (FR-CHK-014).
 *
 * With no key, the work simply runs. That is correct rather than lax: a GET or an interactive
 * action a human is watching does not need replay protection, and demanding a key everywhere
 * would push callers into inventing them, which defeats the mechanism.
 */
export async function withIdempotency<T>(
  tx: Tx,
  options: {
    key: string | null | undefined
    endpoint: string
    body: unknown
    cycleId?: string
    /** Status code stored alongside the response, so a replay reproduces it exactly. */
    statusCode?: number
  },
  work: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (!options.key) {
    return { value: await work(), replayed: false }
  }

  const requestHash = hashRequest(options.endpoint, options.body)

  const rows = await tx<
    Array<{ verdict: string; response: unknown; status_code: number | null }>
  >`
    SELECT * FROM fn_claim_idempotency(
      ${options.key}, ${options.endpoint}, ${requestHash}::bytea, ${options.cycleId ?? null}::uuid
    )
  `

  const verdict = rows[0]?.verdict

  if (verdict === 'replay') {
    return { value: rows[0]!.response as T, replayed: true }
  }

  if (verdict === 'conflict') {
    // FR-OPS-004. Refusing is deliberate: quietly treating this as a replay would DISCARD an
    // operation the caller believes succeeded.
    throw new RmsError(
      'IDEMPOTENCY_KEY_REUSED',
      'This request id was already used for a different request',
    )
  }

  if (verdict === 'in_flight') {
    // A concurrent request holds the key — a double-tap, or two replay passes overlapping.
    // Retryable, because the first attempt will finish and the retry will then see 'replay'.
    throw new RmsError('RATE_LIMITED', 'That request is already being processed')
  }

  try {
    const value = await work()

    await tx`
      SELECT fn_complete_idempotent(
        ${options.key},
        ${tx.json((value ?? null) as Parameters<typeof tx.json>[0])}::jsonb,
        ${options.statusCode ?? 200}::smallint
      )
    `

    return { value, replayed: false }
  } catch (err) {
    // Release the key so the device's retry is not refused as a concurrent request forever.
    // Without this a single failure would permanently block that operation from ever syncing.
    await tx`SELECT fn_release_idempotency(${options.key})`
    throw err
  }
}

/**
 * Record that a replayed operation lost to an existing record (FR-CHK-015).
 *
 * The EARLIEST SERVER-RECEIVED record is retained — server time, not the client's, because
 * FR-CHK-016 makes server time authoritative and a phone with a skewed clock must not be able
 * to overwrite a correct record by claiming an earlier moment.
 *
 * Both sides are written down. Silent discard is prohibited, because the discarded one may be
 * the correct one and nobody can investigate what was never recorded.
 */
export async function recordConflict(
  tx: Tx,
  input: {
    cycleId: string
    applicantId?: string
    kind: string
    retainedId: string
    retainedAt: Date
    discarded: unknown
    clientTs?: Date
  },
): Promise<string> {
  const rows = await tx<Array<{ fn_record_sync_conflict: string }>>`
    SELECT fn_record_sync_conflict(
      ${input.cycleId}::uuid,
      ${input.applicantId ?? null}::uuid,
      ${input.kind},
      ${input.retainedId}::uuid,
      ${input.retainedAt}::timestamptz,
      ${tx.json(input.discarded as Parameters<typeof tx.json>[0])}::jsonb,
      ${input.clientTs ?? null}::timestamptz
    )
  `
  return rows[0]!.fn_record_sync_conflict
}
