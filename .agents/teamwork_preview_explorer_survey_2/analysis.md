# Comprehensive Codebase Survey & Architectural Map — SOPHEP RMS

**Date**: 2026-08-12  
**Explorer Agent**: `teamwork_preview_explorer_survey_2`  
**Target Repository**: `SOPHEP RMS` (`sophep-rms`)  
**Mode**: Read-only Architecture & Codebase Enumeration  

---

## 1. Executive Summary & Stack Architecture

SOPHEP RMS is an event-critical, cycle-based recruitment management system designed for student society inductions (handling 100–1,000 applicants, 6–20 volunteers, 8–30 interviewers over noisy hall environments and unreliable campus Wi-Fi).

### Monorepo Structure (npm Workspaces)
The repository is structured as an npm workspaces monorepo:
- **`frontend/` (`@sophep/frontend`)**: Next.js 16 (App Router), React 19, TypeScript 5.7, Tailwind CSS 3.4, PWA Service Worker (`public/sw.js`), IndexedDB (`idb` 8.0), ZXing WASM QR scanner (`zxing-wasm`).
- **`backend/` (`@sophep/backend`)**: Pure TypeScript domain logic, Postgres database services via `postgres.js` (with transaction-bound RLS `withContext`), Supabase SQL migrations (33 versioned migrations), noble-ed25519 / noble-hashes cryptography, Zod validation schemas, Vitest test suite.
- **`Documents/` & `Flows/`**: Specifications, TRD (238 numbered requirements), Architecture and UX spec, flow diagrams (including annotated v2 boards).

### Core Architectural Invariants (Enforced at Database & Code Layer)
1. **Cycle Scoping**: Every domain table except `societies` and `users` carries `cycle_id`.
2. **Append-Only Audit**: `audit_events` table revokes `UPDATE` and `DELETE`. All state transitions write an audit row inside the same transaction (`No audit, no commit`).
3. **Single-Writer State Ownership**: `applicants.state` is a projection, updated only via Postgres stored functions (`fn_check_in`, `fn_queue_transition`, `fn_interview_transition`, `fn_apply_decision`).
4. **`FOR UPDATE SKIP LOCKED` Queue Claim**: Prevents double-assignment across concurrent panels; recusals filtered via `NOT EXISTS` (`NOT IN` is strictly forbidden).
5. **Fail-Closed Transaction-Bound RLS**: Context bound via `set_config(..., true)` inside transactions after setting local role to `rms_app` (`SET LOCAL ROLE rms_app`). Unset context yields zero rows.

---

## 2. Complete File Inventory

Below is the complete enumeration of source code, configuration, database, test, and reference files across the repository.

