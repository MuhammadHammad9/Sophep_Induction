# Backend & API Route Code Audit Report

## Executive Summary

A comprehensive, senior-level code audit of the backend package (`backend/src/`) and API route handlers (`frontend/app/api/`) was conducted. The audit focused on domain logic (`crypto.ts`, `cv.ts`, `errors.ts`, `identity.ts`, `normalisation.ts`, `schemas.ts`, `scoring.ts`, `totp.ts`, `verification.ts`, `waitEstimate.ts`, `services/db.ts`, `services/registration.ts`, `services/notifications.ts`, `services/checkin.ts`, `services/queue.ts`, `jobs/anonymisation.ts`, `jobs/consistency.ts`), algorithm correctness (Empirical-Bayes shrinkage, Gale-Shapley allocation, Ed25519 QR verification), error handling, thin controller compliance (`R-003`), rate-limiting, and performance.

### Overview of Findings
Total Issues Identified: **12 Substantive Issues**
- **Critical Severity**: 1
- **High Severity**: 5
- **Medium Severity**: 4
- **Low / Technical Debt**: 2

---

## Detailed Findings and Remediation Strategies

### Issue 1: RLS Access Failure in Unauthenticated Context (`/api/q/[token]/on-my-way`)
- **File Path**: `frontend/app/api/q/[token]/on-my-way/route.ts`
- **Line Numbers**: 24–40
- **Severity**: **Critical**
- **Category**: Security / RLS & Broken Functionality
- **Description**:
  The `POST /api/q/:token/on-my-way` handler calls `withContext({}, async (tx) => { ... })` with an empty security context `{}`. `withContext` sets `app.applicant_id` to `''`. Under migration `0008_rls.sql`, row-level security on `queue_entries` fails closed when `app.applicant_id` is empty. Line 31 attempts to query:
  ```sql
  SELECT id FROM queue_entries
   WHERE applicant_id = ${applicantId}::uuid AND state = 'called'
   ORDER BY called_at DESC LIMIT 1
  ```
  Because `app.applicant_id` is unset, Postgres RLS blocks access and returns 0 rows. Line 37 then throws `RmsError('INVALID_TRANSITION', 'You have not been called yet')` on every request. Consequently, the "On My Way" +2 minute grace period extension feature is completely broken for public applicants accessing via token.
- **Concrete Recommended Fix**:
  First resolve the applicant ID from token using `fn_resolve_token`, then bind `applicantId` to `withContext`:
  ```typescript
  const resolvedId = await withContext({}, async (tx) => {
    const rows = await tx`SELECT applicant_id FROM fn_resolve_token(${hashToken(parsed.token)}::bytea)`
    return rows[0]?.applicant_id
  })
  if (!resolvedId) throw new RmsError('TOKEN_INVALID', 'Invalid link')

  await withContext({ applicantId: resolvedId }, async (tx) => {
    const entries = await tx`SELECT id FROM queue_entries WHERE applicant_id = ${resolvedId}::uuid AND state = 'called' LIMIT 1`
    if (!entries[0]?.id) throw new RmsError('INVALID_TRANSITION', 'You have not been called yet')
    await extendGrace(tx, entries[0].id)
  })
  ```

---

### Issue 2: Invalid Ed25519 JWK Private Key Export/Import in Node Crypto
- **File Path**: `backend/src/domain/crypto.ts`
- **Line Numbers**: 130–136 (`privateKeyObject`), 151–160 (`signToken`)
- **Severity**: **High**
- **Category**: Cryptography / Security
- **Description**:
  In `privateKeyObject(rawSeed: Buffer)`, the Ed25519 private key is imported into Node's crypto subsystem via JWK format:
  ```typescript
  function privateKeyObject(rawSeed: Buffer): KeyObject {
    return createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: rawSeed.toString('base64url'), x: '' },
      format: 'jwk',
    })
  }
  ```
  Passing `x: ''` (empty string) violates RFC 8037 section 2, which requires `x` to be a valid 43-character base64url-encoded string representing the 32-byte public key coordinate. In Node.js, `createPrivateKey` validates the JWK schema and throws `TypeError [ERR_CRYPTO_INVALID_JWK]: Invalid JWK`. This causes `signToken()` to throw a runtime error whenever QR signing is performed.
