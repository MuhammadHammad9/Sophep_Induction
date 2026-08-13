# Handoff Report — Frontend Package Code Audit (`m1_frontend`)

**Agent**: `teamwork_preview_explorer_m1_frontend`  
**Working Directory**: `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_m1_frontend`  
**Handoff Type**: Hard Handoff (Task Complete)

---

## 1. Observation

Direct observations from examining the 53 files in `frontend/` and requirements in `rules.md`:

1. **`frontend/middleware.ts` (lines 40–100)**:
   - IP extraction at line 51: `const forwarded = req.headers.get('x-forwarded-for')` followed by `forwarded?.split(',')[0]?.trim()`.
   - Bucket eviction at line 62: `if (buckets.size > MAX_BUCKETS) buckets.clear()`.
   - Route rule 1 at line 42: `{ test: (p) => p.startsWith('/q/'), key: 'token', limit: { windowMs: 60_000, max: 10 } }`.
2. **`frontend/app/display/[cycleId]/page.tsx` (lines 18–99)**:
   - Comment on line 18 states "Polled rather than live", but the component contains no polling logic, no `<meta http-equiv="refresh">`, no `useEffect`, and no `router.refresh()` interval.
3. **`frontend/app/(public)/apply/ApplyForm.tsx` (lines 57–77)**, **`frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx` (lines 88–106)**, and **`frontend/app/(staff)/panel/[panelId]/PanelConsole.tsx` (lines 66–116)**:
   - Async `fetch` and `res.json()` calls have no `try / catch` blocks. `setSubmitting(false)` / `setBusy(false)` calls are placed after `await fetch` / `await res.json()`.
4. **`frontend/lib/scanner/decode.ts` (lines 74–103)**:
   - Line 86–88 in `createWasmDecoder`: `canvas.width = width` and `canvas.height = height` are assigned on every frame inside a 60 fps `requestAnimationFrame` loop. Line 91 executes `ctx.getImageData(0, 0, width, height)` on every 16ms frame, allocating a new 3.68 MB `Uint8ClampedArray` per frame (~220 MB/s).
5. **`frontend/app/(public)/q/[token]/LiveStatus.tsx` (lines 58, 225)**:
   - Line 58: `const [updatedAt, setUpdatedAt] = useState(() => new Date())`.
   - Line 225: `updatedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })`.
6. **`frontend/app/(public)/q/[token]/LiveStatus.tsx` (lines 228–247)**:
   - `Liveness` indicator uses a circle (`h-2 w-2 rounded-full`) with `aria-hidden="true"` and relies on color (`bg-state-complete`, `bg-state-called`, `bg-state-blocked`) without distinct icons or shapes across live, reconnecting, and offline states.
7. **`frontend/app/(public)/apply/ApplyForm.tsx` (lines 167–213)**:
   - Department preference buttons render `{rank + 1}` inside a separate `<span>` without `aria-label` or `aria-describedby` conveying preference rank to screen readers.
8. **`frontend/app/(public)/apply/ApplyForm.tsx`**, **`frontend/app/(staff)/checkin/[stageId]/Scanner.tsx`**, and **`frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx`**:
   - Zero client-side Zod validation is performed prior to sending POST request bodies to API routes.
9. **`frontend/lib/auth/session.ts` (lines 38–39)**:
   - `process.env['NEXT_PUBLIC_SUPABASE_URL']!` and `process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!` use non-null assertions without fallback or validation.
10. **`frontend/app/(staff)/checkin/[stageId]/page.tsx` (line 23)**, **`frontend/app/(staff)/interview/[interviewId]/page.tsx` (line 23)**, **`frontend/app/(staff)/ops/[cycleId]/page.tsx` (line 76)**, **`frontend/app/(staff)/panel/[panelId]/page.tsx` (line 23)**:
    - Server components invoke `requireStaff(new Request('http://internal/...'))` with a dummy Request object while `_req` is unused in `lib/auth/session.ts`.

---

## 2. Logic Chain

