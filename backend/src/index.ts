/**
 * @sophep/backend — domain logic, services and database access.
 *
 * The frontend imports from here. Business logic never lives in a Next.js route handler
 * (rules.md R-003): handlers authenticate, validate, delegate here, and shape the response.
 */

// Domain — pure, no I/O, trivially testable
export * from './domain/identity'
export * from './domain/normalisation'
export * from './domain/errors'
export * from './domain/schemas'
export * from './domain/cv'
export * from './domain/crypto'
export * from './domain/verification'
export * from './domain/waitEstimate'
export * from './domain/totp'
export * from './domain/scoring'

// Services — database access, all RLS-context-bound
export * from './services/db'
export * from './services/registration'
export * from './services/notifications'
export * from './services/checkin'
export * from './services/queue'