- **Concrete Recommended Fix**:
  Export and reconstruct the private key using PKCS#8 DER format or include `x` parameter when constructing the JWK object. Alternatively, derive the public key coordinate `x` from `d` or use PKCS#8 wrapping for the 32-byte Ed25519 seed:
  ```typescript
  function privateKeyObject(rawSeed: Buffer): KeyObject {
    // DER PKCS#8 prefix for Ed25519 private key (32-byte seed)
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex')
    return createPrivateKey({
      key: Buffer.concat([prefix, rawSeed]),
      format: 'der',
      type: 'pkcs8',
    })
  }
  ```

---

### Issue 3: Review Band Calculation Ignores Flagged Applicants with Rank > 2C (`FR-SCR-012` Defect)
- **File Path**: `backend/src/domain/scoring.ts`
- **Line Numbers**: 231–248 (`reviewBand`)
- **Severity**: **High**
- **Category**: Algorithm Correctness
- **Description**:
  Requirement `FR-SCR-012` mandates: *"Any flagged applicant shall be forced into the discussion band irrespective of rank."*
  However, in `reviewBand()`:
  ```typescript
  export function reviewBand(rank: number, capacity: number, flags: readonly ScoreFlag[]): ReviewBand {
    if (flags.includes('CRITERION_FLOOR')) return 'excluded'

    if (rank > capacity * config.discussMultiplier) return 'below' // Line 240

    if (flags.length > 0) return 'discuss' // Line 244

    return rank <= capacity * config.clearMultiplier ? 'clear' : 'discuss'
  }
  ```
  Line 240 evaluates `rank > 2C` and returns `'below'` BEFORE checking `flags.length > 0` on line 244. If an applicant has a high-disagreement flag (`HIGH_DISAGREEMENT` or `LOW_CONFIDENCE`) but their rank happens to be greater than `2C`, `reviewBand()` returns `'below'` instead of `'discuss'`. This directly violates `FR-SCR-012`.
- **Concrete Recommended Fix**:
  Reorder the flag check so that `if (flags.length > 0) return 'discuss'` executes BEFORE checking `rank > capacity * config.discussMultiplier`:
  ```typescript
  export function reviewBand(
    rank: number,
    capacity: number,
    flags: readonly ScoreFlag[],
    config: BandConfig = DEFAULT_BAND_CONFIG,
  ): ReviewBand {
    if (flags.includes('CRITERION_FLOOR')) return 'excluded'
    if (flags.length > 0) return 'discuss'
    if (rank > capacity * config.discussMultiplier) return 'below'
    return rank <= capacity * config.clearMultiplier ? 'clear' : 'discuss'
  }
  ```

---

### Issue 4: ESM Incompatibility in Job Workers (`require is not defined`)
- **File Path**: `backend/src/jobs/anonymisation.ts` (Line 41) & `backend/src/jobs/consistency.ts` (Line 33)
- **Line Numbers**: 41 (anonymisation.ts), 33 (consistency.ts)
- **Severity**: **High**
- **Category**: Runtime Reliability / ES Modules
- **Description**:
  Both `anonymisation.ts` and `consistency.ts` include entry point CLI checks using CommonJS syntax:
  ```typescript
  if (require.main === module) { ... }
  ```
  However, `@sophep/backend` is declared as an ES Module (`"type": "module"` in `backend/package.json`). In Node.js ES Modules, the global `require` variable is not defined. Attempting to execute or import these files in Node.js throws `ReferenceError: require is not defined`.
- **Concrete Recommended Fix**:
  Replace `require.main === module` with standard ESM URL comparison using `import.meta.url`:
  ```typescript
  import { fileURLToPath } from 'node:url'

  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    runAnonymisation().catch(console.error)
  }
  ```

---

