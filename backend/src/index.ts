/**
 * @sophep/backend — domain logic, services and database access.
 *
 * The frontend imports from here. Business logic never lives in a Next.js route handler
 * (rules.md R-003): handlers authenticate, validate, delegate here, and shape the response.
 */

// Domain — pure, no I/O, trivially testable
export { formatDisplayId, parseDisplayId, generateToken, hashToken, tokenHashEquals, buildQrPayload } from './domain/identity'
export type { Season, ParsedDisplayId, IssuedToken } from './domain/identity'
export { normEmail, normPhone, normRoll } from './domain/normalisation'
export { fromPostgresError } from './domain/errors'
export type { ErrorCode, ErrorBody } from './domain/errors'
export { RmsError } from './domain/errors'
export { registrationChannels, registrationInputSchema, applicantSearchSchema, cvUploadSchema, screeningSchema } from './domain/schemas'
export type { RegistrationChannel, RegistrationInput, RegistrationParsed } from './domain/schemas'
export { validateCvUpload } from './domain/cv'
export type { CvValidationResult } from './domain/cv'
export { generateCycleKeypair, encryptSecret, decryptSecret, encryptionKeyFromEnv, signToken, verifyTokenSignature, parseQrPayload } from './domain/crypto'
export type { CycleKeypair, ParsedQrPayload } from './domain/crypto'
export { tokenHashB64, tokenHashHex, verifyOffline, presentFailure } from './domain/verification'
export type { VerificationLayer, VerificationOutcome, VerificationFailure, RosterBundle, ScanPresentation } from './domain/verification'
export { updateEwma, computeEwma, estimateWait, modelCapacity } from './domain/waitEstimate'
export type { WaitEstimateConfig, SuppressionReason, RevisionCause, WaitEstimate, WaitEstimateInput, CapacityInput, CapacityVerdict } from './domain/waitEstimate'
export { base32Encode, base32Decode, generateTotpSecret, totpProvisioningUri, totpCode, verifyTotp, requiresMfa } from './domain/totp'
export { computeBiases, applyShrinkage, applicantFinalScore, flagsForApplicant, reviewBand } from './domain/scoring'
export type { EvaluationInput, InterviewerBias, AdjustedEvaluation, ScoreFlag, FlagConfig, ReviewBand, BandConfig } from './domain/scoring'

// Services — database access, all RLS-context-bound
export { getDb, closeDb, withContext, withoutContext, asPrivileged, withIdempotency } from './services/db'
export type { Sql, Tx, SecurityContext } from './services/db'
export { checkDuplicates, register, searchApplicants, screenApplicant, newIdempotencyKey } from './services/registration'
export type { DuplicateMatch, DuplicateReport, RegistrationResult } from './services/registration'
export { enqueue, getProvider } from './services/notifications'
export type { NotificationRequest, RenderedMessage, NotificationProvider } from './services/notifications'
export { ensureCycleKeypair, signTokenForCycle, buildRosterBundle, resolveScannedToken, checkIn } from './services/checkin'
export type { CheckInResult, TokenResolution } from './services/checkin'
export { callNext, startInterview, expireGrace, extendGrace, reactivateParked, setPriority, trackSnapshot, queuePosition, applicantWait } from './services/queue'
export type { ClaimedApplicant, TrackSnapshot, ApplicantWaitView } from './services/queue'
export { submitEvaluation } from './services/evaluation'
export { getPanelSnapshot } from './services/panel'
export type { PanelSnapshot } from './services/panel'