```
c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction
├── .env.example                               # Environment variable templates and secrets documentation
├── CLAUDE.md                                  # Developer context, precedence order, design principles, command reference
├── rules.md                                   # Mandatory blocking architectural and code constraints
├── ROADMAP.md                                 # 6-phase exit criteria and status tracker
├── PHASE-4-PLAN.md                            # Phase 4 detailed execution plan
├── README.md                                  # High-level overview
├── package.json                               # Workspace root package manifest
├── package-lock.json                          # Lockfile
│
├── backend/                                   # Domain logic, services, migrations, tests
│   ├── package.json                           # @sophep/backend package configuration
│   ├── scripts/
│   │   ├── migrate.mjs                        # Migration application script
│   │   ├── reset-test-db.mjs                  # Test database reset runner
│   │   ├── seed.mjs                           # Seed data generator for demo cycle
│   │   └── measure-latency.mjs                # Latency benchmarks
│   ├── src/
│   │   ├── index.ts                           # Re-exports domain and service modules
│   │   ├── domain/
│   │   │   ├── crypto.ts                      # Ed25519 keypair generation, AES-256-GCM secret encryption, QR parsing
│   │   │   ├── cv.ts                          # Magic-number validation for CV PDF uploads
│   │   │   ├── errors.ts                      # Standardized RmsError class and Postgres error mapper
│   │   │   ├── identity.ts                    # 128-bit access token generation and SHA-256 hashing
│   │   │   ├── normalisation.ts               # Email, phone, roll number, and string normalisers
│   │   │   ├── schemas.ts                     # Zod input validation schemas for registration, search, screening
│   │   │   ├── scoring.ts                     # Empirical-Bayes shrinkage score calculation, flags, review bands
│   │   │   ├── totp.ts                        # Staff 2FA TOTP secret & QR generation
│   │   │   ├── verification.ts                # Offline QR verification helper and token hash formatting
│   │   │   └── waitEstimate.ts                # EWMA wait time calculation and capacity modeling
│   │   ├── jobs/
│   │   │   ├── anonymisation.ts               # PII anonymisation background job
│   │   │   └── consistency.ts                 # Database projection consistency audit job
│   │   └── services/
│   │       ├── checkin.ts                     # Keypair generation, roster bundle assembly, token resolution, check-in
│   │       ├── db.ts                          # Postgres client, transaction-bound RLS withContext wrapper
│   │       ├── notifications.ts               # Email template rendering, notification queueing, mock email adapter
│   │       ├── queue.ts                       # Call Next, grace expiry, priority modification, wait estimation
│   │       └── registration.ts                # Duplicate checking, applicant registration, applicant search, screening
│   ├── supabase/migrations/
│   │   ├── 0001_extensions_and_normalisation.sql  # Extensions (citext, pg_trgm) & immutable normaliser functions
│   │   ├── 0002_enums.sql                         # Database enum types (applicant_state, registration_channel, etc.)
│   │   ├── 0003_core_tables.sql                   # Core organizational tables (societies, cycles, stages, rooms, etc.)
│   │   ├── 0004_applicants.sql                    # Applicants, preferences, access tokens, audit events
│   │   ├── 0005_audit_and_infra.sql               # fn_audit, append-only trigger, per-cycle sequence counter
│   │   ├── 0006_state_ownership.sql               # Single-writer state projections & transition stored procedures
│   │   ├── 0007_registration.sql                  # fn_find_duplicates, fn_register_applicant, fn_issue_token
│   │   ├── 0008_rls.sql                           # Initial RLS security policies & context functions
│   │   ├── 0009_cycle_config_defaults.sql         # Default configuration JSON for cycles
│   │   ├── 0010_app_role.sql                      # rms_app role definition with NOBYPASSRLS
│   │   ├── 0011_public_access.sql                 # fn_resolve_token_for_checkin, fn_roster_bundle
│   │   ├── 0012_harden_context_accessors.sql      # Fail-closed context accessors returning NULL on malformed input
│   │   ├── 0013_fix_registration_deadlock.sql     # Fix registration concurrency lock upgrade deadlock
│   │   ├── 0014_notification_enqueue.sql          # Outbound notifications queue table & fn_enqueue_notification
│   │   ├── 0015_event_schema.sql                  # Operational event schema (queue_entries, panels, interviews, etc.)
│   │   ├── 0016_queue_engine.sql                  # Queue engine (fn_claim_next with FOR UPDATE SKIP LOCKED)
│   │   ├── 0017_event_rls.sql                     # Event RLS policies and blind evaluation enforcement
│   │   ├── 0018_checkin.sql                       # Check-in logic and queue placement stored procedures
│   │   ├── 0019_fix_checkin_ambiguity.sql         # Overloaded function signature resolution
│   │   ├── 0020_display_board.sql                 # Public display board materialized view & functions
│   │   ├── 0021_applicant_status.sql              # Live status accessors and security checks
│   │   ├── 0022_register_and_checkin.sql          # Fast-path desk walk-in registration + check-in procedure
│   │   ├── 0023_rubrics.sql                       # Interview rubrics & rubric criteria schema
│   │   ├── 0024_evaluations.sql                   # Interview evaluation recording & score validations
│   │   ├── 0025_stage_close_and_heartbeat.sql     # Panel heartbeat and stage close gate function
│   │   ├── 0026_waiver_requires_actor.sql         # Waiver audit enforcement requiring actor identification
│   │   ├── 0027_scoring_persistence.sql           # Empirical-Bayes score adjustment storage tables & procedures
│   │   ├── 0028_allocation.sql                    # Deterministic allocation (Deferred Acceptance) & decision tables
│   │   ├── 0029_checksum_without_pgcrypto.sql     # Pure PL/pgSQL digest calculation
│   │   ├── 0030_bulk_reconcile.sql                # Offline check-in bulk reconciliation
│   │   ├── 0030_lock_offers_cascade.sql           # Dual-control locking & offer expiry cascade
│   │   ├── 0031_consistency_and_anonymisation.sql  # Database sanity checker & PII anonymisation routines
│   │   └── 0031_policy_subquery_visibility.sql    # RLS subquery performance optimization
│   └── tests/
│       ├── helpers.ts                             # Database connection and test fixture helpers
│       ├── concurrency/                           # Heavy parallel actor stress tests
│       │   ├── checkin.test.ts
│       │   ├── queue-claim.test.ts
│       │   └── registration.test.ts
│       ├── golden/                                # End-to-end golden verification tests
│       │   ├── allocation.test.ts
│       │   ├── lock-and-offers.test.ts
│       │   └── scoring.test.ts
│       ├── rls/                                   # Row-Level Security boundary assertion tests
│       │   ├── applicant-status.test.ts
│       │   ├── evaluation.test.ts
│       │   ├── fail-closed.test.ts
│       │   ├── notifications.test.ts
│       │   ├── public-access.test.ts
│       │   └── state-ownership.test.ts
│       └── unit/                                  # Pure domain unit tests
│           ├── crypto.test.ts
│           ├── cv.test.ts
│           ├── identity.test.ts
│           ├── normalisation.test.ts
│           ├── totp.test.ts
│           └── wait-estimate.test.ts
│
├── frontend/                                  # Next.js App Router application
│   ├── package.json                           # @sophep/frontend package manifest
│   ├── next.config.ts                         # Next.js configuration
│   ├── postcss.config.mjs                     # PostCSS config
│   ├── tailwind.config.ts                     # Tailwind CSS design system tokens and state colors
│   ├── tsconfig.json                          # TypeScript configuration
│   ├── middleware.ts                          # Rate limiting & security HTTP headers middleware
│   ├── app/
│   │   ├── globals.css                        # Tailwind global styles
│   │   ├── layout.tsx                         # Root HTML layout
│   │   ├── page.tsx                           # Homepage / Landing page
│   │   ├── (public)/                          # Public routes (applicant-facing)
│   │   │   ├── apply/
│   │   │   │   ├── page.tsx                   # Public application page wrapper
│   │   │   │   └── ApplyForm.tsx              # Multi-channel applicant registration form
│   │   │   └── q/[token]/
│   │   │       ├── page.tsx                   # Live applicant status page
│   │   │       └── LiveStatus.tsx             # Realtime queue status & QR display
│   │   ├── (staff)/                           # Staff management routes
│   │   │   ├── checkin/[stageId]/
│   │   │   │   ├── page.tsx                   # Desk check-in page
│   │   │   │   └── Scanner.tsx                # ZXing camera scanner & manual search UI
│   │   │   ├── dev/notifications/
│   │   │   │   └── page.tsx                   # Dev preview of queued mock notifications
│   │   │   ├── interview/[interviewId]/
│   │   │   │   ├── page.tsx                   # Panel interview scoring page
│   │   │   │   └── EvaluationForm.tsx         # Rubric scoring & recommendation form
│   │   │   ├── ops/[cycleId]/
│   │   │   │   └── page.tsx                   # Operations dashboard (live metrics, stage gates)
│   │   │   └── panel/[panelId]/
│   │   │       ├── page.tsx                   # Panel call-next console page
│   │   │       └── PanelConsole.tsx           # Call Next button, active candidate view, grace timer
│   │   ├── api/                               # Next.js API Route Handlers (Thin Wrappers)
│   │   │   ├── apply/route.ts                 # POST public application
│   │   │   ├── applicants/search/route.ts     # GET applicant search for check-in desks
│   │   │   ├── checkins/route.ts              # POST applicant check-in
│   │   │   ├── interviews/[interviewId]/evaluations/route.ts # POST interview evaluation
│   │   │   ├── panels/[id]/call-next/route.ts # POST claim next applicant in queue
│   │   │   ├── panels/[id]/snapshot/route.ts  # GET panel state snapshot
│   │   │   ├── q/[token]/on-my-way/route.ts    # POST applicant "on my way" response
│   │   │   ├── q/[token]/status/route.ts      # GET applicant live status JSON
│   │   │   ├── queue/[entryId]/skip/route.ts  # POST skip candidate in queue
│   │   │   └── queue/[entryId]/start/route.ts # POST transition candidate into interview
│   │   └── display/[cycleId]/
│   │       └── page.tsx                       # Public hall display board (Privacy-safe display)
│   ├── components/
│   │   ├── scanner/
│   │   │   └── OfflineBanner.tsx              # Offline state & sync indicator banner
│   │   └── state/
│   │       └── StateBadge.tsx                 # Accessible badge (Icon + Shape + Color for WCAG 2.1 AA)
│   ├── lib/
│   │   ├── auth/session.ts                    # Staff session & cookie handling
│   │   ├── offline/
│   │   │   ├── indexeddb.ts                   # IndexedDB storage for offline roster & queue actions
│   │   │   ├── sync.ts                        # Background sync worker & queue replay
│   │   │   ├── useOfflineSync.ts              # React hook for offline sync status
│   │   │   └── verifyQR.ts                    # Client-side 3-layer QR verification logic
│   │   ├── realtime/
│   │   │   ├── channels.ts                    # Supabase Realtime channel subscriptions
│   │   │   └── degradation.ts                 # Degradation ladder & WebSocket fallback logic
│   │   ├── scanner/
│   │   │   ├── decode.ts                      # ZXing WASM QR code decoder wrapper
│   │   │   └── useScanner.ts                  # React camera hook for barcode scanning
│   │   └── supabase/
│   │       ├── client.ts                      # Supabase browser client builder
│   │       └── server.ts                      # Supabase server/SSR client builder
│   └── public/
│       ├── manifest.webmanifest               # PWA Web Application Manifest
│       ├── sw.js                              # Service Worker for offline asset caching
│       ├── icon-192.png                       # PWA Icon
│       └── icon-512.png                       # PWA Icon
│
├── Documents/                                 # Machine spec, architecture doc, TRD
│   ├── sophep-rms-spec.json                   # Machine-readable specification (Rank 1 source of truth)
│   ├── SOPHEP-RMS-v2-Architecture-and-UX.md   # Architecture & UX specification (Rank 2 source of truth)
│   └── SOPHEP-RMS-TRD-v1.0.md                 # Technical Requirements Document (238 numbered requirements)
│
└── Flows/                                     # Flow diagrams (Contains v1 legacy & v2 corrected boards)
    ├── 01 - Master Applicant Journey.pdf
    ├── ... (v1 legacy boards 02 to 16)
    ├── v2-01 - Token Verification and Check-in (E1 corrected).pdf
    ├── v2-02 - Registration and Dedupe Override (E4, E6 corrected).pdf
    ├── v2-03 - State Ownership Rule (E5 corrected).pdf
    ├── v2-04 - Queue Claim with NOT EXISTS (E7, E10 corrected).pdf
    ├── v2-05 - Wait Estimate and Honest Display (E11 corrected).pdf
    ├── v2-06 - Scoring Shrinkage and Review Bands (E2, E3 corrected).pdf
    ├── v2-07 - Deterministic Allocation (E8 corrected).pdf
    ├── v2-08 - Stage Close Gate (E15 corrected).pdf
    ├── v2-09 - Permission Gate, Role Union and Fail-Closed RLS (E9, E13 corrected).pdf
    ├── v2-10 - Applicant State Machine (owners annotated).pdf
    └── v2-11 - Data Model with State Owners.pdf
```