### Issue 5: Violation of Rule R-003 (Business Logic & Direct SQL in Next.js Route Handlers)
- **File Path**: `frontend/app/api/interviews/[interviewId]/evaluations/route.ts` & `frontend/app/api/panels/[id]/snapshot/route.ts`
- **Line Numbers**: 49–62 (`evaluations/route.ts`), 19–53 (`snapshot/route.ts`)
- **Severity**: **High**
- **Category**: Architectural Compliance / Rule `R-003`
- **Description**:
  Rule `R-003` (Mandatory & Blocking) states: *"Business logic never lives in a Next.js route handler. A handler authenticates, validates input, delegates to backend/, and shapes the response — nothing more."*
  - In `evaluations/route.ts`, lines 50–61 directly construct and execute raw SQL queries (`tx<Array<...>> SELECT id, raw_score FROM fn_submit_evaluation(...)`) inside the handler instead of delegating to a backend service function.
  - In `snapshot/route.ts`, lines 19–53 execute complex multi-table SQL queries (`SELECT status...`, `SELECT count(*) FILTER...`, `SELECT u.full_name...`) directly inside the Next.js handler.
- **Concrete Recommended Fix**:
  Move database queries out of the API route handlers into dedicated service functions in `backend/src/services/` (e.g. `submitEvaluation()` in `services/interviews.ts` and `getPanelSnapshot()` in `services/queue.ts`), and export them via `backend/src/index.ts`.

---

### Issue 6: Unauthenticated Public Endpoint Lacks Rate Limiting & Idempotency Key
- **File Path**: `frontend/app/api/apply/route.ts` & `frontend/app/api/checkins/route.ts`
- **Line Numbers**: 22–84 (`apply/route.ts`), 37–117 (`checkins/route.ts`)
- **Severity**: **High**
- **Category**: Security & Rule `R-051` Compliance
- **Description**:
  1. `POST /api/apply` is a public, unauthenticated endpoint. It lacks any rate-limiting, IP throttling, or CAPTCHA check. An attacker can flood submission requests, causing excessive sequence increments, database storage bloat, and uncontrolled notification enqueueing.
  2. Rule `R-051` requires: *"Every mutating endpoint accepts an `Idempotency-Key`. Same key + same request hash replays the stored response; same key + different hash returns 409."* Neither `apply/route.ts` nor `checkins/route.ts` parses, validates, or enforces the `Idempotency-Key` header.
- **Concrete Recommended Fix**:
  - Add rate-limiting middleware or helper (e.g., using sliding window in Redis or database) to `POST /api/apply`.
  - Add an idempotency middleware/wrapper function that inspects the `Idempotency-Key` header on mutating requests (`POST`/`PUT`/`DELETE`), checks/stores key hashes, and replays cached responses on duplicate requests per `R-051`.

---

### Issue 7: Inaccurate Queue Position Calculation for Non-Waiting Entries
- **File Path**: `backend/src/services/queue.ts`
- **Line Numbers**: 211–226 (`queuePosition`)
- **Severity**: **High**
- **Category**: Domain Logic & Data Accuracy
- **Description**:
  The `queuePosition` function computes position via SQL:
  ```sql
  WITH me AS (
    SELECT track_id, priority, enqueued_at, state
      FROM queue_entries WHERE id = ${queueEntryId}::uuid
  )
  SELECT count(*) + 1 AS position
    FROM queue_entries q, me
   WHERE q.track_id = me.track_id
     AND q.state = 'waiting'
     AND me.state = 'waiting'
     AND ...
  ```
  When `queueEntryId` does not exist or its state is NOT `'waiting'` (e.g. `'called'`, `'in_interview'`, or `'completed'`), `me` has 0 rows or `me.state != 'waiting'`. In SQL, `count(*)` without a `GROUP BY` clause over an empty dataset evaluates to `0`, so `count(*) + 1` returns `1`. `queuePosition` then returns `position: 1` for non-existent or completed applicants instead of `null`.
- **Concrete Recommended Fix**:
  Check whether `me` exists and has `state = 'waiting'` before computing the count:
  ```typescript
  export async function queuePosition(tx: Tx, queueEntryId: string): Promise<number | null> {
    const [entry] = await tx<Array<{ state: string }>>`
      SELECT state FROM queue_entries WHERE id = ${queueEntryId}::uuid
    `
    if (!entry || entry.state !== 'waiting') return null

    const [row] = await tx<Array<{ position: string }>>`
      SELECT count(*) + 1 AS position
        FROM queue_entries q
       WHERE q.track_id = (SELECT track_id FROM queue_entries WHERE id = ${queueEntryId}::uuid)
         AND q.state = 'waiting'
         AND (q.priority > (SELECT priority FROM queue_entries WHERE id = ${queueEntryId}::uuid)
              OR (q.priority = (SELECT priority FROM queue_entries WHERE id = ${queueEntryId}::uuid)
                  AND q.enqueued_at < (SELECT enqueued_at FROM queue_entries WHERE id = ${queueEntryId}::uuid)))
    `
    return row ? Number(row.position) : null
  }
  ```

