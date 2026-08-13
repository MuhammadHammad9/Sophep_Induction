# Handoff Report — Specification Mining Survey 3

**Agent**: `teamwork_preview_spec_miner_survey_3`  
**Working Directory**: `c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_spec_miner_survey_3`  
**Milestone**: Survey & Specification Mining  
**Handoff Type**: Hard Handoff (Task Complete)

---

## 1. Observation

Direct observations from the repository specifications, documentation, and source files:

1. **Primary Specification Documents**:
   - `Documents/sophep-rms-spec.json`: Machine-readable specification (Version 2.0.0, 4,722 lines). States in `notes_for_implementers`: `"Where this JSON and prose documents disagree, treat it as a defect in this JSON and raise it."` and `"Requirements using 'shall' are mandatory. Absence is a defect."`
   - `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md`: Architecture & UX specification (1,378 lines) detailing 15 errata corrections (E1 through E15) from v1 to v2.
   - `Documents/SOPHEP-RMS-TRD-v1.0.md`: TRD containing 238 numbered requirements across functional, non-functional, data, and interface categories.
   - `rules.md`: Mandatory blocking rules (§1 File Placement R-001..005, §2 Invariants R-010..014, §3 Forbidden Patterns R-020..032, §4 Obsolete References R-040..043, §5 Working Practice R-050..058, §6 Accessibility Floor R-060..066).
   - `CLAUDE.md`: Repository layout, locked decisions, open issues, and environment constraints.

2. **Core System Invariants Observed**:
   - `rules.md` line 57: `R-010` `cycle_id` required on every table except `societies` and `users`.
   - `rules.md` line 61: `R-011` `audit_events` is append-only with `UPDATE` and `DELETE` revoked at DB level; written in-transaction (*No audit, no commit*).
   - `rules.md` line 69: `R-012` `applicants.state` is a projection, never written directly by application code.
   - `rules.md` line 77: `R-013` Queue claim uses `FOR UPDATE SKIP LOCKED` with `NOT EXISTS` recusals filter (`NOT IN` is forbidden).
   - `rules.md` line 84: `R-014` Fail-closed RLS policies using `nullif(current_setting(..., true), '')::uuid`.

3. **Key Algorithms & Formulations**:
   - Applicant ID Generation: In-transaction counter `UPDATE cycles SET applicant_seq = applicant_seq + 1 ... RETURNING` yielding IDs formatted like `SPH-SP26-0042`.
   - QR Verification: Layer 1 (Format), Layer 2 (`sha256(token)` roster hash set-membership), Layer 3 (Ed25519 asymmetric signature using cycle public key), Layer 4 (Server validation).
   - Deduplication: Exact match on `norm_email()` (Gmail dot/plus stripped) or `norm_phone()` hard-blocks registration; trigram name similarity >= 0.85 soft warns; override requires mandatory reason >= 10 chars.
   - Empirical-Bayes Shrinkage Scoring: `w = n / (n + 5)`, `bias = interviewer_mean - cohort_mean`, `adjusted = raw - (w * bias)`.
   - Gale-Shapley Deferred Acceptance Allocation: Applicant-proposing, with 5-level deterministic tie-breaker: `adjusted_score DESC` -> `recommendation_count DESC` -> `panel_score_spread ASC` -> `submitted_at ASC` -> `applicant_id ASC`.

4. **API and Schema Mapping**:
   - 39 REST endpoints defined with explicit capability-based authorization, idempotency headers, and 14 machine-readable error codes.
   - 31 database migrations (`0001` through `0031`) implementing PostgreSQL schemas, enums, triggers, RLS policies, and domain functions.

---

## 2. Logic Chain

1. **Observation**: `ORIGINAL_REQUEST.md` requires a senior-level code audit of the SOPHEP RMS codebase, while `DISPATCH.md` assigns `teamwork_preview_spec_miner_survey_3` to mine all repository documentation, READMEs, inline comments, specification files, API specs, database schemas, and expected workflows.
2. **Logic Step**: To enable accurate auditing and downstream implementation verification, all authoritative specifications must be extracted, cross-referenced, and documented without making any codebase edits (read-only constraint).
3. **Observation**: The repository contains explicit specification hierarchy (`sophep-rms-spec.json` > `Architecture-and-UX.md` > `TRD-v1.0.md`) and 15 explicit errata (E1-E15) that override prior v1 design flaws.
4. **Logic Step**: Mapping the 5 core invariants, 15 errata corrections, 22 applicant states, 39 API routes, database schemas, math formulas (shrinkage, Gale-Shapley, EWMA), and edge cases into structured tables provides an exhaustive, unambiguous baseline for audit and validation.
5. **Conclusion**: `analysis.md` contains the full specification mining findings (25 discovered features and 20 detailed edge cases), fulfilling all survey objectives.

---

## 3. Caveats

- **No Code Modifications**: As instructed by constraints, investigation was strictly read-only; no codebase files or migrations were edited.
- **Open Issues**: Six open issues (`OI-4`, `OI-5`, `OI-6`, `OI-10`, `OI-11`, `OI-12`) are noted in `CLAUDE.md` and `sophep-rms-spec.json` as pending committee decisions. Default values specified in the spec are documented and in force until resolved.

---

## 4. Conclusion

The specification mining for SOPHEP RMS v2 is complete. All architectural intent, business rules, DB schemas, state machine transitions, error contracts, design system guidelines, and critical edge cases have been mined and recorded in `analysis.md`.

---

## 5. Verification Method

To independently verify the extracted specifications and findings:

1. **Inspect Analysis Report**:
   ```bash
   view_file "c:\Users\Khaas Laptop's\OneDrive - Higher Education Commission\Desktop\Sophep\Induction\.agents\teamwork_preview_spec_miner_survey_3\analysis.md"
   ```
2. **Verify Conformance against Spec Source**:
   - Check `Documents/sophep-rms-spec.json` for entity definitions, algorithm formulas, and 39 API endpoint contracts.
   - Check `rules.md` for blocking rules `R-001` through `R-066`.
   - Check `backend/supabase/migrations/` for SQL migration alignment.
3. **Run Verification Command**:
   ```bash
   npm run verify
   ```
