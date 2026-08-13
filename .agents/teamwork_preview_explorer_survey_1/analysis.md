# Codebase Survey & Architectural Analysis — SOPHEP RMS

**Date**: 2026-08-12  
**Target Repository**: `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction`  
**Explorer Agent**: `teamwork_preview_explorer_survey_1`  

---

## 1. Executive Summary & Core Mission

**SOPHEP RMS** (Recruitment Management System) is a full-stack, cycle-based student induction platform built for running end-to-end recruitment drives (100–1,000 applicants, 6–20 volunteers, 8–30 interviewers) on unreliable campus Wi-Fi. 

The application architecture prioritizes event continuity over edge-case feature perfection, governed by **5 blocking database invariants** and **strict file placement rules**.

### Precedence Hierarchy of Specifications
1. `Documents/sophep-rms-spec.json` (Machine-readable canonical specification; wins on conflict)
2. `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md` (Design rationale, schema, screen layouts)
3. `Documents/SOPHEP-RMS-TRD-v1.0.md` (238 numbered requirements + verification procedures)

*Note: `Flows/` contains historical diagrams, some of which encode obsolete designs (e.g. legacy HMAC and score normalization, detailed in `rules.md` §4).*

---

## 2. Directory & Workspace Structure

The project is structured as an **npm monorepo workspace** with two primary packages (`@sophep/frontend` and `@sophep/backend`).

```
Induction/
├── .agents/                               # Agent metadata & execution logs (READ-ONLY for app)
├── .github/
│   └── workflows/
│       └── verify.yml                     # GitHub Actions CI (Postgres 16 service, typecheck, lint, RLS, concurrency)
├── backend/                               # Backend workspace (@sophep/backend)
│   ├── package.json                       # Backend manifest (ESM)
│   ├── tsconfig.json                      # TS configuration (target ES2022)
│   ├── vitest.config.ts                   # Vitest configuration (auto-loads root .env, serial execution)
│   ├── scripts/                           # Database & benchmark scripts
│   │   ├── migrate.mjs                    # Custom migration runner with SHA-256 checksum ledger
│   │   ├── seed.mjs                       # Cycle & demo data seeder
│   │   ├── reset-test-db.mjs              # Test DB wipe/rebuild helper
│   │   └── measure-latency.mjs            # Latency benchmarking script
│   ├── sql/                               # SQL reference files (functions, policies, seeds)
│   ├── src/                               # TypeScript domain & service code
│   │   ├── index.ts                       # Entry point re-exporting domain & services
│   │   ├── domain/                        # Pure domain logic (crypto, cv, errors, identity, normalisation, schemas, scoring, totp, verification, waitEstimate)
│   │   ├── services/                      # DB services (db, checkin, notifications, queue, registration)
│   │   └── jobs/                          # Maintenance & background jobs (anonymisation, consistency)
│   ├── supabase/
│   │   └── migrations/                    # 33 SQL database migrations
│   └── tests/                             # Vitest test suites (unit, rls, concurrency, golden)
├── frontend/                              # Frontend workspace (@sophep/frontend)
│   ├── package.json                       # Frontend manifest (Next.js 16, React 19)
│   ├── tsconfig.json                      # TS configuration (path aliases @/* and @sophep/backend/*)
│   ├── next.config.ts                     # Next.js config (loads root env, transpilePackages, security headers)
│   ├── tailwind.config.ts                 # Design tokens & state colors
│   ├── middleware.ts                      # Rate limiting (token, apply, api) & security headers
│   ├── eslint.config.mjs                  # Flat ESLint configuration
│   ├── vitest.config.ts                   # Frontend unit test configuration
│   ├── app/                               # Next.js App Router
│   │   ├── (public)/                      # Public routes (/apply, /q/[token])
│   │   ├── (staff)/                       # Staff routes (/checkin, /interview, /ops, /panel, /dev)
│   │   ├── display/                       # Public display board route (/display/[cycleId])
│   │   └── api/                           # Thin REST route handlers
│   ├── components/                        # UI components (queue, scanner, state, ui)
│   ├── lib/                               # Client libraries (a11y, auth, offline, realtime, scanner, supabase)
│   └── tests/                             # Frontend test directory (currently empty placeholder)
├── Documents/                             # Specification documents (READ-ONLY)
├── Flows/                                 # Visual flow diagrams (READ-ONLY reference)
├── .env.example                           # Documented environment variable template
├── CLAUDE.md                              # AI agent operational context
├── PHASE-4-PLAN.md                        # Phase 4 design document (Scoring, allocation, decisions)
├── ROADMAP.md                             # 6-phase roadmap & exit criteria checklist
├── rules.md                               # Blocking architecture & governance constraints
├── package.json                           # Root workspace manifest
├── package-lock.json                      # Lockfile
└── README.md                              # Project overview
```