---

### Issue 8: Missing Revision Cause Detection for Queue Position Increases
- **File Path**: `backend/src/domain/waitEstimate.ts`
- **Line Numbers**: 159–178 (`estimateWait`)
- **Severity**: **Medium**
- **Category**: Domain Logic / Requirement Compliance (`FR-QUE-017`, `R-026`)
- **Description**:
  The `RevisionCause` type defines three causes: `'position' | 'panels' | 'service_time'`.
  However, in `estimateWait()`:
  ```typescript
  if (input.previousUpperMinutes !== undefined && upperMinutes > input.previousUpperMinutes) {
    const panelsBefore = input.previousActivePanels
    const panelsDropped = panelsBefore !== undefined && input.activePanels < panelsBefore

    if (panelsDropped) {
      estimate.revision = { cause: 'panels', message: '...' }
    } else {
      estimate.revision = { cause: 'service_time', message: 'Interviews are running a little longer than expected.' }
    }
  }
  ```
  If active panels remain unchanged and service time remains stable, but the applicant's queue position increases (for instance, due to priority bumps or recusals ahead in the queue), `estimateWait()` unconditionally attributes the cause to `'service_time'` instead of `'position'`.
- **Concrete Recommended Fix**:
  Include `previousPosition` in `WaitEstimateInput` and check if `position > previousPosition` when active panels have not dropped:
  ```typescript
  if (panelsDropped) {
    estimate.revision = { cause: 'panels', message: ... }
  } else if (input.previousPosition !== undefined && input.position > input.previousPosition) {
    estimate.revision = { cause: 'position', message: 'Priority adjustments ahead of you in queue.' }
  } else {
    estimate.revision = { cause: 'service_time', message: 'Interviews are running a little longer than expected.' }
  }
  ```

---

### Issue 9: Missing Staff Capability Check in Check-in Route
- **File Path**: `frontend/app/api/checkins/route.ts`
- **Line Numbers**: 37–40
- **Severity**: **Medium**
- **Category**: Access Control / Authorization (`FR-RBAC-004`)
- **Description**:
  In `POST /api/checkins`, the route handler calls `requireStaff(req)` to authenticate the user:
  ```typescript
  const staff = await requireStaff(req)
  if (!staff) return unauthorized()
  ```
  However, unlike `applicants/search/route.ts` (which checks `hasCapability(staff, 'checkin.perform')`), `checkins/route.ts` does NOT verify if `staff` possesses the `checkin.perform` capability. Consequently, any authenticated staff member (e.g. an interviewer without check-in privileges) can invoke `POST /api/checkins` and execute check-ins.
- **Concrete Recommended Fix**:
  Add capability check immediately after authenticating staff:
  ```typescript
  if (!(await hasCapability(staff, 'checkin.perform'))) {
    return forbidden('checkin.perform')
  }
  ```

---

### Issue 10: Non-Compliant Error Codes in API Route Validation Handlers (`R-057` Violation)
- **File Path**: `frontend/app/api/apply/route.ts` (Lines 28, 76, 98), `frontend/app/api/checkins/route.ts` (Lines 46, 56, 109), `frontend/app/api/evaluations/route.ts` (Lines 39, 79, 90)
- **Line Numbers**: Various in `apply/route.ts`, `checkins/route.ts`, `evaluations/route.ts`, `snapshot/route.ts`, `skip/route.ts`, `start/route.ts`
- **Severity**: **Medium / Technical Debt**
- **Category**: API Contract / Rule `R-057` & `IR-002` / `IR-003`
- **Description**:
  Rule `R-057` and `backend/src/domain/errors.ts` state: *"Errors return a machine-readable body: code, message, detail, retryable, using only the fourteen defined codes."*
  Across multiple API handlers (`apply`, `checkins`, `evaluations`, `snapshot`, etc.), validation errors (HTTP 400) and unhandled internal errors (HTTP 500) hardcode `{ error: { code: 'INVALID_TRANSITION', ... } }`.
  `INVALID_TRANSITION` (HTTP 409) is intended exclusively for invalid state machine transitions. Using it as a generic fallback for malformed JSON bodies, Zod validation errors, and 500 errors obscures the true nature of errors and breaks machine-readability on clients.