---

## 3. Backend Component Mapping

The backend (`backend/src`) is separated into three sub-layers: **Domain**, **Services**, and **Jobs**.

### A. Pure Domain Layer (`backend/src/domain/`)
All domain functions are pure, synchronous (or purely cryptographic), free of database or network I/O, and 100% unit-tested.

1. **`identity.ts`**:
   - `generateToken()`: Creates a 128-bit random token (`raw`) encoded in 22-char base64url and its SHA-256 hash (`hash`). The raw token is returned once and never stored.
   - `hashToken(rawToken)`: Computes SHA-256 binary digest.
2. **`crypto.ts`**:
   - `generateCycleKeypair(encryptionKey)`: Generates an Ed25519 keypair for the cycle. The raw 32-byte public key is exposed; the 32-byte private seed is AES-256-GCM encrypted using `APP_ENCRYPTION_KEY`.
   - `encryptSecret` / `decryptSecret`: Application-layer AES-256-GCM payload encryption with 12-byte IV and 16-byte authentication tag.
   - `signToken` / `verifyTokenSignature`: Ed25519 asymmetric signature generation and verification.
   - `parseQrPayload`: Extracts token and signature from raw QR strings or URL formats (`/q/<token>.<sig>`).
3. **`scoring.ts`**:
   - `computeBiases(evaluations, k)`: Computes per-interviewer mean bias relative to global cohort mean.
   - `applyShrinkage(evaluations, k)`: Applies Empirical-Bayes shrinkage $w = \frac{n}{n+k}$, adjusting raw scores: $\text{adjusted} = \text{raw} - (w \times \text{bias})$.
   - `flagsForApplicant(...)`: Flags `SINGLE_EVALUATOR`, `HIGH_DISAGREEMENT` (spread > 20), `CRITERION_FLOOR` (fraction $\le 0.25$), and `LOW_CONFIDENCE` ($n < 5$).
   - `reviewBand(rank, capacity, flags)`: Categorizes applicants into capacity-relative bands (`clear`: $\le 0.75C$, `discuss`: $\le 2C$, `below`: $> 2C$, `excluded`: criterion floor).
