/**
 * QR decoding.
 *
 * Scan latency is the single biggest factor in desk throughput (spec: tech_stack), and
 * NFR-PERF-001 budgets 500 ms from camera frame to decoded payload. So: use the browser's
 * native BarcodeDetector where it exists — it is hardware-accelerated and costs nothing to
 * ship — and fall back to zxing-wasm where it does not.
 *
 * That fallback is not hypothetical. BarcodeDetector is absent on iOS Safari, and NFR-COMP-001
 * requires iOS 15+. Without zxing-wasm the scanner would simply not work on roughly half the
 * volunteers' phones.
 *
 * Refs: NFR-PERF-001, NFR-COMP-001, NFR-COMP-002
 */

export type DecodeSource = 'native' | 'wasm'

export interface Decoder {
  readonly source: DecodeSource
  decode(bitmap: ImageBitmap | HTMLVideoElement): Promise<string | null>
  dispose(): void
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats: string[] }): BarcodeDetectorLike
      getSupportedFormats?: () => Promise<string[]>
    }
  }
}

async function nativeAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.BarcodeDetector) return false
  try {
    // Presence of the constructor is not enough — some builds expose it without QR support.
    const formats = (await window.BarcodeDetector.getSupportedFormats?.()) ?? []
    return formats.length === 0 || formats.includes('qr_code')
  } catch {
    return false
  }
}

function createNativeDecoder(): Decoder {
  const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })

  return {
    source: 'native',
    async decode(bitmap) {
      try {
        const results = await detector.detect(bitmap as CanvasImageSource)
        return results[0]?.rawValue ?? null
      } catch {
        // A detector throwing on one frame is routine — a blurred or half-exposed frame is
        // not an error, it is the next frame's problem.
        return null
      }
    },
    dispose() {},
  }
}

async function createWasmDecoder(): Promise<Decoder> {
  const { readBarcodes, prepareZXingModule } = await import('zxing-wasm/reader')

  // Warm the module once. Doing this lazily on the first scan would cost the volunteer a
  // multi-hundred-millisecond stall at precisely the wrong moment.
  await prepareZXingModule({ fireImmediately: true })

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  return {
    source: 'wasm',
    async decode(source) {
      if (!ctx) return null

      const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width
      const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height
      if (!width || !height) return null

      canvas.width = width
      canvas.height = height
      ctx.drawImage(source as CanvasImageSource, 0, 0, width, height)

      try {
        const results = await readBarcodes(ctx.getImageData(0, 0, width, height), {
          formats: ['QRCode'],
          tryHarder: false, // tryHarder triples decode time; the camera runs continuously
        })
        return results[0]?.text ?? null
      } catch {
        return null
      }
    },
    dispose() {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export async function createDecoder(): Promise<Decoder> {
  return (await nativeAvailable()) ? createNativeDecoder() : createWasmDecoder()
}
