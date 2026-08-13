# SOPHEP Recruitment Management System (SOPHEP RMS v2)
## Specification Mining & Architectural Analysis

> **Artifact ID**: SOPHEP-RMS-SPEC-SURVEY-3  
> **Date**: 2026-08-12  
> **Status**: Completed  
> **Source Documents Mined**:
> 1. `Documents/sophep-rms-spec.json` (Machine-readable Spec v2.0.0 — Primary Source of Truth)
> 2. `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md` (Architecture & UX Spec v2.0)
> 3. `Documents/SOPHEP-RMS-TRD-v1.0.md` (Technical Requirements Document v1.0 — 238 Requirements)
> 4. `rules.md` (Blocking Project Constraints & Invariants)
> 5. `CLAUDE.md` (Project Context & Locked Decisions)
> 6. `ROADMAP.md` (Phased Build Plan & Exit Criteria)
> 7. `Flows/` (v2 Corrected Process Flowboards `v2-01` through `v2-11`)
> 8. `backend/supabase/migrations/*.sql` (Database Migrations `0001` through `0031`)
> 9. `backend/src/domain/` & `backend/src/services/` (TypeScript Domain Specifications)

---

## 1. Executive Summary & Core Principles

SOPHEP RMS is a cycle-based recruitment management system designed for the SOPHEP student society. It governs the end-to-end induction workflow: **registration → check-in → queueing → interview → evaluation → scoring → allocation → offers → onboarding**.

### Operating Environment & Design Philosophy
- **Target Cohort**: 100–1,000 applicants per cycle, 6–20 volunteers, 8–30 interviewers.
- **Physical Environment**: Noisy halls, unreliable campus WiFi, staff with ~15 minutes of training.
- **Core Design Maxim**: *The event never stops.* Operational continuity takes precedence over absolute feature perfection.

### Precedence Hierarchy of Specifications
1. `Documents/sophep-rms-spec.json` (Machine-readable JSON — **Wins on conflict**)
2. `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md` (Design rationale and UX specs)
3. `Documents/SOPHEP-RMS-TRD-v1.0.md` (238 formal TRD requirements)

### The Nine Core Design Principles
1. **The event never stops**: Every critical path has a degraded mode.
2. **Never present a number you know is stale as if it were live**: Honesty beats false stability (E11 correction).
3. **Every state change is atomic, idempotent, and audited**: Retries cause zero duplicate effects.
4. **One writer per fact**: Projections are written in the same transaction as their source state.
5. **Fairness is enforced by the schema**: Bias controls live in database constraints and RLS policies.
6. **Applicants see only themselves**: Enforced at row level in PostgreSQL.
7. **Optimise for the fifteen seconds at the desk**: Zero-tap success paths for high-pressure volunteers.
8. **Configuration over code**: Departments, rubrics, criteria, weights, and stages are data; new cycles require zero code deployment.
9. **Cycles are immutable once closed**: Historical data is read-only.

---

## 2. Architectural Invariants & Errata Corrections

### 2.1 The Five Blocking System Invariants (`rules.md` §2)
1. **Cycle Scoping (`R-010`)**: Every table except `societies` and `users` carries `cycle_id`.
2. **Append-Only Audit (`R-011`)**: `audit_events` revokes `UPDATE`/`DELETE` at DB level. State transitions must write audit rows inside the **same transaction**. *No audit, no commit.*
3. **Single-Writer State Ownership (`R-012`)**: `applicants.state` is a projection written exclusively by `fn_check_in`, `fn_queue_transition`, `fn_interview_transition`, and `fn_apply_decision` in the same transaction.
4. **`FOR UPDATE SKIP LOCKED` Queue Claim (`R-013`)**: Claims queue entries using `FOR UPDATE SKIP LOCKED` with `NOT EXISTS` recusals filter (`NOT IN` is strictly forbidden).
5. **Fail-Closed RLS (`R-014`)**: Unset context returns **zero rows**, never all rows. Context is set via verified JWT claims or `set_config(..., true)` per transaction.