---

## 3. Technology Stack & Manifest Analysis

### Monorepo Workspaces (`package.json`)
- **Node Engine**: `>=20.0.0`
- **Workspaces**: `["frontend", "backend"]`
- **Root Scripts**:
  - `dev`: `npm run dev --workspace=@sophep/frontend`
  - `build`: `npm run build --workspace=@sophep/frontend`
  - `start`: `npm run start --workspace=@sophep/frontend`
  - `test`: `npm run test --workspaces --if-present`
  - `test:rls`: `npm run test:rls --workspace=@sophep/backend`
  - `test:concurrency`: `npm run test:concurrency --workspace=@sophep/backend`
  - `test:e2e`: `npm run test:e2e --workspace=@sophep/frontend`
  - `typecheck`: `npm run typecheck --workspaces --if-present`
  - `lint`: `npm run lint --workspaces --if-present`
  - `db:migrate`: `npm run db:migrate --workspace=@sophep/backend`
  - `db:reset`: `npm run db:reset --workspace=@sophep/backend`
  - `db:seed`: `npm run db:seed --workspace=@sophep/backend`
  - `verify`: `npm run typecheck && npm run lint && npm run test`

### Frontend Package (`frontend/package.json`)
- **Framework**: Next.js `^16.3.0` (App Router) with React `^19.0.0` and React-DOM `^19.0.0`
- **Styling**: Tailwind CSS `^3.4.17`, PostCSS `^8.5.1`, Autoprefixer `^10.4.20`
- **Database & Auth**: `@supabase/supabase-js` `^2.47.10`, `@supabase/ssr` `^0.5.2`
- **Utilities**: `zod` `^3.24.1` (validation), `idb` `^8.0.3` (IndexedDB for offline check-in), `zxing-wasm` `^3.1.2` (fallback barcode scanning)
- **Development & Testing**: `@playwright/test` `^1.49.1`, Vitest `^4.1.10`, TypeScript `^5.7.3`, ESLint `^9.18.0`

### Backend Package (`backend/package.json`)
- **Module Type**: ESM (`"type": "module"`)
- **Database Access**: `postgres` `^3.4.5` (Native Postgres driver for Node.js, max connections 10, statement timeout 15s)
- **Cryptography**: `@noble/ed25519` `^2.2.3` (Digital signatures for QR tokens), `@noble/hashes` `^1.6.1` (SHA-256 / SHA-512)
- **Supabase CLI / Driver**: `supabase` `^2.2.1`
- **Validation**: `zod` `^3.24.1`

---

## 4. Key Architectural Invariants & Rules

The project defines **blocking constraints** in `rules.md` to guarantee stability under concurrency:

1. **File Placement (`R-001` - `R-005`)**:
   - `frontend/`: UI components, pages, client state, thin route handlers.
   - `backend/`: SQL migrations, RLS policies, DB functions, domain TypeScript, services, test suites.
   - `R-003`: Business logic MUST NOT live in Next.js route handlers. Route handlers only authenticate, validate inputs, delegate to `@sophep/backend`, and shape HTTP responses.