4. **`waitEstimate.ts`**:
   - `updateEwma` / `computeEwma`: EWMA calculation ($\alpha = 0.2$, seed 20 min).
   - `estimateWait(input)`: Generates range-based ETA (e.g., "15–25 minutes") with mandatory revision reasons (`panels` or `service_time`). Suppresses ETA if active panels $< 1$, stage running time $< 15$ min, or queue position $\le 3$.
   - `modelCapacity(input)`: Operational feasibility model evaluating best-case and worst-case hours against department capacities.
5. **`normalisation.ts`**:
   - Implements email lowercasing, phone digit extraction, roll number uppercase stripping, and trigram name cleaning.
6. **`schemas.ts`**:
   - Zod validation schemas: `registrationInputSchema`, `applicantSearchSchema`, `cvUploadSchema`, `screeningSchema`.
7. **`errors.ts`**:
   - `RmsError`: Standardized exception class mapping to defined error codes (e.g., `DUPLICATE_APPLICANT`, `RATE_LIMITED`, `INVALID_TRANSITION`).
   - `fromPostgresError`: Converts SQL constraint violations into user-friendly `RmsError` instances.
8. **`cv.ts`**:
   - Magic number validation for PDF file uploads (`%PDF-`).

### B. Service Layer (`backend/src/services/`)
Services manage database interaction, enforcing transaction boundaries and security context bindings.