### 2.2 Summary of 15 Errata (v1 Errors Corrected in v2)
- **E1 (Security)**: Replaced cryptographically broken HMAC QR verification (which leaked signing keys to devices) with `sha256(token)` roster set-membership + Ed25519 asymmetric signatures for late walk-ins.
- **E2 (Scoring)**: Replaced absolute score thresholds on z-scales with capacity-relative review bands (`rank <= 0.75C` clear admit, `0.75C < rank <= 2C` discuss, `rank > 2C` below line).
- **E3 (Scoring)**: Eliminated raw + normalised score averaging cliff using Empirical-Bayes shrinkage (`w = n/(n+5)`, `adjusted = raw - w * bias`).
- **E4 (Schema)**: Fixed email unique index blocking dedupe overrides by using partial unique indexes filtering `WHERE dedupe_override_reason IS NULL`.
- **E5 (Architecture)**: Resolved dual sources of truth for applicant state by declaring `queue_entries.state` authoritative for event-day operations.
- **E6 (Schema)**: Implemented real `IMMUTABLE` `norm_email()` (handling Gmail dot/plus stripping) and `norm_phone()` (last 9 digits).
- **E7 (Query)**: Replaced `NOT IN` with `NOT EXISTS` in recusal filters to prevent total queue stalls when recusals return NULL.
- **E8 (Algorithm)**: Made Gale-Shapley deferred acceptance allocation totally deterministic with a 5-level tie-break chain.
- **E9 (Security)**: Hardened RLS policies against pooler context loss by forcing `nullif(..., '')::uuid` fail-closed semantics.
- **E10 (Schema)**: Added `awaiting_evaluations` state to `panels.status` enum to accurately block queue pull while evaluations are missing.
- **E11 (UX)**: Removed wait-time clamping; estimates revise upward with explicit cause statements.
- **E12 (Doc)**: Corrected registration throughput claims to honest database commit limits (~hundreds/sec).
- **E13 (RBAC)**: Allowed multi-role users by defining effective capabilities as the UNION of held roles without deny rules.
- **E14 (Data)**: Enforced strict UTC/`timestamptz` storage with timezone rendering based on `cycles.timezone` (default `Asia/Karachi`).
- **E15 (Process)**: Implemented hard stage-close gate preventing cycle advancement while interviews or evaluations remain incomplete.

---

## 3. Data Models & Database Schemas

### 3.1 Domain Hierarchy & Core Entities
`Society` → `Cycle` → `{Stage, Department, Track, Room, Panel, Rubric, Applicant, CheckIn, QueueEntry, Interview, Evaluation, Decision, Offer, AuditEvent}`

*Critical Distinction*: `Room` != `Panel` != `Interviewer`. Interviewers rotate shifts and swap rooms; `Panel` is the active session that pulls from the queue.

### 3.2 Key Database Schema Specifications (`backend/supabase/migrations/`)
- **`cycles`**: Scoped to society; contains `applicant_seq`, `timezone`, `qr_public_key`, `qr_private_key_enc`, `locked_by`, `lock_confirmed_by`.
- **`applicants`**: `display_id` (e.g. `SPH-SP26-0042`), `state` (projection), `email_norm` (GENERATED), `phone_norm` (GENERATED), `dedupe_override_reason`, `answers` (jsonb), `cv_object_key`.
- **`access_tokens`**: Stores `sha256(token)` hash only (`token_hash bytea UNIQUE`). Raw token is **never persisted**.
- **`check_ins`**: Owner of check-in status. Composite constraint `UNIQUE(applicant_id, stage_id)` guarantees idempotency.
- **`queue_entries`**: Event-day owner. `state` enum (`waiting`, `called`, `in_interview`, `done`, `skipped`, `parked`). `priority` tiers (100, 50, 30, 10, 5).
- **`panels`**: `status` enum (`closed`, `open`, `busy`, `awaiting_evaluations`, `break`).
- **`interviews`**: `status` enum (`in_progress`, `awaiting_evaluations`, `complete`, `abandoned`, `flagged`, `void`).
- **`rubrics` & `criteria`**: Versioned per cycle/dept. `criteria.weight` must sum to 100 per rubric. `anchors` jsonb is **mandatory**.
- **`evaluations` & `score_items`**: `UNIQUE(interview_id, interviewer_id, revision)`. Stores `raw_score`, `adjusted_score`, `shrinkage_weight`.
- **`decisions` & `result_snapshots`**: Versioned decisions. Snapshot holds immutable `payload`, `checksum`, `locked_by`, `confirmed_by`.
- **`audit_events`**: `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC`. Stores `actor_id`, `actor_role`, `action`, `before`, `after`, `reason`.

