/**
 * CV upload validation.
 *
 * FR-REG-015 requires content type to be verified BY INSPECTION rather than by extension. The
 * distinction is the entire security value: an extension allowlist waves through a Windows
 * executable named `cv.pdf`.
 */

import { describe, it, expect } from 'vitest'
import { validateCvUpload, MAX_SIZE_BYTES } from '../../src/domain/cv'

const pdf = () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]) // %PDF-1.7
const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const jpg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const zip = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])
const exe = () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]) // MZ

describe('accepted files', () => {
  it.each([
    ['cv.pdf', pdf(), 'pdf'],
    ['scan.png', png(), 'png'],
    ['photo.jpg', jpg(), 'jpg'],
    ['photo.jpeg', jpg(), 'jpg'],
    ['cv.docx', zip(), 'docx'],
  ])('accepts %s', (name, head, ext) => {
    const r = validateCvUpload(name, 1024, head)
    expect(r.ok).toBe(true)
    expect(r.detectedExtension).toBe(ext)
  })
})

describe('rejected files', () => {
  /**
   * The case the requirement exists for. An executable renamed to cv.pdf passes any
   * extension check and fails here, at the magic number.
   */
  it('rejects an executable disguised as a PDF', () => {
    const r = validateCvUpload('cv.pdf', 1024, exe())
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/does not look like/i)
  })

  it('rejects a PNG renamed to .pdf', () => {
    const r = validateCvUpload('cv.pdf', 1024, png())
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/named \.pdf but its contents are png/i)
  })

  it('rejects a disallowed extension even with valid content', () => {
    const r = validateCvUpload('cv.exe', 1024, pdf())
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/PDF, Word document, PNG or JPG/i)
  })

  it('enforces the 10 MB cap', () => {
    expect(validateCvUpload('cv.pdf', MAX_SIZE_BYTES + 1, pdf()).ok).toBe(false)
    expect(validateCvUpload('cv.pdf', MAX_SIZE_BYTES, pdf()).ok).toBe(true)
  })

  it('rejects an empty file', () => {
    expect(validateCvUpload('cv.pdf', 0, pdf()).ok).toBe(false)
  })

  it('rejects a file with no extension', () => {
    expect(validateCvUpload('cv', 1024, pdf()).ok).toBe(false)
  })
})

describe('known limitation', () => {
  /**
   * docx is a ZIP container, so any zip passes as a docx. Distinguishing a real docx means
   * reading the central directory, which is deliberately not done here — the virus scan and a
   * private bucket are the controls that matter. Asserted so the limitation is recorded rather
   * than discovered later and mistaken for a bug.
   */
  it('cannot distinguish a docx from another zip', () => {
    expect(validateCvUpload('anything.docx', 1024, zip()).ok).toBe(true)
  })
})