1. **Rate Limiter Vulnerability (Observation #1)**:
   - `clientIp` reads unvalidated `x-forwarded-for` headers, allowing clients to spoof IP addresses.
   - When `buckets.size > 10,000`, `buckets.clear()` wipes all bucket entries. An attacker sending 10,001 requests with unique `x-forwarded-for` values resets rate limits globally.
   - Route rule `/q/` does not match `/api/q/...`, allowing status polling to fall through to 600 req/min limits.
   - **Conclusion**: Critical security and rate-limit bypass risk.

2. **Stale TV Display Board (Observation #2)**:
   - The component claims to be polled rather than live, but contains no polling logic or meta refresh.
   - Renders once during SSR and never re-renders.
   - **Conclusion**: Critical functional defect causing stale data on wall screens.

3. **Unhandled Promise Rejections in Forms (Observation #3)**:
   - When network errors occur or non-JSON HTTP responses are returned, `fetch` or `res.json()` throws uncaught errors.
   - State setters resetting `submitting`/`busy` flags are skipped because they follow the failing `await`.
   - **Conclusion**: High severity UX flaw causing permanently frozen submit buttons.

4. **Garbage Collection & Frame Drops in QR Fallback (Observation #4)**:
   - Reassigning `canvas.width`/`height` on every 16ms frame resets the 2D canvas context continuously.
   - Calling `getImageData` 60 times per second generates ~220 MB/s of temporary typed array allocations.
   - **Conclusion**: High severity rendering performance bottleneck and battery drain.

5. **Hydration Mismatch Risk (Observation #5)**:
   - `useState(() => new Date())` and `toLocaleTimeString` evaluate server time and timezone during SSR.
   - Client hydration evaluates client local time/timezone, causing HTML text mismatch errors in React 19.
   - **Conclusion**: High severity SSR hydration risk.

6. **Accessibility Non-Compliance R-060 (Observation #6)**:
   - `R-060` requires a distinct icon AND shape for every state alongside color.
   - `Liveness` uses identical `h-2 w-2 rounded-full` circles for live, reconnecting, and offline states.
   - **Conclusion**: High severity non-compliance with blocking rule `R-060`.

7. **Accessibility Non-Compliance R-066 & Zod Validation (Observations #7 & #8)**:
   - Preference buttons lack explicit `aria-label` or `aria-describedby` for rank position.
   - Forms skip client-side Zod validation, forcing unnecessary API roundtrips.
   - **Conclusion**: Medium severity accessibility and validation gaps.

8. **Env Var Handling & Boilerplate (Observations #9 & #10)**:
   - Non-null assertions on env vars can crash SSR if missing.
   - Dummy `new Request('http://internal/...')` calls create technical debt.
   - **Conclusion**: Medium severity resilience gap and Technical Debt.

---

## 3. Caveats

- **No Code Modifications**: As mandated by the audit instructions, zero files in the codebase were modified. All findings are purely analytical.
- **Backend Dependency Assumptions**: Evaluated frontend route handlers against assumed `@sophep/backend` exports. Backend function internal behavior was not modified.
- **Browser Execution Environment**: Static code analysis was performed; live browser runtime rendering was not executed during this read-only audit.

---

## 4. Conclusion

The frontend package (`frontend/`) has a solid structural architecture aligned with Next.js 16 App Router conventions and domain separation (R-003). However, **10 substantive issues** were identified:
- **2 Critical**: In-memory rate limiter reset DoS (`middleware.ts`) and missing TV display auto-refresh (`DisplayBoard`).
- **4 High**: Uncaught fetch rejections in form submit handlers, 220 MB/s heap allocation memory leak in QR WASM fallback, SSR hydration mismatches in time displays, and non-compliance with accessibility rule `R-060` in `Liveness`.
- **3 Medium**: Non-compliance with accessibility rule `R-066` in preference buttons, missing client-side Zod validation, and non-null env var assertions.
- **1 Technical Debt**: Dummy request instantiation in staff page server components.

Detailed problem descriptions and concrete refactoring strategies for all 10 issues are documented in `analysis.md`.

---

## 5. Verification Method

To independently verify the observations and findings:

1. **Inspect Analysis Report**:
   - View `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_m1_frontend\analysis.md`.

2. **Verify Code Locations**:
   - `frontend/middleware.ts` (lines 40–100) — verify bucket reset logic, `x-forwarded-for` parsing, and route matcher limits.
   - `frontend/app/display/[cycleId]/page.tsx` (lines 18–99) — verify absence of polling/refresh code.
   - `frontend/app/(public)/apply/ApplyForm.tsx` (lines 57–77, 167–213) — verify lack of `try/catch` around `fetch` and missing `aria-label` on preference buttons.
   - `frontend/lib/scanner/decode.ts` (lines 74–103) — verify canvas resizing and `getImageData` inside `createWasmDecoder`.
   - `frontend/app/(public)/q/[token]/LiveStatus.tsx` (lines 58, 228–247) — verify `useState(() => new Date())` and single-shape `Liveness` indicator.

3. **Project Verification Commands**:
   - Run typecheck in `frontend/`: `npm --prefix frontend run typecheck`
   - Run linting in `frontend/`: `npm --prefix frontend run lint`
   - Run unit tests in `frontend/`: `npm --prefix frontend run test`
