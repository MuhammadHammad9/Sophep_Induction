import {
  getPendingOperations,
  updateOperationStatus,
  removePendingOperation,
} from './indexeddb'

/**
 * Replays offline mutating operations in client-timestamp order.
 * Ensures strict idempotency via Idempotency-Key (the operation ID).
 */
export async function syncPendingOperations() {
  const operations = await getPendingOperations()
  const pending = operations.filter((op) => op.status !== 'syncing')

  if (pending.length === 0) return 0

  let successCount = 0

  for (const op of pending) {
    await updateOperationStatus(op.id, 'syncing')

    try {
      const res = await fetch(op.endpoint, {
        method: op.method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': op.id, // CRITICAL: Replay protection
        },
        body: JSON.stringify(op.payload),
      })

      if (res.ok || res.status === 409) {
        // 409 means Idempotency_Key_Reused, which we treat as success for replay purposes
        await removePendingOperation(op.id)
        successCount++
      } else {
        const error = await res.text()
        await updateOperationStatus(op.id, 'failed', error)
      }
    } catch (e) {
      await updateOperationStatus(op.id, 'pending', e instanceof Error ? e.message : 'Network error')
      // Stop syncing on first network failure to preserve order
      break
    }
  }

  return successCount
}