---

## 4. State Machines & Workflow Engines

### 4.1 Applicant Lifecycle State Machine
- **22 States**: `draft`, `submitted`, `eligible`, `screened_out`, `checked_in`, `queued`, `called`, `in_interview`, `skipped`, `parked`, `interview_complete`, `under_review`, `selected`, `waitlisted`, `rejected`, `offer_pending`, `accepted`, `declined`, `lapsed`, `onboarded`, `withdrawn`, `no_show`.
- **7 Terminal States**: `screened_out`, `withdrawn`, `no_show`, `rejected`, `declined`, `lapsed`, `onboarded`.
- **Invalid Transition Behavior**: Returns `409 INVALID_TRANSITION` detailing `current_state` and `attempted`.

### 4.2 Queue Engine & Claim Logic
- **Pull Model**: Panels pull next eligible applicant via `fn_claim_next`.
- **`SKIP LOCKED` Claim Query**:
  ```sql
  WITH claimed AS (
    SELECT q.id FROM queue_entries q
     WHERE q.cycle_id = $cycle AND q.track_id = ANY($panel_tracks) AND q.state = 'waiting'
       AND NOT EXISTS (
             SELECT 1 FROM recusals r
              WHERE r.applicant_id = q.applicant_id AND r.interviewer_id = ANY($panel_members)
           )
     ORDER BY q.priority DESC, q.enqueued_at ASC
     FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE queue_entries q SET state = 'called', panel_id = $panel, called_at = now(), call_count = call_count + 1
    FROM claimed WHERE q.id = claimed.id RETURNING q.*;
  ```
- **Priority Tiers**: 100 (Accessibility / Requeue after void), 50 (Booked slot holder in window), 30 (Re-queued after skip / Un-parked), 10 (Standard), 5 (Late slot holder).
- **Grace & Skip Pipeline**:
  - Grace window: 5 minutes.
  - "I'm on my way" extension: +2 minutes (once per call).
  - 1st Skip: Priority 30 soft penalty (`enqueued_at = now() - 10 min`).
  - 2nd Skip: Transition to `parked`.
  - Stage Close: All remaining `parked` auto-resolve to `no_show`.

### 4.3 Stage Close Gate Engine (v2-08)
Sequence of validation checks before stage can close:
1. `in_progress` interviews → **BLOCK** (lists room & panel).
2. `awaiting_evaluations` interviews → **BLOCK** (lists missing interviewers; permits Coordinator waiver with mandatory reason).
3. `queued` / `called` applicants → **WARN** (offers bulk carry-forward or bulk no-show).
4. `parked` applicants → Auto-resolve to `no_show`, write audit event, close stage.

---

## 5. Algorithms & Core Mathematical Logic

### 5.1 Applicant ID Generation (`R-020`)
- **Format**: `SSS-XXNN-NNNN` (e.g. `SPH-SP26-0042` where `SPH` = society, `SP` = Spring, `26` = 2026, `0042` = seq).
- **Atomic Counter**:
  ```sql
  UPDATE cycles SET applicant_seq = applicant_seq + 1 WHERE id = $1 RETURNING applicant_seq;
  ```

