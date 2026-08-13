'use client'

/**
 * The real-time degradation ladder (spec §20.2), over authenticated SSE.
 *
 *   Level 1  live         — the event stream is connected and delivering
 *   Level 2  reconnecting — the stream dropped; retrying with backoff
 *   Level 3  polling      — reconnect has failed for >10s; fetching on an interval
 *   Level 4  offline      — polling is failing too; nothing is fresh
 *
 * ── WHY SSE AND NOT SUPABASE REALTIME ───────────────────────────────────────────────────
 *
 * The previous implementation subscribed to `postgres_changes` and set level 1 on SUBSCRIBED.
 * It would then have delivered nothing: Realtime applies RLS using the subscriber's JWT, while
 * every policy in this schema authorises through `fn_current_user_id()`, which reads the
 * transaction-local `app.user_id` bound by `withContext`. A websocket has no transaction and
 * cannot set it, so every policy denies — and the UI showed "Live" over a structurally empty
 * feed. That is errata E11 returning, and exactly what R-026 forbids (audit H-9).
 *
 * `/api/live` is an ordinary authenticated request, so `requireStaff` and `withContext` apply
 * as they do everywhere else and the SAME policies decide what a subscriber sees. One
 * authorisation model rather than two that must agree forever.
 *
 * ── THE HONESTY RULES, WHICH ARE THE POINT ──────────────────────────────────────────────
 *
 * `lastUpdated` is the instant the SERVER READ the data, taken from the frame — never the
 * instant this client received it, and never `new Date()` at render. Those differ by the
 * network delay that matters most precisely when the network is worst (NFR-AVAIL-004).
 *
 * Level is never optimistic. It rises to 1 only once a frame has actually arrived, not when a
 * connection opens: an open socket that has delivered nothing is not live.
 */

import { useState, useEffect, useRef, useCallback } from 'react'

export type DegradationLevel = 1 | 2 | 3 | 4
export type RealtimeState = 'live' | 'reconnecting' | 'polling' | 'offline'

interface UseRealtimeOptions<T> {
  /** Query string for /api/live — e.g. `panelId=<uuid>` or `stageId=<uuid>`. */
  scope: string
  fetchInitialData: () => Promise<T>
  onUpdate?: (data: T) => void
  pollingIntervalMs?: number
}

/** How long a failing reconnect is tolerated before dropping to polling (spec §20.2). */
const RECONNECT_GRACE_MS = 10_000

export function useRealtime<T>({
  scope,
  fetchInitialData,
  onUpdate,
  pollingIntervalMs = 5000,
}: UseRealtimeOptions<T>) {
  const [data, setData] = useState<T | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [level, setLevel] = useState<DegradationLevel>(3)
  const [state, setState] = useState<RealtimeState>('polling')

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectStartRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  const doPoll = useCallback(async () => {
    try {
      const fresh = await fetchInitialData()
      if (!mountedRef.current) return
      setData(fresh)
      // Polling reads now, so now IS the read instant — unlike a streamed frame, which
      // carries the server's own.
      setLastUpdated(new Date())
      setLevel((l) => (l === 4 ? 3 : l))
      setState((s) => (s === 'offline' ? 'polling' : s))
    } catch {
      if (!mountedRef.current) return
      setLevel(4)
      setState('offline')
    }
  }, [fetchInitialData])

  useEffect(() => {
    mountedRef.current = true

    const startPolling = () => {
      if (pollTimerRef.current) return
      pollTimerRef.current = setInterval(() => void doPoll(), pollingIntervalMs)
    }
    const stopPolling = () => {
      if (!pollTimerRef.current) return
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    // Deferred: setState synchronously inside an effect cascades a re-render on every mount
    // of every live surface.
    void Promise.resolve().then(doPoll)

    let source: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0

    const connect = () => {
      if (!mountedRef.current) return

      source = new EventSource(`/api/live?${scope}`)
      sourceRef.current = source

      source.addEventListener('update', (e) => {
        if (!mountedRef.current) return
        const frame = JSON.parse((e as MessageEvent).data) as { data: T; readAt: string }

        attempt = 0
        reconnectStartRef.current = null
        stopPolling()

        setData(frame.data)
        // The SERVER's read instant, not ours.
        setLastUpdated(new Date(frame.readAt))
        setLevel(1)
        setState('live')
        onUpdate?.(frame.data)
      })

      source.addEventListener('heartbeat', (e) => {
        if (!mountedRef.current) return
        const frame = JSON.parse((e as MessageEvent).data) as { readAt: string }
        // Nothing changed — but the data IS confirmed current as of this instant, and saying
        // so is the difference between a quiet stream and a dead one.
        setLastUpdated(new Date(frame.readAt))
        setLevel(1)
        setState('live')
      })

      // The server closes at its lifetime ceiling and asks us back; that is routine, not an
      // error, so it must not count towards backoff.
      source.addEventListener('reconnect', () => {
        source?.close()
        attempt = 0
        connect()
      })

      source.addEventListener('error', () => {
        source?.close()
        if (!mountedRef.current) return

        if (reconnectStartRef.current === null) {
          reconnectStartRef.current = Date.now()
          setLevel(2)
          setState('reconnecting')
        }

        // Level 3: reconnect has been failing long enough that the user needs SOMETHING
        // fresh, even if it is slower. Polling starts alongside the retries rather than
        // replacing them.
        if (Date.now() - reconnectStartRef.current > RECONNECT_GRACE_MS) {
          setLevel((l) => (l === 4 ? 4 : 3))
          setState((s) => (s === 'offline' ? 'offline' : 'polling'))
          startPolling()
        }

        attempt += 1
        const backoff = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000)
        retryTimer = setTimeout(connect, backoff)
      })
    }

    connect()

    return () => {
      mountedRef.current = false
      if (retryTimer) clearTimeout(retryTimer)
      stopPolling()
      source?.close()
      sourceRef.current = null
    }
  }, [scope, doPoll, onUpdate, pollingIntervalMs])

  return { data, lastUpdated, level, state, forcePoll: doPoll }
}