1. **`db.ts`**:
   - `getDb()`: Initializes `postgres.js` client pool with statement timeouts (15s).
   - `withContext(ctx, fn)`: Wraps queries in a transaction, executes `SET LOCAL ROLE rms_app`, and sets transaction-local GUCs (`app.user_id`, `app.applicant_id`, `app.actor_role`, `app.actor_label`, `app.client_ip`).
2. **`registration.ts`**:
   - `checkDuplicates(tx, input)`: Calls stored function `fn_find_duplicates` for hard blocks (exact email/phone/roll) and soft warnings (trigram name similarity $\ge 0.85$ + shared preference).
   - `register(tx, rawInput)`: Executes `fn_register_applicant` and `fn_issue_token` atomically.
   - `searchApplicants(tx, cycleId, q)`: Searches by 4 digits, phone suffix, or partial name.
3. **`checkin.ts`**:
   - `ensureCycleKeypair`, `signTokenForCycle`, `buildRosterBundle`.
   - `checkIn(tx, input)`: Executes `fn_check_in` returning position, track, and status.
4. **`queue.ts`**:
   - `callNext(tx, panelId)`: Claims next candidate using `fn_claim_next`.
   - `startInterview`, `expireGrace`, `extendGrace`, `reactivateParked`, `setPriority`.
   - `applicantWait`: Combines queue position and snapshot to generate wait estimates.
5. **`notifications.ts`**:
   - `enqueue(tx, req)`: Calls `fn_enqueue_notification` to record pending outbound emails.
   - `mockAdapter`: Fallback mock adapter for previewing emails in development.

