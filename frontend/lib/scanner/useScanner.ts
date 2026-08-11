'use client'

/**
 * The camera loop.
 *
 * FR-CHK-001: the camera is CONTINUOUSLY ACTIVE and never requires a tap to initiate
 * scanning. A "press to scan" button costs a tap per applicant, and across 200 scans that is
 * 200 chances to double-tap and 200 wasted seconds — on the one screen where seconds are the
 * whole point (NFR-PERF-003 budgets 8 seconds end to end).
 *
 * Refs: FR-CHK-001, NFR-PERF-001, NFR-PERF-003
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { createDecoder, type Decoder, type DecodeSource } from './decode'

export type CameraState =
  | { status: 'starting' }
  | { status: 'running'; source: DecodeSource }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: string }

interface Options {
  /** Called once per distinct code. Suppressed while a result overlay is showing. */
  onScan: (value: string) => void
  /** Pause decoding while a result is displayed, so one code is not read fifteen times. */
  paused: boolean
}

export function useScanner({ onScan, paused }: Options) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const decoderRef = useRef<Decoder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastValueRef = useRef<{ value: string; at: number } | null>(null)

  const [state, setState] = useState<CameraState>({ status: 'starting' })

  // Kept in a ref so the animation loop never restarts when the callback identity changes —
  // restarting the loop mid-scan drops frames precisely when someone is holding up a phone.
  const onScanRef = useRef(onScan)
  const pausedRef = useRef(paused)
  useEffect(() => {
    onScanRef.current = onScan
  }, [onScan])
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    decoderRef.current?.dispose()
    decoderRef.current = null
  }, [])

  useEffect(() => {
    let cancelled = false

    async function start() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setState({ status: 'unavailable', reason: 'This browser cannot use the camera' })
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // 1280×720 is a deliberate compromise: high enough to read a QR from a phone
            // screen at arm's length in bad light, low enough that decoding stays inside the
            // 500 ms budget on a mid-range Android.
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        })

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => {})
        }

        const decoder = await createDecoder()
        if (cancelled) {
          decoder.dispose()
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        decoderRef.current = decoder
        setState({ status: 'running', source: decoder.source })

        const tick = async () => {
          rafRef.current = requestAnimationFrame(() => void tick())

          const video = videoRef.current
          const dec = decoderRef.current
          if (!video || !dec || pausedRef.current || video.readyState < 2) return

          const value = await dec.decode(video)
          if (!value) return

          // Debounce the same code. A QR sitting in frame decodes on every frame, and without
          // this the desk would fire dozens of identical check-ins per second.
          const last = lastValueRef.current
          const now = Date.now()
          if (last && last.value === value && now - last.at < 3000) return

          lastValueRef.current = { value, at: now }
          onScanRef.current(value)
        }

        void tick()
      } catch (err) {
        if (cancelled) return
        const name = (err as { name?: string })?.name
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setState({ status: 'denied' })
        } else {
          setState({
            status: 'unavailable',
            reason: name === 'NotFoundError' ? 'No camera found' : 'Camera unavailable',
          })
        }
      }
    }

    void start()

    return () => {
      cancelled = true
      stop()
    }
  }, [stop])

  return { videoRef, state }
}
