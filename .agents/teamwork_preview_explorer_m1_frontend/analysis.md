# Comprehensive Frontend Code Audit Report — SOPHEP Induction System (`frontend/`)

**Auditor**: `teamwork_preview_explorer_m1_frontend`  
**Target Package**: `frontend/` (Next.js 16 App Router, React 19, Tailwind CSS, Supabase SSR, Zod)  
**Date**: 2026-08-12  
**Audit Scope**: Architecture & App Router usage, Middleware Rate Limiting (`middleware.ts`), Zod Validation Schemas, Client State & Custom Hooks, Error Handling & Failure Boundaries, SSR Hydration Risk, Accessibility Floor Compliance (`R-060`..`R-066`), and Bundle & Rendering Performance Bottlenecks.

---

## Executive Summary

A comprehensive, read-only code audit of the frontend package (`frontend/`) was performed across all 53 source files, server components, client components, middleware, custom hooks, and API routes. The codebase demonstrates strong adherence to domain separation rules (R-003) and accessibility intentions. However, the audit identified **10 substantive issues** ranging from **Critical** security and functional flaws to **High** performance bottlenecks and accessibility non-compliance.

### Key Audit Findings Summary

| ID | Title | File Path | Line Range | Severity |
|---|---|---|---|---|
| **ISSUE-01** | Global Rate-Limit Reset Vulnerability & IP Spoofing | `frontend/middleware.ts` | 40-100 | **Critical** |
| **ISSUE-02** | TV Display Board Lacks Polling / Auto-Refresh Mechanism | `frontend/app/display/[cycleId]/page.tsx` | 18-99 | **Critical** |
| **ISSUE-03** | Unhandled Fetch Rejections & Permanently Frozen UI States | `frontend/app/(public)/apply/ApplyForm.tsx`<br/>`frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx`<br/>`frontend/app/(staff)/panel/[panelId]/PanelConsole.tsx` | 57-77<br/>88-106<br/>66-116 | **High** |
| **ISSUE-04** | Frame-by-Frame Canvas Re-allocation & Memory Leak in QR Fallback | `frontend/lib/scanner/decode.ts` | 74-103 | **High** |
| **ISSUE-05** | Server-Side Hydration Mismatch Risks in Client Components | `frontend/app/(public)/q/[token]/LiveStatus.tsx`<br/>`frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx`<br/>`frontend/app/(staff)/panel/[panelId]/PanelConsole.tsx` | 58, 225<br/>69-71<br/>51, 142 | **High** |
| **ISSUE-06** | Non-Compliance with Accessibility Rule R-060 in Liveness Indicator | `frontend/app/(public)/q/[token]/LiveStatus.tsx` | 228-247 | **High** |
| **ISSUE-07** | Non-Compliance with Accessibility Rule R-066 in Department Preference Controls | `frontend/app/(public)/apply/ApplyForm.tsx` | 167-213 | **Medium** |
| **ISSUE-08** | Complete Lack of Client-Side Zod Validation in Forms | `frontend/app/(public)/apply/ApplyForm.tsx`<br/>`frontend/app/(staff)/checkin/[stageId]/Scanner.tsx`<br/>`frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx` | 49-69<br/>62-72<br/>80-95 | **Medium** |
| **ISSUE-09** | Unchecked Non-Null Assertions on Supabase Environment Variables | `frontend/lib/auth/session.ts` | 38-39 | **Medium** |
| **ISSUE-10** | Dummy Request Instantiation Boilerplate in Staff Server Components | `frontend/app/(staff)/checkin/[stageId]/page.tsx`<br/>`frontend/app/(staff)/interview/[interviewId]/page.tsx`<br/>`frontend/app/(staff)/ops/[cycleId]/page.tsx`<br/>`frontend/app/(staff)/panel/[panelId]/page.tsx` | 23 (checkin)<br/>23 (interview)<br/>76 (ops)<br/>23 (panel) | **Technical Debt** |

---

## Detailed Audit Findings