### 5.2 Four-Layer QR Verification Engine (E1)
1. **Layer 1 (Format)**: Offline check for `https://apply.sophep.org/q/<token>.<sig>` scheme.
2. **Layer 2 (Roster Hash)**: Offline `sha256(scanned_token)` set-membership test against cached roster.
3. **Layer 3 (Ed25519)**: Offline signature check using cycle **PUBLIC** key for late walk-ins.
4. **Layer 4 (Server)**: Online database validation (checks revocation, cycle active status, double check-in).

### 5.3 Empirical-Bayes Shrinkage Scoring (E3)
- **Raw Score**: `raw = sum(criterion_score * weight) / sum(weight)` (0–100 scale).
- **Interviewer Strictness Adjustment**:
  - `cohort_mean = mean(raw across all cycle evaluations)`
  - `n = evaluations completed by interviewer`
  - `w = n / (n + 5)` (shrinkage weight)
  - `bias = interviewer_mean - cohort_mean`
  - `adjusted_score = raw - (w * bias)`
- **Applicant Final Score**: Mean of `adjusted_score` across all assigned panel evaluations.
- **Flags Raised**: `HIGH_DISAGREEMENT` (spread > 20 pts), `CRITERION_FLOOR` (any score <= 2 on 5-pt scale), `LOW_CONFIDENCE` (all evaluators have n < 5), `SINGLE_EVALUATOR`.

### 5.4 Gale-Shapley Deferred Acceptance Allocation (E8)
- **Ordering Chain (Total & Deterministic)**:
  1. `final_adjusted_score` (DESC)
  2. `recommendation_count` (DESC)
  3. `panel_score_spread` (ASC)
  4. `application_submitted_at` (ASC)
  5. `applicant_id` (ASC)
- **Advisory Lock**: `allocation:{cycle_id}` prevents concurrent execution.

---

## 6. API Specifications & Contracts

### 6.1 Endpoints Summary (39 Mapped Routes)
- **Public & Applicant**: `POST /api/apply`, `GET /api/q/:token`, `GET /api/q/:token/status`, `POST /api/q/:token/on-my-way`, `POST /api/q/:token/offer/respond`, `POST /api/q/:token/withdraw`.
- **Registration**: `POST /api/cycles/:id/applicants`, `GET /api/cycles/:id/applicants/search`, `POST /api/applicants/:id/dedupe-override`.
- **Check-In**: `POST /api/checkins`, `POST /api/checkins/bulk-reconcile`, `GET /api/cycles/:id/roster`.
- **Queue**: `GET /api/cycles/:id/queue`, `POST /api/panels/:id/call-next`, `POST /api/queue/:eid/skip`, `POST /api/queue/:eid/reactivate`, `POST /api/queue/:eid/requeue`, `PATCH /api/queue/:eid/priority`.
- **Panels & Interviews**: `POST /api/panels/:id/open`, `POST /api/panels/:id/close`, `POST /api/panels/:id/break`, `POST /api/panels/:id/heartbeat`, `POST /api/interviews/:id/start`, `POST /api/interviews/:id/evaluations`, `PATCH /api/evaluations/:id`, `POST /api/evaluations/:id/waive`, `POST /api/interviews/:id/void`, `POST /api/interviews/:id/force-complete`.
- **Decisions & Publication**: `POST /api/cycles/:id/compute-adjustment`, `GET /api/cycles/:id/review-queue`, `POST /api/cycles/:id/allocate`, `PATCH /api/decisions/:id`, `POST /api/cycles/:id/lock`, `POST /api/cycles/:id/lock/confirm`, `POST /api/cycles/:id/publish/dry-run`, `POST /api/cycles/:id/publish`.
- **Ops & Audit**: `GET /api/cycles/:id/ops`, `GET /api/cycles/:id/capacity-model`, `POST /api/cycles/:id/stage/:sid/close`, `POST /api/cycles/:id/export`, `GET /api/cycles/:id/audit`.