- **Concrete Recommended Fix**:
  Use `PREFLIGHT_FAILED` (HTTP 422) for input validation failures and map database/system errors strictly to `RmsError` definitions. Create a unified `handleApiError(err)` helper in `frontend/lib/api.ts` or `@sophep/backend`.

---

### Issue 11: Un-Indexed Trigram Search Risk in Applicant Search API
- **File Path**: `backend/src/services/registration.ts` (Lines 211–246) & `frontend/app/api/applicants/search/route.ts` (Lines 24–33)
- **Line Numbers**: 220–238 (`registration.ts`)
- **Severity**: **Medium**
- **Category**: Performance & Database Indexing
- **Description**:
  In `searchApplicants`:
  ```sql
  SELECT id, display_id, full_name, state
    FROM applicants
   WHERE cycle_id = ${cycleId}::uuid
     AND (
           display_id ILIKE ${'%' + term + '%'}
       OR  full_name  ILIKE ${'%' + term + '%'}
       OR  (${digits.length >= 4} AND display_id LIKE ${'%' + digits + '%'})
       OR  (${digits.length >= 4} AND phone_norm LIKE ${'%' + digits})
     )
  ```
  When `term` is short (e.g. 2 characters, as permitted by `search/route.ts`), `full_name ILIKE '%ab%'` requires scanning every applicant row in the cycle. Standard B-Tree indexes cannot accelerate leading wildcard searches (`'%...'`). Under peak event load with thousands of applicants, un-indexed trigram searches will cause query slowdowns and DB CPU spikes.
- **Concrete Recommended Fix**:
  Add `pg_trgm` GIN indexes on `full_name` and `display_id` in SQL migrations:
  ```sql
  CREATE INDEX idx_applicants_fullname_trgm ON applicants USING gin (full_name gin_trgm_ops);
  CREATE INDEX idx_applicants_displayid_trgm ON applicants USING gin (display_id gin_trgm_ops);
  ```

---

### Issue 12: Inconsistency Between Search Minimum Length Spec and Validation Schema
- **File Path**: `backend/src/domain/schemas.ts`
- **Line Numbers**: 86–90 (`applicantSearchSchema`)
- **Severity**: **Low / Technical Debt**
- **Category**: Documentation & Schema Alignment
- **Description**:
  The comment above `applicantSearchSchema` explicitly states:
  *"FR-CHK-009: search by any 4 consecutive digits of the identifier, the last 4 digits of the phone number, or a partial name. Four characters is the floor — fewer returns most of the cohort and is slower to scan than retyping."*
  However, `applicantSearchSchema` defines:
  ```typescript
  export const applicantSearchSchema = z.object({
    cycleId: z.string().uuid(),
    q: z.string().trim().min(2).max(120),
    limit: z.number().int().min(1).max(50).default(20),
  })
  ```
  `q` is configured with `.min(2)` rather than `.min(4)`. This discrepancy allows 2-character searches, contradicting the requirement comment.
- **Concrete Recommended Fix**:
  Update `applicantSearchSchema` to use `z.string().trim().min(4).max(120)` to match the requirement comment and prevent inefficient short queries.

---

## Audit Methodology & Execution
- **Static Code Inspection**: 100% manual review of all 18 backend source files (`backend/src/`) and 10 API route handlers (`frontend/app/api/`).
- **Rule Verification**: Checked compliance against mandatory blocking rules (`R-001` through `R-066`), errata `E1`–`E11`, and functional/non-functional requirements (`FR-*`/`NFR-*`).
- **Algorithm Audit**: Validated formulas and implementation details for Empirical-Bayes shrinkage (`scoring.ts`), Gale-Shapley allocation (`0028_allocation.sql` & `allocation.test.ts`), Ed25519 signature checks (`crypto.ts` & `verification.ts`), and EWMA wait time estimation (`waitEstimate.ts`).