### C. Job Layer (`backend/src/jobs/`)
1. **`anonymisation.ts`**: Implements post-cycle PII sanitization.
2. **`consistency.ts`**: Verifies applicant state projections against underlying audit and event streams.

---

## 4. Database Schema & Migration Mapping

The database layer consists of 33 SQL migrations under `backend/supabase/migrations/`.

### Core Database Schema Tables

| Table | Scoped by `cycle_id`? | Description & Key Invariants |
|---|---|---|
| `societies` | No | Top-level organization record |
| `users` | No | Staff accounts and identity |
| `cycles` | N/A (Root) | Cycle definitions, config JSON, Ed25519 public/private keys |
| `stages` | Yes | Cycle phases (Registration, Screening, Interview, Allocation) |
| `departments` | Yes | Target departments and capacities |
| `tracks` | Yes | Parallel interview streams/queues |
| `rooms` | Yes | Interview rooms mapped to tracks |
| `memberships` | Yes | User roles per cycle (Union of roles: Admin, Coordinator, Desk, Panel, etc.) |
| `applicants` | Yes | Applicant demographic records. `state` is a projection! |
| `applicant_preferences` | Yes | Ranked department choices (1..3) |
| `access_tokens` | Yes | Stores `token_hash` (`sha256`), expiry, revocation flag |
| `audit_events` | Yes | **Append-only log**. `UPDATE` and `DELETE` revoked at database level |
| `queue_entries` | Yes | Live queue records, states (`waiting`, `called`, `in_interview`, `parked`, `done`) |
| `panels` | Yes | Staff interview panels mapped to rooms |
| `interviews` | Yes | Interview records linking panel, applicant, and queue entry |
| `evaluations` | Yes | Interview evaluations (blind: hidden from other interviewers via RLS) |
| `rubrics` / `rubric_criteria` | Yes | Criteria, anchors, weights |
| `score_runs` / `applicant_scores` | Yes | Persisted Empirical-Bayes shrinkage score calculations |
| `allocation_runs` / `decisions` | Yes | Versioned deterministic allocation outcomes |
| `notifications` | Yes | Asynchronous email queue |

### Key Stored Procedures & Functions

- `fn_audit(...)`: Atomic audit logging helper function.
- `fn_check_in(...)`: Atomic check-in transition + queue placement.
- `fn_claim_next(p_panel_id)`: Atomic queue claim executing `SELECT ... FOR UPDATE SKIP LOCKED` and filtering recusals via `NOT EXISTS`.
- `fn_find_duplicates(...)`: SQL function using `pg_trgm` and exact normalisation for deduplication.
- `fn_register_applicant(...)`: Generates sequence number via atomic counter (`UPDATE cycles SET applicant_seq = applicant_seq + 1 ... RETURNING`) and inserts applicant.
- `fn_issue_token(...)`: Inserts SHA-256 token hash into `access_tokens`.
- `fn_run_allocation(p_cycle_id)`: PL/pgSQL implementation of Deferred Acceptance stable matching.

---

## 5. Frontend Component Mapping

The frontend (`frontend/app` & `frontend/lib`) is built with Next.js 16 App Router.

### Route Hierarchy & Pages

```
frontend/app/
├── (public)/                                   # Applicant Facing Pages
│   ├── apply/page.tsx & ApplyForm.tsx          # Multi-channel submission form
│   └── q/[token]/page.tsx & LiveStatus.tsx     # Realtime queue status, wait estimate, QR code
├── (staff)/                                    # Staff Facing Pages
│   ├── checkin/[stageId]/page.tsx & Scanner.tsx# Desk scanner with camera feed & manual search
│   ├── interview/[interviewId]/page.tsx        # Interview panel evaluation form
│   ├── panel/[panelId]/page.tsx & Console.tsx  # Panel Call Next console & grace expiry timers
│   ├── ops/[cycleId]/page.tsx                  # Operations control center & stage gate controls
│   └── dev/notifications/page.tsx              # Email preview console (Dev mode)
├── display/[cycleId]/page.tsx                  # Public hall display board (Omits names & scores)
├── globals.css & layout.tsx & page.tsx         # Global styling and home page
```

