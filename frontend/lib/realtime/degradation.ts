import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'

export type DegradationLevel = 1 | 2 | 3 | 4
export type RealtimeState = 'live' | 'reconnecting' | 'polling' | 'offline'

interface UseRealtimeOptions<T> {
  channelName: string
  event: string
  schema?: string
  table?: string
  filter?: string
  fetchInitialData: () => Promise<T>
  onUpdate: (payload: unknown) => void
  pollingIntervalMs?: number
}

/**
 * Implements the Real-time Degradation Ladder (spec §20.2)
 * Level 1: Websocket live
 * Level 2: Websocket dropped, reconnecting (exponential backoff)
 * Level 3: Reconnect failing > 10s, fallback to polling
 * Level 4: Polling failing, pure offline mode
 */
export function useRealtime<T>({
  channelName,
  event,
  schema = 'public',
  table,
  filter,
  fetchInitialData,
  onUpdate,
  pollingIntervalMs = 5000,
}: UseRealtimeOptions<T>) {
  const [data, setData] = useState<T | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  const [level, setLevel] = useState<DegradationLevel>(1)
  const [state, setState] = useState<RealtimeState>('live')
  
  const supabase = createClient()
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectStartRef = useRef<number | null>(null)

  const doPoll = useCallback(async () => {
    try {
      const freshData = await fetchInitialData()
      setData(freshData)
      setLastUpdated(new Date())
      if (level === 4) {
        // Recovered network via polling
        setLevel(3)
        setState('polling')
      }
    } catch {
      setLevel(4)
      setState('offline')
    }
  }, [fetchInitialData, level])

  useEffect(() => {
    let mounted = true

    // Deferred out of the effect body: doPoll setStates, and doing that synchronously on
    // mount triggers a cascading re-render on every live surface.
    void Promise.resolve().then(doPoll)

    // 1. Setup Supabase Realtime Channel
    const channel = supabase.channel(channelName)
    channelRef.current = channel

    // supabase-js types `.on` through overloads keyed on a literal event name, and the
    // generic postgres_changes form does not narrow from our variables. Cast through unknown
    // once, here, rather than weakening the surrounding types.
    const subscription = channel as unknown as {
      on: (
        event: string,
        filterSpec: Record<string, unknown>,
        handler: (payload: unknown) => void,
      ) => { subscribe: (cb: (status: string) => void) => unknown }
    }

    subscription
      .on('postgres_changes', { event, schema, table, filter }, (payload: unknown) => {
        if (mounted) {
          onUpdate(payload)
          setLastUpdated(new Date())
        }
      })
      .subscribe((status: string) => {
        if (!mounted) return

        if (status === 'SUBSCRIBED') {
          setLevel(1)
          setState('live')
          reconnectStartRef.current = null
          if (pollTimerRef.current) clearInterval(pollTimerRef.current)
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
          if (!reconnectStartRef.current) {
            reconnectStartRef.current = Date.now()
            setLevel(2)
            setState('reconnecting')
          } else if (Date.now() - reconnectStartRef.current > 10000 && level < 3) {
            // Level 3: Reconnect failing over 10s -> fallback to polling
            setLevel(3)
            setState('polling')
            pollTimerRef.current = setInterval(doPoll, pollingIntervalMs)
          }
        }
      })

    return () => {
      mounted = false
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [channelName, event, schema, table, filter, supabase, doPoll, onUpdate, pollingIntervalMs])

  return { data, lastUpdated, level, state, forcePoll: doPoll }
}
