'use client'

import { useState, useEffect, useCallback } from 'react'
import { syncPendingOperations } from './sync'

export function useOfflineSync() {
  const [isOffline, setIsOffline] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)

  const updateStatus = useCallback(async () => {
    setIsOffline(!navigator.onLine)
    const ops = await import('./indexeddb').then(m => m.getPendingOperations())
    setPendingCount(ops.length)
  }, [])

  useEffect(() => {
    updateStatus()

    const handleOnline = async () => {
      setIsOffline(false)
      await syncPendingOperations()
      await updateStatus()
    }

    const handleOffline = () => {
      setIsOffline(true)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    
    // Poll for pending operations count if offline
    const interval = setInterval(() => {
      if (!navigator.onLine) updateStatus()
    }, 5000)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      clearInterval(interval)
    }
  }, [updateStatus])

  return { isOffline, pendingCount, forceSync: syncPendingOperations }
}
