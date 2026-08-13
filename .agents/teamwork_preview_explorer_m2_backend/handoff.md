# Handoff Report — Backend & API Code Audit (`m2_backend`)

## 1. Observation
We conducted a comprehensive, read-only audit of all backend TypeScript source files (`backend/src/`) and API route handlers (`frontend/app/api/`). Key direct observations include:

1. **`frontend/app/api/q/[token]/on-my-way/route.ts:24-40`**:
   - `withContext({}, async (tx) => { ... })` sets `app.applicant_id` to `''`. Under `0008_rls.sql`, RLS on `queue_entries` fails closed when `app.applicant_id` is empty, causing `SELECT id FROM queue_entries WHERE applicant_id = ${applicantId}` to return 0 rows. Line 37 throws `RmsError('INVALID_TRANSITION', 'You have not been called yet')` on every call.
2. **`backend/src/domain/crypto.ts:130-136, 151-160`**:
   - `privateKeyObject` exports JWK `{ kty: 'OKP', crv: 'Ed25519', d: rawSeed, x: '' }`. Passing `x: ''` violates RFC 8037 and causes Node's `createPrivateKey` to throw `TypeError [ERR_CRYPTO_INVALID_JWK]: Invalid JWK` during `signToken`.
3. **`backend/src/domain/scoring.ts:231-248`**:
   - `reviewBand` checks `if (rank > capacity * config.discussMultiplier) return 'below'` (line 240) BEFORE `if (flags.length > 0) return 'discuss'` (line 244). `FR-SCR-012` requires flagged applicants to be in `'discuss'` band regardless of rank.
4. **`backend/src/jobs/anonymisation.ts:41` & `backend/src/jobs/consistency.ts:33`**:
   - Files contain `if (require.main === module)`. `backend/package.json` specifies `"type": "module"`. Executing these scripts in Node.js throws `ReferenceError: require is not defined`.
5. **`frontend/app/api/interviews/[interviewId]/evaluations/route.ts:49-62` & `frontend/app/api/panels/[id]/snapshot/route.ts:19-53`**:
   - Route handlers contain inline SQL query execution (`tx<Array<...>> SELECT ...`) instead of delegating to backend service functions, violating Rule `R-003`.
6. **`frontend/app/api/apply/route.ts` & `frontend/app/api/checkins/route.ts`**:
   - Public route `POST /api/apply` has no rate limiting or IP throttling. Mutating routes fail to inspect or enforce `Idempotency-Key` headers (`R-051`).
7. **`backend/src/services/queue.ts:211-226`**:
   - `queuePosition` executes `WITH me AS (...) SELECT count(*) + 1 FROM queue_entries q, me ...`. When `queueEntryId` does not exist or is not in `'waiting'` state, `count(*) + 1` evaluates to `1` instead of returning `null`.
8. **`frontend/app/api/checkins/route.ts:37-40`**:
   - Handler authenticates staff via `requireStaff(req)` but omits capability check for `checkin.perform`.

---

## 2. Logic Chain
1. **Observation**: `on-my-way/route.ts` calls `withContext({}, ...)` without binding an `applicantId`.
   **Reasoning**: RLS policies enforce `applicant_id = fn_current_applicant_id()`. An empty context returns NULL for `fn_current_applicant_id()`.
   **Conclusion**: Any query against `queue_entries` under empty context returns 0 rows, making the endpoint throw `INVALID_TRANSITION` on every valid request.

2. **Observation**: `crypto.ts` passes `x: ''` into Node's `createPrivateKey({ format: 'jwk', ... })`.
   **Reasoning**: Node's JWK parser strictly validates RFC 8037 parameters for Ed25519 (`OKP`). `x: ''` fails JWK base64url validation.
   **Conclusion**: `signToken()` crashes at runtime when called to issue signed QR codes.

3. **Observation**: `scoring.ts` evaluates `rank > 2C` before checking `flags.length > 0`.
   **Reasoning**: An applicant with a flag like `HIGH_DISAGREEMENT` and a rank of `2.1C` hits line 240 first and returns `'below'`.
   **Conclusion**: `FR-SCR-012` ("Any flagged applicant shall be forced into discussion band irrespective of rank") is violated.

4. **Observation**: Route handlers in `evaluations/route.ts` and `snapshot/route.ts` execute raw SQL.
   **Reasoning**: Rule `R-003` mandates thin route handlers that only authenticate, validate, delegate to `backend/src/services`, and shape response.
   **Conclusion**: `R-003` is violated, weakening separation of concerns and testability.

---

## 3. Caveats
- SQL stored procedures (`0001` through `0028_allocation.sql`) were audited via domain TypeScript calls and migration definitions; direct database engine execution testing was omitted as this is a read-only audit.
- External email delivery (Resend adapter) is currently stubbed via `mockAdapter` as documented in `notifications.ts`.

---

## 4. Conclusion
The backend architecture is solidly structured with well-designed domain modules and RLS security principles. However, 12 substantive issues were identified, including 1 Critical bug (RLS failure breaking the "On My Way" endpoint), 5 High severity issues (Ed25519 JWK signing crash, scoring algorithm review band logic order, ESM `require` crash in job workers, R-003 thin controller violations, and rate-limiting/idempotency gaps), 4 Medium severity issues, and 2 Technical Debt items. Remediation of these issues is required before production deployment.

---

## 5. Verification Method
1. **Audit Report Verification**: Inspect `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_m2_backend\analysis.md`.
2. **TypeScript Typecheck**: Run `npm --prefix backend run typecheck` to verify domain type definitions.
3. **Unit & Integration Tests**: Run `npm --prefix backend test` and `npm --prefix frontend test` to execute test suites against domain logic, scoring formulas, and allocation golden datasets.