### Core Frontend Modules (`frontend/lib/`)
1. **`lib/offline/verifyQR.ts`**: Implements 3-layer QR verification:
   - **Layer 1**: Basic URL/token format check.
   - **Layer 2**: SHA-256 hash lookup against IndexedDB offline roster.
   - **Layer 3**: Ed25519 signature verification using cycle public key.
2. **`lib/offline/indexeddb.ts` & `sync.ts`**: Manages local IndexedDB storage for offline check-ins and handles background replay when connectivity resumes.
3. **`lib/realtime/channels.ts` & `degradation.ts`**: Manages Supabase Realtime WebSocket channels and handles graceful degradation to polling under poor network conditions.
4. **`lib/scanner/useScanner.ts` & `decode.ts`**: WebCam stream management and ZXing WASM QR code decoding.
5. **`middleware.ts`**: Edge middleware providing in-memory rate limiting (token lookups 10/min, applications 3/hr) and HTTP security headers (`nosniff`, `DENY`, `Referrer-Policy`).

---

## 6. Complete API Endpoint Inventory

All API endpoints sit in `frontend/app/api/`. As per Rule `R-003`, route handlers are thin wrappers that delegate all business logic to `@sophep/backend`.

| HTTP Method | Route Endpoint | Purpose | Backend Service Invoked |
|---|---|---|---|
| `POST` | `/api/apply` | Public applicant registration | `registration.register` + `notifications.enqueue` |
| `GET` | `/api/applicants/search` | Staff manual applicant search | `registration.searchApplicants` |
| `POST` | `/api/checkins` | Perform applicant check-in | `checkin.checkIn` |
| `POST` | `/api/interviews/[interviewId]/evaluations` | Submit interviewer evaluation | `withContext` + DB insertion (`evaluations`) |
| `POST` | `/api/panels/[id]/call-next` | Claim next candidate from queue | `queue.callNext` |
| `GET` | `/api/panels/[id]/snapshot` | Get current panel state snapshot | `queue.trackSnapshot` |
| `POST` | `/api/q/[token]/on-my-way` | Candidate confirms arrival | `withContext` + state transition |
| `GET` | `/api/q/[token]/status` | Candidate live queue status | `checkin.resolveScannedToken` + `queue.applicantWait` |
| `POST` | `/api/queue/[entryId]/skip` | Skip candidate in queue | `queue.expireGrace` |
| `POST` | `/api/queue/[entryId]/start` | Start candidate interview | `queue.startInterview` |

---

## 7. Key Data Flows & Lifecycles

### A. Applicant Lifecycle
$$\text{SUBMITTED} \longrightarrow \text{ELIGIBLE} \longrightarrow \text{CHECKED\_IN} \longrightarrow \text{QUEUED} \longrightarrow \text{CALL\_NEXT} \longrightarrow \text{IN\_INTERVIEW} \longrightarrow \text{EVALUATED} \longrightarrow \text{ALLOCATED}$$

1. **Registration**: Applicant submits via `/api/apply`. `register()` generates sequence ID (e.g. `SPH-SP26-0042`), issues 128-bit access token, stores `sha256(token)`, and enqueues welcome email.
2. **Check-in**: At desk, volunteer scans QR code or searches manually. `checkIn()` executes `fn_check_in`, updating `applicants.state` to `checked_in` and creating `queue_entries` row in `waiting` state.
3. **Queue Claim**: Panel clicks "Call Next". `callNext()` executes `fn_claim_next` with `FOR UPDATE SKIP LOCKED`. Candidate transitions to `called` state with a 5-minute grace timer.
4. **Interview & Evaluation**: Panel clicks "Start Interview" (`fn_queue_transition` $\to$ `in_interview`). Two interviewers submit blind rubrics via `/api/interviews/.../evaluations`.
5. **Scoring & Allocation**: Stage closes. `applyShrinkage()` computes Empirical-Bayes score adjustments. `fn_run_allocation()` executes Deferred Acceptance matching to generate deterministic department proposals.

---

## 8. Verification & Verification Commands

All components of the full stack can be independently verified using the npm workspace script suite:

```bash
# Typecheck across all workspaces
npm run typecheck

# Code linting
npm run lint

# Execute unit and service tests
npm test

# Direct SQL Row-Level Security assertion tests
npm run test:rls

# High-concurrency claim and registration stress tests
npm run test:concurrency

# Build test for Next.js app
npm run build
```