2. **The Five Database Invariants (`R-010` - `R-014`)**:
   - **`R-010` (Cycle Scoping)**: Every table except `societies` and `users` carries `cycle_id`.
   - **`R-011` (Append-Only Audit)**: `audit_events` cannot be UPDATED or DELETED. Every state change writes an audit record *within the exact same transaction*.
   - **`R-012` (Single-Writer State Ownership)**: `applicants.state` is a read projection; application code NEVER updates it directly. It is written exclusively by SQL trigger/functions (`fn_check_in`, `fn_queue_transition`, `fn_interview_transition`, `fn_apply_decision`).
   - **`R-013` (Concurrent Queue Claim)**: Queue claim uses `FOR UPDATE SKIP LOCKED` and recusal filter using `NOT EXISTS`. Usage of `NOT IN` is strictly prohibited.
   - **`R-014` (Fail-Closed RLS)**: Unset security context returns 0 rows. RLS context is set via `set_config(key, value, true)` inside transactions with `SET LOCAL ROLE rms_app`.

---

## 5. API & Route Architecture

Next.js App Router is organized into distinct route groups:

### App Route Groups
- `(public)`: Public applicant touchpoints.
  - `/apply`: Public registration form (`ApplyForm.tsx`).
  - `/q/[token]`: Applicant live status page (`LiveStatus.tsx`).
- `(staff)`: Staff operational dashboards.
  - `/checkin/[stageId]`: QR scanner PWA (`Scanner.tsx`).
  - `/panel/[panelId]`: Interview panel console (`PanelConsole.tsx`).
  - `/interview/[interviewId]`: Evaluation form (`EvaluationForm.tsx`).
  - `/ops/[cycleId]`: Cycle operations & monitoring dashboard.
  - `/dev/notifications`: Local notification preview.
- `display`:
  - `/display/[cycleId]`: Public queue display board (names excluded at publisher level).

### Backend REST API Handlers (`frontend/app/api`)
- `POST /api/apply`: Registers candidate via `registration` service.
- `GET /api/applicants/search`: Searches applicants for staff manual check-in.
- `POST /api/checkins`: Processes QR scan or manual check-in via `checkin` service.
- `POST /api/panels/[id]/call-next`: Executes `SKIP LOCKED` claim to assign next candidate.
- `GET /api/panels/[id]/snapshot`: Retrieves panel state.
- `POST /api/queue/[entryId]/start`: Begins interview session.
- `POST /api/queue/[entryId]/skip`: Skips candidate in queue.
- `POST /api/interviews/[interviewId]/evaluations`: Submits evaluation scores.
- `GET /api/q/[token]/status`: Polls status for candidate page.
- `POST /api/q/[token]/on-my-way`: Grants 2-minute grace extension.

---

## 6. Database Migration Ledger & Schema Overview

Migrations are stored in `backend/supabase/migrations/` and executed via `backend/scripts/migrate.mjs`, which maintains a `schema_migrations` table with SHA-256 checksum verification to prevent migration drift.

