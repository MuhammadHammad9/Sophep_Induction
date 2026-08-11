/**
 * @sophep/backend/browser — the browser-safe subset.
 *
 * WHY THIS FILE EXISTS.
 *
 * The main entry point re-exports the service layer, which imports `postgres` and
 * `node:crypto`. A CLIENT component that imports anything from it drags those into the browser
 * bundle and the build fails with a module-not-found on `node:crypto` — which is what happened
 * the moment a form imported a validation schema for client-side feedback.
 *
 * The fix is not to loosen the bundler. It is to have an entry point that CANNOT reach the
 * database: everything here is pure, has no I/O, and runs identically on both sides. That also
 * makes rules.md R-003 mechanical rather than aspirational — a client component physically
 * cannot import a service from here.
 *
 * Shared validation matters for real: the form gives immediate feedback from the same schema
 * the server enforces, so the two can never disagree about what a valid phone number is. The
 * server still re-validates every time (FR-REG-003) — this is ergonomics, not a gate.
 */

// The four-layer QR check. Browser-safe by construction: no node:crypto anywhere in its
// import graph, so the volunteer's phone runs the SAME verification the server does.
export * from './domain/qr'

export * from './domain/normalisation'
export * from './domain/errors'
export * from './domain/schemas'
export * from './domain/cv'
export * from './domain/waitEstimate'
export * from './domain/scoring'
