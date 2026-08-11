# Project: SOPHEP RMS Code Audit

## Architecture
- Monorepo structure with `@sophep/frontend` (Next.js 16 App Router, React 19, Tailwind) and `@sophep/backend` (TypeScript domain modules, Supabase/Postgres 16 DB with RLS and 33 SQL migrations).
- Architectural separation enforced by `rules.md` (R-001..R-003): thin Next.js route handlers delegating to `@sophep/backend`.
- Database & RLS Invariants: `withContext` using `SET LOCAL ROLE rms_app` and transaction-local `set_config(..., true)` (`R-014`). Append-only `audit_events` (`R-011`). State projection on `applicants.state` (`R-012`). Queue claim via `SKIP LOCKED` and `NOT EXISTS` (`R-013`).

## Feature Inventory
| # | Feature / Audit Area | Description | Milestone | Source |
|---|----------------------|-------------|-----------|--------|
| 1 | Frontend Architecture & UI | Next.js 16 App Router, React 19 client components, middleware rate limiting, layout, hydration, Tailwind | M1 | Survey |
| 2 | Backend & API Domain | Domain modules (`crypto`, `cv`, `errors`, `identity`, `scoring`, `totp`, `verification`), API route handlers in `frontend/app/api/` | M2 | Survey |
| 3 | Database Schema & Queries | 33 SQL migrations, stored procedures (`fn_register_applicant`, `fn_claim_next`, `fn_run_allocation`, etc.), RLS policies, trigger performance, migration ordering | M3 | Survey |
| 4 | Security, Architecture & Debt | Security model (fail-closed RLS, secrets/TOTP, rate limiting, auth), architectural compliance with `rules.md`, technical debt, CI/CD, documentation consistency | M4 | Survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Frontend Audit | Audit `frontend/` package: App Router pages, components, client state, middleware, accessibility, hydration, and bundle/performance efficiency | none | IN_PROGRESS |
| 2 | Backend & Domain Audit | Audit `backend/src/` modules and `frontend/app/api/` route handlers: domain business logic, cryptographic verification, scoring algorithm, error handling | none | IN_PROGRESS |
| 3 | Database & Schema Audit | Audit `backend/supabase/migrations/` and DB procedures/triggers: schema constraints, RLS policies, concurrency safety, indexing, stored procedure performance | none | IN_PROGRESS |
| 4 | Security, Architecture & Debt Audit | Audit security model (fail-closed RLS, secrets/TOTP, rate limiting, auth), architectural compliance with `rules.md`, technical debt, CI/CD, documentation consistency | M1, M2, M3 | PLANNED |

## Interface Contracts
### `frontend/app/api` ↔ `@sophep/backend`
- All route handlers function strictly as thin HTTP controllers calling backend services/domain functions.
- Authorization and user/applicant context passed to `withContext(ctx, fn)`.