### 33 SQL Migrations:
1. `0001_extensions_and_normalisation.sql`: Enables `citext`, `pg_trgm`, `norm_email`, `norm_phone`.
2. `0002_enums.sql`: DB enums (`cycle_state`, `applicant_state`, `stage_type`, `queue_status`, `interview_state`, `decision_type`).
3. `0003_core_tables.sql`: `societies`, `cycles`, `stages`, `departments`, `tracks`, `rooms`, `users`, `memberships`.
4. `0004_applicants.sql`: `applicants`, `applicant_preferences`, `access_tokens`.
5. `0005_audit_and_infra.sql`: `audit_events`, append-only triggers.
6. `0006_state_ownership.sql`: State transition validation functions.
7. `0007_registration.sql`: Registration DB stored procedure (`fn_register_applicant`).
8. `0008_rls.sql`: Core RLS policies & `set_config` accessors.
9. `0009_cycle_config_defaults.sql`: Cycle configuration defaults.
10. `0010_app_role.sql`: `rms_app` database role setup.
11. `0011_public_access.sql`: Public applicant access functions/policies.
12. `0012_harden_context_accessors.sql`: Context accessor error handling.
13. `0013_fix_registration_deadlock.sql`: Fixes lock-upgrade deadlock in registration.
14. `0014_notification_enqueue.sql`: `notifications` table & enqueue helper.
15. `0015_event_schema.sql`: Event tables (`check_ins`, `panels`, `panel_members`, `queue_entries`, `recusals`, `interviews`).
16. `0016_queue_engine.sql`: `fn_claim_next` (`SKIP LOCKED`), `fn_queue_transition`.
17. `0017_event_rls.sql`: RLS policies for event tables.
18. `0018_checkin.sql`: Ed25519 token verification & `fn_check_in`.
19. `0019_fix_checkin_ambiguity.sql`: Resolves column ambiguity in check-in queries.
20. `0020_display_board.sql`: Display board query functions.
21. `0021_applicant_status.sql`: Status page query functions.
22. `0022_register_and_checkin.sql`: Combined registration/checkin logic.
23. `0023_rubrics.sql`: Rubric definition & criteria tables.
24. `0024_evaluations.sql`: Evaluation storage & validation.
25. `0025_stage_close_and_heartbeat.sql`: Stage close blocking gates & panel heartbeat.
26. `0026_waiver_requires_actor.sql`: Requires actor context on waivers.
27. `0027_scoring_persistence.sql`: Persistence for raw & adjusted score projections.
28. `0028_allocation.sql`: Deferred acceptance allocation functions.
29. `0029_checksum_without_pgcrypto.sql`: Pure SQL sha256 checksum computation.
30. `0030_bulk_reconcile.sql`: Bulk offline reconciliation.
31. `0030_lock_offers_cascade.sql`: Dual-control lock & offer waitlist cascade.
32. `0031_consistency_and_anonymisation.sql`: State drift check & PII anonymisation.
33. `0031_policy_subquery_visibility.sql`: RLS policy visibility fix.

*Observation*: Migrations 0030 and 0031 feature duplicate numeric prefixes (`0030_bulk_reconcile` vs `0030_lock_offers_cascade`, and `0031_consistency_and_anonymisation` vs `0031_policy_subquery_visibility`), which `migrate.mjs` executes in alphabetical order based on standard `readdirSync().sort()`.

---

## 7. Testing, Verification & CI Pipeline

### Testing Strategy
- **Unit Tests** (`backend/tests/unit`): Crypto (Ed25519), CV validation, applicant ID generation, email/phone normalization, TOTP verification, EWMA wait estimation.
- **RLS Security Tests** (`backend/tests/rls`): Direct SQL queries executing under `rms_app` role with `withContext` / `withoutContext` to verify fail-closed boundaries (Applicant status, evaluation isolation, public access).
- **Concurrency Tests** (`backend/tests/concurrency`): 20 concurrent registration tasks and 20 concurrent `Call Next` claim tasks against real Postgres.
- **Golden Dataset Tests** (`backend/tests/golden`): Scoring shrinkage, allocation algorithm, dual-control lock.

### CI Workflow (`.github/workflows/verify.yml`)
- Runs on GitHub Actions (`ubuntu-latest`, Node.js 22).
- Spins up a native **Postgres 16** service container on port 5432.
- Executes:
  1. `npm ci`
  2. `npm run typecheck`
  3. `npm run lint`
  4. `npm test`
  5. `npm run test:rls`
  6. `npm run test:concurrency`

---

## 8. Observations & Downstream Audit Focus Areas

For the subsequent comprehensive audit phase, the following operational and structural areas warrant attention:

1. **Duplicate Migration Prefixes**: Migrations `0030` and `0031` are present twice with different suffixes.
2. **In-Memory Rate Limiting**: `frontend/middleware.ts` uses an in-memory `Map` for rate-limiting. As noted in the code comments, on multi-instance serverless deployments (Vercel), limits apply per-instance rather than globally.
3. **Empty Frontend Tests Folder**: `frontend/tests/` exists but contains no test files (frontend unit tests are configured via `vitest.config.ts`).
4. **OneDrive File-Locking Risk**: Workspace is hosted in a OneDrive directory; file locks (`EPERM` / `EBUSY`) can disrupt `node_modules` or `.next` builds during heavy IO.

---