### ISSUE-01: Global Rate-Limit Reset Vulnerability & IP Spoofing in Rate Limiter Middleware
- **Exact File Path**: `frontend/middleware.ts`
- **Line Number Range**: 40–100 (specifically lines 50–53, 58–63, and 40–48)
- **Severity**: **Critical**
- **Detailed Problem Description**:
  1. **IP Spoofing**: `clientIp(req)` extracts `req.headers.get('x-forwarded-for')?.split(',')[0]`. Any untrusted client can supply an arbitrary `X-Forwarded-For` HTTP header value (e.g. `X-Forwarded-For: 1.2.3.4`), completely forging their IP identity and bypassing rate limits per IP.
  2. **Global Rate Limit Erasure / DoS**: In `consume()`, line 62 evaluates: `if (buckets.size > MAX_BUCKETS) buckets.clear()`. An attacker sending 10,001 requests with synthetic IP headers exceeds `MAX_BUCKETS` (10,000) and triggers `buckets.clear()`, wiping out all active rate limit counters for all real users across the platform. This creates a Denial of Service and rate-limit reset vulnerability.
  3. **Route Mismatch for Token API Rate Limits**: `LIMITS` rule 1 checks `p.startsWith('/q/')`. Public status page API endpoints (`/api/q/[token]/status` and `/api/q/[token]/on-my-way`) start with `/api/q/`, not `/q/`. Consequently, API status polling bypasses rule 1 (10 req/min) and falls through to rule 3 (`/api/` with 600 req/min), failing to enforce token rate limits on API routes.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Replace `buckets.clear()` with an LRU eviction strategy or migrate to Upstash Redis / Postgres atomic counters for multi-instance correctness.
  - Trust `x-forwarded-for` only when validated by an upstream reverse proxy or platform header.
  - Update route matching in `LIMITS` to check `p.startsWith('/q/') || p.startsWith('/api/q/')`.

---

### ISSUE-02: Public TV Display Board Missing Automatic Refresh Mechanism (Stale Wall Screen)
- **Exact File Path**: `frontend/app/display/[cycleId]/page.tsx`
- **Line Number Range**: 18–99
- **Severity**: **Critical**
- **Detailed Problem Description**:
  - `DisplayBoard` is a Next.js Server Component intended to run on wall TVs in event halls. The comment on lines 18–20 notes: *"Polled rather than live: a wall screen has no user to notice a dropped socket, so a simple refresh is more reliable than a connection nobody is watching."*
  - However, **no automatic polling or page reload mechanism exists** in `DisplayBoard`. It lacks a `<meta http-equiv="refresh">` tag, client component polling wrapper (`useRealtime` or `setInterval` calling `router.refresh()`), or location reloader.
  - When opened on a TV screen during an event, the display renders once on initial load and remains permanently frozen. Called applicant IDs, active rooms, and waiting counters will never update on the wall display.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Add a client wrapper component with polling (`useRealtime` or `setInterval` executing `router.refresh()`) or include `<meta http-equiv="refresh" content="5">` in the server component head to guarantee continuous, reliable updates every 5 seconds.

---

### ISSUE-03: Unhandled Fetch Rejections & Permanently Frozen UI States in Form Submissions
- **Exact File Path**:
  - `frontend/app/(public)/apply/ApplyForm.tsx` (Lines 57–77)
  - `frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx` (Lines 88–106)
  - `frontend/app/(staff)/panel/[panelId]/PanelConsole.tsx` (Lines 66–116)
- **Line Number Range**: `ApplyForm.tsx`: 57–77; `EvaluationForm.tsx`: 88–106; `PanelConsole.tsx`: 66–116
- **Severity**: **High**
- **Detailed Problem Description**:
  - In `ApplyForm.tsx`, `EvaluationForm.tsx`, and `PanelConsole.tsx`, `fetch()` requests and `res.json()` parses are executed without `try / catch` blocks.
  - If a network error occurs (offline state, connection drop, DNS failure) or the server returns a non-JSON error response (such as a 502/504 gateway HTML error page), `fetch` or `res.json()` throws an uncaught Promise rejection.
  - In all three components, state reset calls like `setSubmitting(false)` or `setBusy(false)` are placed *after* `await fetch(...)` and `await res.json()`. When an unhandled rejection occurs, state setters are bypassed.
  - As a result, buttons ("Submitting…", "Call Next", "Start", "Mark absent") remain permanently disabled and stuck in a loading/busy state, locking out users until a full page refresh.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Wrap all `fetch` and response parsing calls in `try / catch / finally` blocks. Place `setSubmitting(false)` and `setBusy(false)` inside `finally` blocks to guarantee UI state recovery, and present actionable error notifications on failure.

---

