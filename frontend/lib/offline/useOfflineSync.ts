'use client'

/**
 * Connection state and the offline queue, for every surface that mutates on the day.
 *
 * `pendingCount` and `conflictCount` are separate on purpose. Pending means "the device still
 * owes the server this, and will retry" — reassuring. Conflict means "the device has given up
 * and a person must look at it" — not reassuring, and the two must never be added together
 * into one number that hides the second inside the first (design principle 2).
 *
 * Refs: FR-CHK-012, FR-CHK-013, FR-CHK-017, NFR-AVAIL-006
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { syncPendingOperations } from './sync'

export function useOfflineSync() {
  const [isOffline, setIsOffline] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const [conflictCount, setConflictCount] = useState(0)
  const [isSyncing, setIsSyncing] = useState(false)

  // A replay pass must never overlap itself: two passes share the same keys and the second
  // earns nothing but 429s.
  const inFlight = useRef(false)

  const updateStatus = useCallback(async () => {
    setIsOffline(!navigator.onLine)
    const { getPendingOperations } = await import('./indexeddb')
    const ops = await getPendingOperations()
    setPendingCount(ops.filter((op) => op.status !== 'conflict' && op.status !== 'failed').length)
    setConflictCount(ops.filter((op) => op.status === 'conflict' || op.status === 'failed').length)
  }, [])

  const sync = useCallback(async () => {
    if (inFlight.current || !navigator.onLine) return
    inFlight.current = true
    setIsSyncing(true)
    try {
      return await syncPendingOperations()
    } finally {
      inFlight.current = false
      setIsSyncing(false)
      await updateStatus()
    }
  }, [updateStatus])

  useEffect(() => {
    // Deferred out of the effect body. Calling updateStatus() synchronously setStates during
    // the effect, which triggers a cascading re-render on every mount of the scanner.
    void Promise.resolve().then(updateStatus)

    const handleOnline = () => {
      setIsOffline(false)
      void sync()
    }

    const handleOffline = () => {
      setIsOffline(true)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Runs whether online or offline. `navigator.onLine` reports the network interface, not
    // whether anything is reachable — captive portals and dead campus APs both report online —
    // so a queue that stopped draining has to be noticed by trying, not by asking.
    const interval = setInterval(() => {
      void (navigator.onLine ? sync() : updateStatus())
    }, 5000)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(interval)
    }
  }, [updateStatus, sync])

  return { isOffline, pendingCount, conflictCount, isSyncing, forceSync: sync }
}
