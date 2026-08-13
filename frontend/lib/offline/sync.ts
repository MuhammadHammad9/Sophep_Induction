/**
 * Replay of the offline queue.
 *
 * Operations replay in CLIENT-TIMESTAMP order, each carrying the idempotency key the device
 * generated when it queued the operation — the same key it will still carry eight hours later
 * (FR-CHK-014). Ordering comes from the `by-ts` index, not from insertion order.
 *
 * The single most important property here is that an operation is deleted only when the server
 * has confirmed it. Anything else is kept, because a deleted operation is a person who stood at
 * the desk and was checked in and will never appear in the system, with nothing to show it
 * happened (FR-CHK-015: "silent discard is prohibited").
 *
 * Refs: FR-CHK-012..017, FR-OPS-004
 */

import {
  getPendingOperations,
  updateOperationStatus,
  removePendingOperation,
} from './indexeddb'

export interface SyncOutcome {
  /** Confirmed by the server — either applied now, or recognised as an earlier replay. */
  synced: number
  /** Refused as a reused request id. Needs a human (FR-CHK-017). */
  conflicts: number
  /** Still queued: the network dropped again, or the server said "try again". */
  remaining: number
}

export async function syncPendingOperations(): Promise<SyncOutcome> {
  const operations = await getPendingOperations()

  // `syncing` is skipped: another pass is mid-flight with the same key, and racing it would
  // earn a 429 for no benefit. `conflict` is skipped because a human owns it now.
  const queue = operations.filter((op) => op.status === 'pending' || op.status === 'failed')

  const outcome: SyncOutcome = { synced: 0, conflicts: 0, remaining: 0 }
  if (queue.length === 0) return outcome

  for (const [index, op] of queue.entries()) {
    await updateOperationStatus(op.id, 'syncing')

    let res: Response
    try {
      res = await fetch(op.endpoint, {
        method: op.method,
        headers: {
          'Content-Type': 'application/json',
          // The key the operation was born with. This is what makes a replay a replay.
          'Idempotency-Key': op.id,
        },
        body: JSON.stringify(op.payload),
      })
    } catch (e) {
      // The network went away again. Put this one back and STOP — continuing would replay
      // later operations before earlier ones, and order is a requirement, not a nicety.
      await updateOperationStatus(op.id, 'pending', e instanceof Error ? e.message : 'Network error')
      outcome.remaining = queue.length - index
      return outcome
    }

    if (res.ok) {
      // 200 and 201 are both success: 200 means the server had already recorded this operation
      // — which is the mechanism working, not a failure.
      await removePendingOperation(op.id)
      outcome.synced++
      continue
    }

    if (res.status === 409) {
      // IDEMPOTENCY_KEY_REUSED. The server saw this request id attached to a DIFFERENT request,
      // so THIS operation was never applied. Treating it as success — as an earlier version of
      // this file did — deletes a real check-in and reports it as reconciled.
      await updateOperationStatus(op.id, 'conflict', await describe(res))
      outcome.conflicts++
      continue
    }

    if (res.status === 429 || res.status >= 500) {
      // Transient: a concurrent replay holds the key, or the server is briefly unwell. Leave it
      // queued and stop, so ordering survives to the next attempt.
      await updateOperationStatus(op.id, 'pending', await describe(res))
      outcome.remaining = queue.length - index
      return outcome
    }

    // A 4xx that will never succeed on retry — a revoked token, a closed stage. Retrying it
    // forever would block everything behind it, so it is set aside for reconciliation instead.
    await updateOperationStatus(op.id, 'failed', await describe(res))
    outcome.conflicts++
  }

  return outcome
}

async function describe(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } }
    return body.error?.message ?? `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}
