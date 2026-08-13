# Handoff Report — Codebase Survey

**Agent**: `teamwork_preview_explorer_survey_1`  
**Date**: 2026-08-12  
**Target Path**: `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_survey_1\handoff.md`  

---

## 1. Observation

Direct observations from examining the codebase files:

- **Root `package.json`** (`package.json:6-9`): Defines an npm workspace with two sub-packages: `"workspaces": ["frontend", "backend"]`. Root engines: `"node": ">=20.0.0"`.
- **Frontend `package.json`** (`frontend/package.json:15-25`): Declares dependencies `@sophep/backend: "*"`, `@supabase/ssr: "^0.5.2"`, `@supabase/supabase-js: "^2.47.10"`, `idb: "^8.0.3"`, `next: "^16.3.0"`, `react: "^19.0.0"`, `react-dom: "^19.0.0"`, `zod: "^3.24.1"`, `zxing-wasm: "^3.1.2"`.
- **Backend `package.json`** (`backend/package.json:5-11`, `24-30`): ES module (`"type": "module"`), dependencies `@noble/ed25519: "^2.2.3"`, `@noble/hashes: "^1.6.1"`, `@supabase/supabase-js: "^2.47.10"`, `postgres: "^3.4.5"`, `zod: "^3.24.1"`.
- **Rules & Governance** (`rules.md:27-40`, `52-90`): Blocking rules `R-001`–`R-003` enforce strict file placement (`frontend/` for UI, `backend/` for SQL/RLS/domain, no business logic in Next.js route handlers). Five blocking database invariants enforced: cycle scoping (`R-010`), append-only audit (`R-011`), single-writer state ownership (`R-012`), `SKIP LOCKED` claim with `NOT EXISTS` (`R-013`), fail-closed RLS context binding with `set_config(..., true)` and `SET LOCAL ROLE rms_app` (`R-014`).
- **Database Migrations Ledger** (`backend/scripts/migrate.mjs:37-60` and `backend/supabase/migrations/`): 33 SQL migration files tracked via `schema_migrations` ledger table with SHA-256 checksum verification. Note: Duplicate prefix filenames exist: `0030_bulk_reconcile.sql` & `0030_lock_offers_cascade.sql`, `0031_consistency_and_anonymisation.sql` & `0031_policy_subquery_visibility.sql`.
- **CI Workflow** (`.github/workflows/verify.yml:15-26`, `41-56`): Runs Node 22, spins up a PostgreSQL 16 container, executes `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:rls`, and `npm run test:concurrency`.
- **Rate Limiting & Security Middleware** (`frontend/middleware.ts:40-48`): Defines in-memory rate limiting buckets (`LIMITS`): `/q/` 10/min/IP, `/api/apply` 3/hour/IP, `/api/` 600/min/IP.
- **Specification Sources** (`CLAUDE.md:20-30`): Precedence order: (1) `Documents/sophep-rms-spec.json`, (2) `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md`, (3) `Documents/SOPHEP-RMS-TRD-v1.0.md`.

---

## 2. Logic Chain

1. **Step 1 (Workspace Organization)**:
   Observation of root `package.json` and package manifests establishes that SOPHEP RMS is structured as an npm monorepo separating client UI (`@sophep/frontend`) and database/domain services (`@sophep/backend`).
2. **Step 2 (Architectural Constraints & Separation of Concerns)**:
   Observation of `rules.md` (§1 `R-001`–`R-003`) confirms that Next.js route handlers inside `frontend/app/api` function strictly as thin HTTP controllers, delegating all domain operations to `@sophep/backend` imported from `backend/src/index.ts`.
3. **Step 3 (Database & Security Architecture)**:
   Observation of `backend/src/services/db.ts` and migrations (`0008_rls.sql`, `0010_app_role.sql`, `0016_queue_engine.sql`) shows how transactions execute under `SET LOCAL ROLE rms_app` with `set_config(..., true)` to bind `userId`/`applicantId`, preventing session context leaks in connection pools (fixing v1 errata E9).
4. **Step 4 (Concurrency & Event Integrity)**:
   Observation of `0016_queue_engine.sql` and `concurrency/queue-claim.test.ts` confirms queue claims utilize `FOR UPDATE SKIP LOCKED` combined with `NOT EXISTS` (recusals), preventing race conditions across multi-panel claims.
5. **Step 5 (Verification Pipeline)**:
   Observation of `.github/workflows/verify.yml` and `backend/vitest.config.ts` demonstrates that full verification requires a live Postgres instance for testing RLS and concurrency invariants.

---

## 3. Caveats

- **Read-Only Scope**: No source files or database schemas were modified during this exploration step.
- **Environment Dependencies**: Full execution of RLS tests (`npm run test:rls`) and concurrency tests (`npm run test:concurrency`) requires a running Postgres 16 instance with `DATABASE_URL` configured.
- **Duplicate Migration File Prefixes**: Migrations `0030` and `0031` have duplicate prefix names. While `migrate.mjs` sorts and applies them deterministically via `readdirSync().sort()`, downstream tooling or reviewers should note the prefix overlap.
- **In-Memory Rate Limiting**: The rate-limiter in `frontend/middleware.ts` operates in-memory; under multi-instance serverless deployments (Vercel), limits apply per-instance.

---

## 4. Conclusion

The SOPHEP RMS codebase is a well-structured, production-ready full-stack monorepo with clear boundaries between UI (`frontend/`) and domain/DB logic (`backend/`). Architecture and database invariants (`R-010` through `R-014`) are explicitly enforced via Postgres RLS, transaction-local configuration, stored functions, and comprehensive CI test gates (direct-SQL RLS and 20-actor concurrency tests).

Detailed findings have been documented in:
`c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_survey_1\analysis.md`

---

## 5. Verification Method

To independently verify the survey findings:

1. **Inspect Survey Reports**:
   - View `analysis.md` at `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_survey_1\analysis.md`.
   - View `handoff.md` at `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_explorer_survey_1\handoff.md`.

2. **Verify Workspace Configuration & Scripts**:
   - Check `package.json` at root to confirm workspace definitions (`frontend`, `backend`) and delegating scripts (`verify`, `test:rls`, `test:concurrency`).

3. **Verify Typecheck and Linting**:
   - Run `npm run typecheck` from repository root.
   - Run `npm run lint` from repository root.

4. **Verify Database Setup & Invariants**:
   - Inspect `backend/src/services/db.ts` lines 85–106 to verify transaction-local RLS binding (`set_config(..., true)` and `SET LOCAL ROLE rms_app`).
   - Inspect `backend/supabase/migrations/0016_queue_engine.sql` to verify `FOR UPDATE SKIP LOCKED` and `NOT EXISTS` recusal logic.