### ISSUE-04: Frame-by-Frame Canvas Re-allocation & Memory Leak in QR Scanner Fallback
- **Exact File Path**: `frontend/lib/scanner/decode.ts`
- **Line Number Range**: 74–103
- **Severity**: **High**
- **Detailed Problem Description**:
  - `useScanner` executes `requestAnimationFrame` at 60 frames per second. When using the WebAssembly QR decoder fallback (`createWasmDecoder`), `decode()` is invoked 60 times per second.
  - Inside `createWasmDecoder()` lines 86–88: `canvas.width = width` and `canvas.height = height` are reassigned on every frame, resetting the 2D canvas context continuously.
  - Furthermore, `ctx.getImageData(0, 0, width, height)` is called on every frame. For a 1280×720 camera stream, `getImageData` allocates a new 3.68 MB `Uint8ClampedArray` per frame. At 60 fps, this generates **~220 MB of heap memory allocations per second**.
  - This causes severe main-thread Garbage Collection (GC) pauses, camera stutter, device overheating, and rapid battery drain on mobile phones used by volunteers.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Only update `canvas.width` and `canvas.height` when video dimensions change.
  - Throttle decoding frequency (e.g. scan every 100–150 ms rather than every 16 ms rAF frame) and reuse offscreen buffers to eliminate per-frame GC allocations.

---

### ISSUE-05: Server-Side Hydration Mismatch Risks in Client Components
- **Exact File Path**:
  - `frontend/app/(public)/q/[token]/LiveStatus.tsx` (Lines 58, 225)
  - `frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx` (Lines 69–71)
  - `frontend/app/(staff)/panel/[panelId]/PanelConsole.tsx` (Lines 51, 142)
- **Line Number Range**: `LiveStatus.tsx`: 58, 225; `EvaluationForm.tsx`: 69–71; `PanelConsole.tsx`: 51, 142
- **Severity**: **High**
- **Detailed Problem Description**:
  - Next.js 16 App Router renders Client Components on the server during SSR before client-side hydration.
  - In `LiveStatus.tsx` line 58: `const [updatedAt, setUpdatedAt] = useState(() => new Date())` and line 225: `updatedAt.toLocaleTimeString('en-GB', ...)`. `new Date()` is evaluated during server SSR using server system time and timezone. During client hydration, the browser evaluates locale formatting using the client's local timezone. If server and client time or timezones differ, React throws a Hydration Mismatch error.
  - In `EvaluationForm.tsx` line 69: `useState(() => Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000))` computes `Date.now()` on the server during SSR, causing initial state divergence on mount.
  - In `PanelConsole.tsx` line 51: `const [now, setNow] = useState(() => Date.now())` evaluates server timestamp during SSR vs client timestamp during hydration.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Defer time calculations or formatted date/time string rendering until after mount using a `mounted` state in `useEffect`, or add `suppressHydrationWarning` to date/time display elements.

---

### ISSUE-06: Non-Compliance with Accessibility Rule R-060 in Liveness Indicator
- **Exact File Path**: `frontend/app/(public)/q/[token]/LiveStatus.tsx`
- **Line Number Range**: 228–247
- **Severity**: **High**
- **Detailed Problem Description**:
  - Rule **`R-060`** states: *"Colour is **never** the sole means of conveying state. Every state carries a distinct icon **and** a distinct shape in addition to its colour (NFR-A11Y-002)."*
  - In `Liveness` (`LiveStatus.tsx` lines 230–239), connection status (live, reconnecting, offline) is visually indicated using a colored circle (`h-2 w-2 rounded-full` with `bg-state-complete` [green], `bg-state-called` [amber], or `bg-state-blocked` [red]).
  - The circle element carries `aria-hidden="true"`, and its visual shape remains an identical circle across all three states. There is no distinct icon or shape differentiating live vs reconnecting vs offline states. This violates blocking rule **`R-060`** for users with color-vision deficiencies.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Refactor `Liveness` to include distinct icons and shapes (e.g. pulsing dot for live, solid bar/warning triangle for reconnecting, diagonal stripes/cross for offline) alongside colors, maintaining consistency with `StateBadge`.

---

### ISSUE-07: Non-Compliance with Accessibility Rule R-066 in Department Preference Controls
- **Exact File Path**: `frontend/app/(public)/apply/ApplyForm.tsx`
- **Line Number Range**: 167–213
- **Severity**: **Medium**
- **Detailed Problem Description**:
  - Rule **`R-066`** and WCAG 2.1 AA require programmatically associated labels and state explanations for form controls.
  - In `ApplyForm.tsx` (lines 187–209), department preference choices are rendered as `<button type="button" aria-pressed={selected}>`.
  - When selected, the preference rank number (1, 2, 3) is rendered in a separate `<span>` (`{rank + 1}`), but the button has no `aria-label` or `aria-describedby` announcing the preference rank to screen reader users. Screen readers announce "Department Name, button, pressed", omitting whether it is 1st, 2nd, or 3rd preference.
  - When disabled (`full`), the text "Limit reached" is rendered, but disabled buttons lack `aria-describedby` referencing the restriction explanation.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Add explicit `aria-label` attributes to preference buttons (e.g. `aria-label="${d.name}, preference rank ${rank + 1}"`) and link disabled states via `aria-describedby`.