### 6.2 Error Contract (`R-057`)
Standard JSON error structure:
```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Applicant is already checked in",
    "detail": { "current_state": "queued", "attempted": "checked_in" },
    "retryable": false
  }
}
```
**14 Standard Codes**: `INVALID_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, `QUEUE_EMPTY`, `RECUSAL_CONFLICT`, `STAGE_CLOSED`, `STAGE_HAS_ACTIVE_INTERVIEWS`, `DUPLICATE_APPLICANT`, `DUAL_CONTROL_REQUIRED`, `CYCLE_ARCHIVED`, `RATE_LIMITED`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALLOCATION_IN_PROGRESS`, `PREFLIGHT_FAILED`.

---

## 7. Discovered Features & Edge Cases

## Features Discovered
| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Identity | Speaker-Friendly ID Gen | In-transaction per-cycle sequential applicant ID generation (`SPH-SP26-0042`) | `cycle_id` | `display_id`, `sequence` | Database transaction rollback on error | `sophep-rms-spec.json`, `rules.md` R-020 |
| 2 | Security | 4-Layer QR Verification | Format, sha256 roster hash, Ed25519 public key, and server validation | Scanned token/URL string | Validated applicant payload | Rejection with amber/red modal overlays | `sophep-rms-spec.json` §identity, Errata E1 |
| 3 | Registration | Unified Multi-Channel Reg | Single pipeline for online, walk-in digital, and paper transcription | Applicant PII & preferences | Applicant record, token, QR URL | 400 validation error or 409 duplicate block | `sophep-rms-spec.json` §registration |
| 4 | Registration | Deduplication & Override | Exact email/phone/roll hard-block; trigram name >= 0.85 soft warning; audited override | PII fields, optional override reason (min 10 chars) | Success or dedupe block payload | 409 DUPLICATE_APPLICANT if override missing | `sophep-rms-spec.json` §registration, Errata E4, E6 |
| 5 | Check-In | Zero-Tap PWA Scanner | Continuous camera QR scan with 2.5s auto-dwell emerald success & amber re-scan styling | QR image / camera frame | `check_ins` record, updated status | Requires manual dismissal for red errors | `sophep-rms-spec.json` §check_in, `rules.md` R-027 |
| 6 | Queue | Atomic `SKIP LOCKED` Claim | Parallel panels claim next applicant without collision or double assignment | `panel_id`, `track_ids` | `queue_entry` assigned, state='called' | 404 QUEUE_EMPTY if no matching applicant | `sophep-rms-spec.json` §queue_engine, Errata E7 |
| 7 | Queue | Recusal Filter via `NOT EXISTS` | Excludes applicants recused by any interviewer in claiming panel | `applicant_id`, `interviewer_ids` | Filtered queue search | Safe execution even if recusal has NULLs | Errata E7, `rules.md` R-013 |
| 8 | Queue | Priority Tiers & Soft Skip | Priority tiers (100/50/30/10/5). 1st skip drops priority to 30; 2nd skip moves to `parked` | Call attempt counter, grace expiry | Updated queue priority / state | Auto-skip after 5m grace window | `sophep-rms-spec.json` §queue_engine |
| 9 | Queue | Grace Extension | "I'm on my way" status page button extends grace window by 2 minutes once | `token` | Extended grace timer | Single-use guard | `sophep-rms-spec.json` §queue_engine |
| 10 | Queue | Honest Wait Estimation | EWMA service duration with honest range display and explicit upward revision causes | Position, active panels, EWMA | ETA string range (e.g. "15-25 min") | Suppresses ETA if no active panel | Errata E11, `rules.md` R-026 |
| 11 | Evaluation | Anchored Rubric Scoring | Per-criterion 1-5 scoring with mandatory text anchors inline | Rubric scores, remarks, recommendation | Saved evaluation record | 400 if any criterion un-scored | `sophep-rms-spec.json` §interview |
| 12 | Evaluation | Blind Evaluation RLS | Prevents interviewers from seeing peer scores, ranks, or available department seats | Database query context | Masked evaluation view | Database RLS returns zero rows | `sophep-rms-spec.json` §interview, `rules.md` R-029 |
| 13 | Evaluation | 15-Minute Revision Window | Allows interviewer score correction within 15 minutes with mandatory reason | Updated scores, revision reason | Superseded evaluation version | 403 after 15 minutes unless unlocked | `sophep-rms-spec.json` §interview |
| 14 | Evaluation | Coordinator Evaluation Waiver | Unblocks panel from `awaiting_evaluations` if interviewer leaves venue | `interview_id`, `waived_interviewer_id`, reason | Waived evaluation entry | 400 if reason omitted | `sophep-rms-spec.json` §interview |
| 15 | Interview | Heartbeat & Flagging | 30s panel heartbeat; 90m silence flags interview; voiding requeues at priority 100 | Panel heartbeat ping | Panel status | Flags stuck interviews on ops dashboard | `sophep-rms-spec.json` §interview |
| 16 | Stage Close | Stage Close Gate | Hard pre-close check blocking on active interviews / missing evaluations | `stage_id` | Gate status report | Blocks stage close with actionable list | Errata E15, `sophep-rms-spec.json` §stage_close_gate |
| 17 | Scoring | Empirical-Bayes Shrinkage | Shrinks interviewer strictness bias (`w = n/(n+5)`) without scale-mixing | Raw score evaluations | Persistence of raw, adjusted, and weight w | Continuous calculation | Errata E2, E3, `sophep-rms-spec.json` §scoring |
| 18 | Scoring | Capacity-Relative Review Bands | Categorizes applicants into clear admit (`<=0.75C`), discuss (`<=2C`), below line | Ranks, department capacity C | Assigned review band | Flags force entries into discuss band | Errata E2, `sophep-rms-spec.json` §scoring |
| 19 | Allocation | Deferred Acceptance Matching | Deterministic Gale-Shapley matching with 5-level tie-break chain | Preferences, adjusted scores | Matching result mapping | 409 ALLOCATION_IN_PROGRESS via advisory lock | Errata E8, `sophep-rms-spec.json` §allocation |
| 20 | Publication | Dual-Control Result Lock | Requires two distinct Super Admin accounts to lock and confirm results | Lock confirm request | `RESULTS_LOCKED` state, immutable snapshot | 409 DUAL_CONTROL_REQUIRED if same user attempts | `sophep-rms-spec.json` §publication, `rules.md` §2 |
| 21 | Publication | Dry Run Result Inspector | Generates recipient counts, sample emails, and validation warnings before publish | `cycle_id` | Dry run report payload | Highlights unplaced applicants / bad emails | `sophep-rms-spec.json` §publication |
| 22 | Offers | Waitlist Hourly Cascade | Automatically promotes top waitlisted candidate upon offer decline or 1-day expiry | Offer status change / cron | Promoted offer notice | Stops when waitlist exhausted or paused | `sophep-rms-spec.json` §offers_and_waitlist, `CLAUDE.md` |
| 23 | Security | Fail-Closed RLS Policies | Nullif context comparison ensures missing auth context yields 0 rows | `app.user_id` / `app.applicant_id` | Filtered SQL result set | Fail closed (0 rows returned) | Errata E9, `rules.md` R-014 |
| 24 | Resilience | Offline PWA Sync Reconciliation | Replays IndexedDB check-ins in client timestamp order with idempotency keys | Replay payload array | 100% reconciled database state | Conflict logged, earliest server-received wins | `sophep-rms-spec.json` §check_in.offline |
| 25 | Operations | Capacity Model Simulator | Pre-event throughput calculator determining required hours and feasibility range | Applicants, panels, avg duration | Feasibility verdict & required panels | Alerts if event exceeds single-day window | `sophep-rms-spec.json` §capacity_model |

