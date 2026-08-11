/**
 * Server-side validation schemas.
 *
 * FR-REG-003: all input is validated server-side against a schema. Client-side validation is
 * never the sole gate — the same schema is shared with the frontend for immediate feedback,
 * but the server re-validates every time, because the client is not a trusted party.
 */

import { z } from 'zod'

/**
 * Pakistani phone numbers arrive as 0300-1234567, +92 300 1234567, 923001234567, and
 * occasionally with a country code and no leading zero. Rather than enforce one spelling —
 * which fails a volunteer typing what is printed on a paper form — accept anything that
 * normalises to at least 9 digits and let normPhone decide identity.
 */
const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine((v) => v.replace(/\D/g, '').length >= 9, {
    message: 'Enter a valid phone number with at least 9 digits',
  })

/**
 * Deliberately permissive. A stricter pattern rejects valid addresses (plus-tags, subdomains,
 * long TLDs) and the real check is deliverability — a bounce webhook tells you the truth that
 * no regex can (FR-NOT-002).
 */
const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .email('Enter a valid email address')

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Enter your full name')
  .max(120)

export const registrationChannels = ['online', 'walkin_digital', 'walkin_paper'] as const
export type RegistrationChannel = (typeof registrationChannels)[number]

/**
 * Registration input, shared by all three channels.
 *
 * FR-REG-002: every channel produces an identical record structure. There is one schema here
 * on purpose — a separate, looser schema for paper transcription is exactly how a channel
 * becomes second-class.
 */
export const registrationInputSchema = z.object({
  cycleId: z.string().uuid(),
  fullName: nameSchema,
  email: emailSchema,
  phone: phoneSchema,
  rollNumber: z.string().trim().max(32).optional().nullable(),
  source: z.enum(registrationChannels),

  /** Ranked department preferences, highest first. Length capped per cycle config. */
  preferences: z.array(z.string().uuid()).max(10).default([]),

  answers: z.record(z.unknown()).default({}),

  /** FR-REG-008: an override requires a written reason of at least 10 characters. */
  overrideReason: z
    .string()
    .trim()
    .min(10, 'Give at least 10 characters explaining why this is a different person')
    .max(500)
    .optional(),

  /** FR-CHK-010: register-and-check-in leaves a deliberately partial record. */
  needsCompletion: z.boolean().default(false),
})

export type RegistrationInput = z.input<typeof registrationInputSchema>
export type RegistrationParsed = z.output<typeof registrationInputSchema>

/**
 * FR-CHK-009: search by any 4 consecutive digits of the identifier, the last 4 digits of the
 * phone number, or a partial name. Four characters is the floor — fewer returns most of the
 * cohort and is slower to scan than retyping.
 */
export const applicantSearchSchema = z.object({
  cycleId: z.string().uuid(),
  q: z.string().trim().min(2).max(120),
  limit: z.number().int().min(1).max(50).default(20),
})

/** FR-REG-015. Content type is verified by INSPECTION, not by extension — see cv.ts. */
export const cvUploadSchema = z.object({
  applicantId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  declaredType: z.string().trim().min(1).max(128),
})

export const screeningSchema = z.object({
  applicantId: z.string().uuid(),
  outcome: z.enum(['eligible', 'screened_out']),
  reason: z.string().trim().min(5).max(500).optional(),
}).refine((v) => v.outcome !== 'screened_out' || (v.reason?.length ?? 0) >= 5, {
  message: 'A reason is required to screen an applicant out',
  path: ['reason'],
})