---

### ISSUE-08: Complete Lack of Client-Side Zod Validation in Forms
- **Exact File Path**:
  - `frontend/app/(public)/apply/ApplyForm.tsx` (Lines 49–69)
  - `frontend/app/(staff)/checkin/[stageId]/Scanner.tsx` (Lines 62–72)
  - `frontend/app/(staff)/interview/[interviewId]/EvaluationForm.tsx` (Lines 80–95)
- **Line Number Range**: `ApplyForm.tsx`: 49–69; `Scanner.tsx`: 62–72; `EvaluationForm.tsx`: 80–95
- **Severity**: **Medium**
- **Detailed Problem Description**:
  - `package.json` specifies `zod` as a core dependency, and backend schemas are defined in `@sophep/backend`.
  - However, frontend forms (`ApplyForm.tsx`, `Scanner.tsx`, `EvaluationForm.tsx`) perform zero client-side Zod validation before submitting HTTP requests to API routes (`/api/apply`, `/api/checkins`, `/api/interviews/...`).
  - Forms submit raw values directly over the network and rely entirely on API 400 responses to populate error states. On high-latency mobile networks, this causes unnecessary roundtrips for basic validation failures (such as malformed emails, invalid phone formats, or unselected preferences).
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Export shared Zod schemas from domain modules and run `schema.safeParse()` inside client form submit handlers prior to `fetch()` calls to provide immediate inline validation.

---

### ISSUE-09: Unchecked Non-Null Assertions on Supabase Environment Variables
- **Exact File Path**: `frontend/lib/auth/session.ts`
- **Line Number Range**: 38–39
- **Severity**: **Medium**
- **Detailed Problem Description**:
  - In `lib/auth/session.ts` lines 38–39:
    ```ts
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    ```
  - Non-null assertions (`!`) are used when invoking `createServerClient`. If environment variables `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing or misconfigured in a deployment environment, `createServerClient` receives `undefined`, leading to runtime crashes (`TypeError: Invalid URL`) during SSR requests.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Add explicit environment variable checks with clear error messages before instantiating Supabase clients.

---

### ISSUE-10: Dummy Request Instantiation Boilerplate in Staff Server Components
- **Exact File Path**:
  - `frontend/app/(staff)/checkin/[stageId]/page.tsx` (Line 23)
  - `frontend/app/(staff)/interview/[interviewId]/page.tsx` (Line 23)
  - `frontend/app/(staff)/ops/[cycleId]/page.tsx` (Line 76)
  - `frontend/app/(staff)/panel/[panelId]/page.tsx` (Line 23)
- **Line Number Range**: Line 23 in checkin, interview, panel pages; Line 76 in ops page
- **Severity**: **Technical Debt**
- **Detailed Problem Description**:
  - Across all staff Server Component pages, `requireStaff` is called with a dummy request instance:
    `const staff = await requireStaff(new Request('http://internal/...'))`
  - In `lib/auth/session.ts`, the parameter `_req: Request` in `requireStaff(_req: Request)` is completely unused.
  - Constructing dummy `new Request(...)` objects on every Server Component page request is redundant boilerplate that creates technical debt and obscures session resolution logic.
- **Concrete Recommended Fix / Refactoring Strategy**:
  - Refactor `requireStaff` to make the `Request` parameter optional or provide a dedicated `getStaffSession()` helper function for Server Components.

---

## Verification & Audit Methodology

1. **Static Analysis & File Inspection**: Inspected all 53 files in `frontend/` using file viewing and pattern search tools.
2. **Requirements Mapping**: Evaluated accessibility floor rules (`R-060`..`R-066`), data boundary rules (R-003, R-022, R-026, R-027, R-058), and NFRs (NFR-SEC-005, NFR-A11Y-001..008, NFR-PERF-001..007).
3. **Synthesis & Evidence Chains**: All findings cite exact file paths, line ranges, root causes, user impacts, and actionable refactoring solutions.
