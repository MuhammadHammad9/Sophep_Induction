/**
 * CV upload validation.
 *
 * FR-REG-015 requires the content type to be verified BY INSPECTION rather than by extension.
 * The distinction is the whole point: a file named `cv.pdf` whose first bytes are `MZ` is a
 * Windows executable, and an extension allowlist waves it straight through.
 *
 * FR-REG-015, NFR-SEC-007
 */

export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'png', 'jpg', 'jpeg'] as const
export const MAX_SIZE_BYTES = 10 * 1024 * 1024

/**
 * Magic-number signatures. `offset` matters for formats that do not lead with their marker.
 *
 * docx (and every other OOXML file) is a ZIP archive, so it shares `PK\x03\x04` with any other
 * zip. Distinguishing a real docx requires reading the central directory — deliberately not
 * done here. The virus scan and a private bucket are the controls that actually matter; this
 * check exists to reject the obvious, not to be a format parser.
 */
const SIGNATURES: ReadonlyArray<{
  ext: string
  mime: string
  bytes: readonly number[]
  offset: number
}> = [
  { ext: 'pdf',  mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
  { ext: 'png',  mime: 'image/png',       bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { ext: 'jpg',  mime: 'image/jpeg',      bytes: [0xff, 0xd8, 0xff],       offset: 0 },
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: [0x50, 0x4b, 0x03, 0x04], // PK.. — any zip container
    offset: 0,
  },
]

export interface CvValidationResult {
  ok: boolean
  detectedExtension?: string
  detectedMime?: string
  reason?: string
}

export function validateCvUpload(
  filename: string,
  sizeBytes: number,
  head: Uint8Array,
): CvValidationResult {
  if (sizeBytes <= 0) {
    return { ok: false, reason: 'The file is empty' }
  }
  if (sizeBytes > MAX_SIZE_BYTES) {
    return { ok: false, reason: 'The file must be 10 MB or smaller' }
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return { ok: false, reason: 'Upload a PDF, Word document, PNG or JPG' }
  }

  const match = SIGNATURES.find((sig) =>
    sig.bytes.every((b, i) => head[sig.offset + i] === b),
  )

  if (!match) {
    // The content does not match any format we accept, whatever the name claims.
    return { ok: false, reason: 'That file does not look like a PDF, Word document or image' }
  }

  // jpeg/jpg are the same format under two names; docx and zip share a container.
  const normalisedExt = ext === 'jpeg' ? 'jpg' : ext
  const contentMatchesName =
    match.ext === normalisedExt || (match.ext === 'docx' && normalisedExt === 'docx')

  if (!contentMatchesName) {
    return {
      ok: false,
      detectedExtension: match.ext,
      reason: `The file is named .${ext} but its contents are ${match.ext}`,
    }
  }

  return { ok: true, detectedExtension: match.ext, detectedMime: match.mime }
}

/** Number of leading bytes a caller must read for validateCvUpload to work. */
export const REQUIRED_HEAD_BYTES = 8