## Edge Cases
| # | Feature | Input | Observed Behavior |
|---|---------|-------|-------------------|
| 1 | Registration | Simultaneous submissions from 2 desks | Per-cycle counter locked in-transaction (`UPDATE cycles SET applicant_seq = applicant_seq + 1 ... RETURNING`) prevents duplicate IDs (`R-020`). |
| 2 | Deduplication | Email `A.B+induction@Gmail.com` vs `ab@gmail.com` | `norm_email()` function strips dots & plus-tags for Gmail, triggering hard duplicate block (Errata E6). |
| 3 | Deduplication | Duplicate applicant with valid override reason (>=10 chars) | Partial unique index (`WHERE dedupe_override_reason IS NULL`) allows insert and logs audit event (Errata E4). |
| 4 | Check-in | Scanned QR of already checked-in applicant | Renders AMBER (not red) screen showing original check-in timestamp (`R-027`, NFR-USE-004). |
| 5 | Check-in | QR token from previous cycle (e.g. Fall 2026 code in Spring 2027) | Ed25519 signature fails verification against active cycle public key; displays red error overlay requiring dismissal (Errata E1). |
| 6 | Queue Claim | Recusal table contains NULL entries | `NOT EXISTS` query handles NULL safely without stalling queue (`R-013`, Errata E7). |
| 7 | Queue Claim | 10 panels press "Call Next" in exact same millisecond | Postgres `FOR UPDATE SKIP LOCKED` guarantees each panel gets a distinct applicant (`R-013`). |
| 8 | Queue Grace | Applicant taps "I'm on my way" at minute 4 of 5-minute grace window | Extends grace window by 2 minutes once; button disables with "Extended" text. |
| 9 | Queue Skip | Applicant skipped for 1st time vs 2nd time | 1st skip requeues at priority 30 with `enqueued_at = now() - 10 min`. 2nd skip moves applicant to `parked`. |
| 10 | Evaluation | Panel attempts "Call Next" while 1 evaluation is unsubmitted | Panel status sets to `awaiting_evaluations`; Call Next button disables, explicitly naming the missing interviewer (`R-058`, Errata E10). |
| 11 | Evaluation | Interviewer device dies mid-interview | Heartbeat drops; after 90m interview transitions to `flagged`; Coordinator voids it, requeuing applicant at priority 100. |
| 12 | Stage Close | Stage close initiated while 1 interview is `in_progress` | Stage close gate BLOCKS execution and outputs list of blocking interviews by room and panel (Errata E15). |
| 13 | Stage Close | Stage close initiated with applicants left in `parked` state | System warns staff, then automatically resolves all `parked` applicants to `no_show`. |
| 14 | Scoring | Interviewer has completed only 1 evaluation | Empirical-Bayes shrinkage calculates weight `w = 1/(1+5) = 0.17`, resulting in minimal strictness adjustment. |
| 15 | Scoring | Panel score spread for an applicant exceeds 20 points | System raises `HIGH_DISAGREEMENT` flag and forces applicant into the `DISCUSS` review band. |
| 16 | Allocation | 2 applicants tie on score, department recommendations, panel spread, and submission time | Tie broken deterministically by Level 5 `applicant_id ASC`, guaranteeing byte-identical matching (`R-025`, Errata E8). |
| 17 | Publication | Same Super Admin account attempts step 1 (lock) and step 2 (confirm lock) | Database constraint `CHECK (lock_confirmed_by <> locked_by)` rejects transaction with `409 DUAL_CONTROL_REQUIRED`. |
| 18 | Offers | Offer expires after 24 hours without response | Status updates to `lapsed`, releasing seat and triggering hourly waitlist cascade promotion to top eligible waitlisted applicant. |
| 19 | Access Control | Unauthenticated SQL query executed directly against database | RLS policies fail closed via `nullif(current_setting(...), '')::uuid`, returning 0 rows (`R-014`, Errata E9). |
| 20 | Network Loss | Offline check-in PWA loses connectivity for 8 hours | Buffers up to 500 scans in IndexedDB; shows striped amber banner; reconciles 100% on reconnect via Idempotency-Keys. |
