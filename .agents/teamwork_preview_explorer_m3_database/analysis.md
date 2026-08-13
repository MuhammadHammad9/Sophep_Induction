# Senior-Level Database Schema & SQL Code Audit Report

## Executive Summary
This report provides a comprehensive, senior-level database architecture, schema, migration, stored procedure, index, RLS, and concurrency safety audit for the project database (`backend/supabase/migrations/` and `backend/scripts/migrate.mjs`).

The audit evaluated database migrations, stored procedures (`fn_register_applicant`, `fn_claim_next`, `fn_run_allocation`, `fn_audit`, `fn_bulk_reconcile`, `fn_anonymise_old_data`, `fn_check_consistency`, etc.), row-level security (RLS) policies, indexing strategies, concurrency mechanisms (`FOR UPDATE SKIP LOCKED`), and fail-closed context binding (`R-014`). 

Overall, the database architecture demonstrates strong domain-driven design, transactional isolation awareness, state machine protection (`app.state_writer`), and security context binding. However, ten substantive issues ranging from Critical/High operational risks to performance bottlenecks and technical debt were identified and detailed below.

---

## Detailed Audit Findings

### Issue 1: Migration Naming Prefix Duplication & Order Drift Risk
- **File Paths**: 
  - `backend/supabase/migrations/0030_bulk_reconcile.sql`
  - `backend/supabase/migrations/0030_lock_offers_cascade.sql`
  - `backend/supabase/migrations/0031_consistency_and_anonymisation.sql`
  - `backend/supabase/migrations/0031_policy_subquery_visibility.sql`
  - `backend/scripts/migrate.mjs` (Lines 51–54)
- **Line Numbers**: `backend/scripts/migrate.mjs:51-54`, and migration filenames
- **Severity**: Low / Technical Debt
- **Detailed Problem Description**:
  The migration directory contains duplicate numerical prefixes: `0030_bulk_reconcile.sql` & `0030_lock_offers_cascade.sql`, as well as `0031_consistency_and_anonymisation.sql` & `0031_policy_subquery_visibility.sql`. 
  In `backend/scripts/migrate.mjs`, files are read using `readdirSync(dir).filter(...).sort()`. Standard JavaScript `Array.prototype.sort()` sorts strings lexicographically. Therefore, execution order relies implicitly on the string suffix after the prefix (`0030_bulk_reconcile.sql` before `0030_lock_offers_cascade.sql`, and `0031_consistency_and_anonymisation.sql` before `0031_policy_subquery_visibility.sql`).
  This duplication introduces three key risks:
  1. Standard migration tools (e.g. Supabase CLI `supabase db push` / `supabase migration list`, Flyway, Knex) require strictly unique numeric sequence numbers or timestamps and can fail or execute out of order when numeric prefixes collide.
  2. If a file is renamed (e.g. `0030_bulk_reconcile.sql` renamed to `0030_reconcile_bulk.sql`), the alphabetical sorting order silently changes, potentially executing DDL/DML in an unexpected order.
  3. `migrate.mjs` keys the migration ledger in `schema_migrations` by `filename`. Renumbering files post-application causes the migration runner to treat them as new migrations, resulting in schema application failures (`relation already exists`).
- **Concrete Recommended Fix / Refactoring Strategy**:
  Renumber all migration files to maintain strictly monotonic, unique sequential integer prefixes:
  - Rename `0030_lock_offers_cascade.sql` -> `0030_lock_offers_cascade.sql`
  - Rename `0030_bulk_reconcile.sql` -> `0031_bulk_reconcile.sql`
  - Rename `0031_consistency_and_anonymisation.sql` -> `0032_consistency_and_anonymisation.sql`
  - Rename `0031_policy_subquery_visibility.sql` -> `0033_policy_subquery_visibility.sql`
  Update `backend/scripts/migrate.mjs` with a validation check that asserts all migration file numeric prefixes are unique prior to sorting.

---

### Issue 2: Non-Transactional Ledger Insertion in `migrate.mjs`
- **File Path**: `backend/scripts/migrate.mjs`
- **Line Numbers**: 77–81
- **Severity**: High
- **Detailed Problem Description**:
  In `migrate.mjs`, each pending migration is applied using:
  ```javascript
  await sql.unsafe(body)
  await sql`
    INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
  `
  ```
  Although `postgres` connection is opened with `{ max: 1 }` and migration files may contain explicit `BEGIN; ... COMMIT;` statements, the `INSERT INTO schema_migrations` is executed as a separate SQL query after `sql.unsafe(body)`.
  If a network disconnection, node process interruption, or database error occurs immediately after `sql.unsafe(body)` completes but before `INSERT INTO schema_migrations` executes, the DDL/DML changes commit to the database, but the migration entry is NOT logged in `schema_migrations`.
  On subsequent runs, `migrate.mjs` will re-attempt to execute the same migration script, throwing fatal errors (`type already exists`, `table already exists`).
- **Concrete Recommended Fix / Refactoring Strategy**:
  Wrap the DDL execution and ledger recording inside a single transaction using `postgres.js`:
  ```javascript
  await sql.begin(async (tx) => {
    await tx.unsafe(body)
    await tx`INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})`
  })
  ```
  Ensure migration `.sql` files do not include explicit internal `BEGIN; / COMMIT;` statements when wrapped by the runner's transaction block, or append the ledger `INSERT` to `body` prior to calling `sql.unsafe()`.

---

### Issue 3: Defective Cycle Age Calculation in Data Anonymisation (`fn_anonymise_old_data`)
- **File Path**: `backend/supabase/migrations/0031_consistency_and_anonymisation.sql`
- **Line Numbers**: 64–69
- **Severity**: High
- **Detailed Problem Description**:
  In `fn_anonymise_old_data()`, archived cycles are selected for PII scrubbing using:
  ```sql
  SELECT array_agg(id) INTO v_archived_cycles
  FROM cycles
  WHERE state = 'archived' 
    AND (SELECT min(created_at) FROM stages WHERE cycle_id = cycles.id) < now() - interval '2 years';
  ```
  This logic checks when the cycle's *stages* were created, rather than when the cycle was *archived*.
  If a cycle created 2 years ago was active until last month and archived yesterday, `fn_anonymise_old_data` will immediately anonymise all applicant names, emails, phones, and audit trails. This destroys active audit records and recent history.
  Additionally, if a cycle has no stages defined, `(SELECT min(created_at) FROM stages ...)` returns `NULL`, causing `NULL < now() - interval '2 years'` to evaluate to `NULL` (false), completely bypassing anonymisation for stageless archived cycles.
- **Concrete Recommended Fix / Refactoring Strategy**:
  1. Add an `archived_at timestamptz` column to the `cycles` table.
  2. Set `archived_at = now()` whenever a cycle transitions to the `'archived'` state.
  3. Refactor `fn_anonymise_old_data()` to filter cycles using `cycles.archived_at < now() - interval '2 years'`:
  ```sql
  SELECT array_agg(id) INTO v_archived_cycles
  FROM cycles
  WHERE state = 'archived' 
    AND archived_at IS NOT NULL
    AND archived_at < now() - interval '2 years';
  ```

---

### Issue 4: Unindexed Temporary Table Bottleneck in Deferred Acceptance Allocation (`fn_run_allocation`)
- **File Path**: `backend/supabase/migrations/0028_allocation.sql`
- **Line Numbers**: 170–202 & 217–282
- **Severity**: High / Performance Bottleneck
- **Detailed Problem Description**:
  `fn_run_allocation` implements Gale-Shapley applicant-proposing deferred acceptance algorithm.
  To ensure deterministic execution over a frozen snapshot, it populates temporary tables: `alloc_pref`, `alloc_held`, `alloc_rejected`, and `alloc_round`.
  Inside `LOOP ... END LOOP;` (lines 217–282), the function executes repeated `SELECT DISTINCT ON`, `WITH pool AS (...)`, `INSERT INTO alloc_rejected`, `DELETE FROM alloc_held`, and `INSERT INTO alloc_held`.
  However, none of these temporary tables have indexes created on `(applicant_id, department_id)` or `(department_id)`.
  As a result, every iteration of the allocation loop performs full sequential table scans across `alloc_pref`, `alloc_held`, and `alloc_rejected`. For cycles with 10,000+ applicants and multiple rounds, execution time grows quadratically ($O(N^2)$), risking query timeout and high CPU usage.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Add explicit indexes on temporary tables immediately after their creation in `fn_run_allocation`:
  ```sql
  CREATE INDEX idx_temp_alloc_pref ON alloc_pref (applicant_id, department_id);
  CREATE INDEX idx_temp_alloc_held ON alloc_held (applicant_id, department_id);
  CREATE INDEX idx_temp_alloc_rejected ON alloc_rejected (applicant_id, department_id);
  ```

---

### Issue 5: Missing Partial Index for Queue Claim (`fn_claim_next` & `queue_entries`)
- **File Path**: 
  - `backend/supabase/migrations/0015_event_schema.sql` (Lines 183–185)
  - `backend/supabase/migrations/0016_queue_engine.sql` (Lines 180–196)
- **Line Numbers**: `0015_event_schema.sql:183-185`, `0016_queue_engine.sql:180-196`
- **Severity**: High / Performance & Concurrency Bottleneck
- **Detailed Problem Description**:
  `fn_claim_next` handles high-concurrency pull-based applicant claims across interview panels using:
  ```sql
  SELECT q.* INTO v_entry
    FROM queue_entries q
   WHERE q.cycle_id = v_panel.cycle_id
     AND q.state    = 'waiting'
     AND q.track_id IN (SELECT track_id FROM panel_tracks WHERE panel_id = p_panel_id)
     AND NOT EXISTS (...)
   ORDER BY q.priority DESC, q.enqueued_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;
  ```
  The index created in `0015_event_schema.sql` is:
  `CREATE INDEX idx_queue_claim ON queue_entries (cycle_id, track_id, priority DESC, enqueued_at ASC);`
  Notice that `state` is NOT part of the index key or filter condition!
  As applicants complete interviews, `queue_entries` accumulates thousands of rows in states like `called`, `in_interview`, `done`, `parked`, `skipped`, and `withdrawn`. Because the index includes all entries regardless of `state`, PostgreSQL must scan past thousands of non-waiting index entries before encountering a row where `state = 'waiting'`. Under `FOR UPDATE SKIP LOCKED`, this causes high disk I/O and index scan overhead during live event operations.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Replace or supplement `idx_queue_claim` with a partial index filtered specifically on `state = 'waiting'`:
  ```sql
  CREATE INDEX idx_queue_waiting_claim ON queue_entries (cycle_id, track_id, priority DESC, enqueued_at ASC)
    WHERE state = 'waiting';
  ```

---

### Issue 6: Savepoint Overhead and Blanket Exception Catching in Bulk Reconciliation (`fn_bulk_reconcile`)
- **File Path**: `backend/supabase/migrations/0030_bulk_reconcile.sql`
- **Line Numbers**: 34–54
- **Severity**: Medium
- **Detailed Problem Description**:
  `fn_bulk_reconcile` processes paper fallback rosters in batches:
  ```sql
  FOREACH v_id IN ARRAY p_applicant_ids
  LOOP
    BEGIN
      SELECT * INTO v_rec FROM fn_check_in(p_applicant_id := v_id, ...);
      ...
    EXCEPTION WHEN OTHERS THEN
      applicant_id := v_id;
      outcome := 'error: ' || SQLERRM;
      ...
      RETURN NEXT;
    END;
  END LOOP;
  ```
  In PL/pgSQL, a `BEGIN ... EXCEPTION WHEN OTHERS THEN` block inside a loop creates an internal transaction savepoint for every array element. For a paper roster reconciliation of 500 applicants, creating and destroying 500 savepoints introduces substantial memory and transaction manager overhead.
  Furthermore, catching `WHEN OTHERS` swallows system-level errors (e.g. database serialization failure, deadlock, connection termination, or memory exhaustion), converting critical database failures into string outputs (`'error: ...'`) rather than allowing appropriate transaction rollbacks.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Restrict exception handling to anticipated application exceptions (e.g. `ERRCODE = 'raise_exception'`), or perform batch check-in logic without per-item PL/pgSQL exception blocks where transactional integrity of the batch is desired.

---

### Issue 7: Incomplete State Reconciliation in Consistency Job (`fn_check_consistency`)
- **File Path**: `backend/supabase/migrations/0031_consistency_and_anonymisation.sql`
- **Line Numbers**: 23–47
- **Severity**: Medium / Technical Debt
- **Detailed Problem Description**:
  `fn_check_consistency(p_cycle_id uuid)` is designed as a resilience recovery job to detect and fix state discrepancies between `applicants.state` and event tables.
  However, the implementation only checks a single specific edge case:
  ```sql
  IF v_row.queue_state IS NOT NULL AND v_row.projected_state = 'checked_in' AND v_row.queue_state = 'waiting' THEN
    v_true_state := 'queued';
    ...
  END IF;
  ```
  The function ignores all other state transitions and potential corruptions (e.g. applicant marked `called` when panel was closed, `in_interview` when interview was voided, or `queued` when queue entry was withdrawn).
  The comment on line 29 notes `-- Simplistic check for demonstration of resilience recovery`. Leaving this incomplete function in production creates false confidence that state drift is being automatically reconciled by cron jobs when it is not.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Expand `fn_check_consistency` into a comprehensive state reconciliation procedure that checks:
  1. `applicants.state` vs latest `interviews.status` (`in_interview`, `complete`, `voided`).
  2. `applicants.state` vs latest `queue_entries.state` (`waiting`, `called`, `parked`, `skipped`).
  3. `applicants.state` vs `check_ins` (`checked_in`).

---

### Issue 8: Subquery Execution Overhead in RLS Capability Check (`fn_has_capability`)
- **File Path**: `backend/supabase/migrations/0008_rls.sql`
- **Line Numbers**: 158–170
- **Severity**: High / Performance Bottleneck
- **Detailed Problem Description**:
  `fn_has_capability(p_cycle_id uuid, p_capability text)` is used extensively across RLS policies (e.g., `applicant_staff_select`, `department_staff_select`, `audit_privileged_select`, `snapshot_privileged`, `offer_privileged`).
  The function definition:
  ```sql
  CREATE OR REPLACE FUNCTION fn_has_capability(p_cycle_id uuid, p_capability text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
      SELECT 1
        FROM memberships m
        JOIN role_capabilities rc ON rc.role = m.role
       WHERE m.user_id    = fn_current_user_id()
         AND m.cycle_id   = p_cycle_id
         AND m.revoked_at IS NULL
         AND rc.capability = p_capability
    )
  $$;
  ```
  When an authorized staff member queries a table with thousands of rows (e.g. `SELECT * FROM applicants WHERE cycle_id = ...`), PostgreSQL evaluates `fn_has_capability` for *every candidate row*.
  Even though the function is marked `STABLE`, PostgreSQL does not cache function return values across different row evaluations when column values (`cycle_id`) are passed. This results in thousands of subqueries joining `memberships` and `role_capabilities` per HTTP request.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Refactor RLS policies to evaluate user permissions once per query using subquery expressions rather than per-row function calls, or cache user capabilities in session GUC variables during authentication:
  ```sql
  CREATE POLICY applicant_staff_select ON applicants FOR SELECT
    USING (
      cycle_id IN (
        SELECT m.cycle_id 
          FROM memberships m
          JOIN role_capabilities rc ON rc.role = m.role
         WHERE m.user_id = fn_current_user_id()
           AND m.revoked_at IS NULL
           AND rc.capability = 'applicant.view'
      )
    );
  ```

---

### Issue 9: Unbounded Memory Allocation in Lock Snapshot (`fn_confirm_lock`)
- **File Path**: `backend/supabase/migrations/0030_lock_offers_cascade.sql`
- **Line Numbers**: 145–175
- **Severity**: Medium / Scalability
- **Detailed Problem Description**:
  In `fn_confirm_lock(p_cycle_id uuid)`, the dual-control lock confirmation generates an immutable JSON snapshot of all decisions in a cycle:
  ```sql
  SELECT jsonb_agg(row ORDER BY row ->> 'display_id'), count(*)
    INTO v_payload, v_count
    FROM ( SELECT jsonb_build_object(...) AS row FROM current_decisions ... ) rows;
  ```
  For large cycles with tens of thousands of applicants, constructing a single in-memory `jsonb_agg` array consumes significant RAM in PostgreSQL backend processes (`work_mem`).
  Executing `convert_to(coalesce(v_payload::text, '[]'), 'UTF8')` serializes the massive JSONB object into a single text string before hashing, risking out-of-memory errors or severe garbage collection pauses in PostgreSQL.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Compute the checksum incrementally over ordered decision rows using `sha256` aggregates (e.g. aggregating row hashes using `string_agg(encode(sha256(...), 'hex'), '')`) or store the snapshot as compressed payload chunks rather than a single monolithic JSONB column.

---

### Issue 10: PL/pgSQL Exception Block Overhead in Security Audit Logging (`fn_audit`)
- **File Path**: `backend/supabase/migrations/0012_harden_context_accessors.sql`
- **Line Numbers**: 88–129
- **Severity**: Technical Debt / Security Optimization
- **Detailed Problem Description**:
  Migration 0012 successfully hardened security context accessors (`fn_current_user_id`, `fn_current_applicant_id`) so that malformed UUID inputs return `NULL` (fail-closed) rather than aborting transactions.
  However, in `fn_audit` (lines 103–113):
  ```sql
  BEGIN
    v_role := nullif(current_setting('app.actor_role', true), '')::role_name;
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;

  BEGIN
    v_ip := nullif(current_setting('app.client_ip', true), '')::inet;
  EXCEPTION WHEN others THEN
    v_ip := NULL;
  END;
  ```
  `fn_audit` is invoked by almost every state transition and write operation in the system. Wrapping optional context setting casts in PL/pgSQL `BEGIN ... EXCEPTION` subtransactions adds subtransaction allocation overhead to every audit log write under heavy concurrent load.
- **Concrete Recommended Fix / Refactoring Strategy**:
  Utilize PostgreSQL 16+ safe casting functions (e.g., `pg_input_is_valid`) or SQL regex validation before casting, avoiding PL/pgSQL exception handling overhead:
  ```sql
  IF current_setting('app.client_ip', true) ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$' THEN
    v_ip := current_setting('app.client_ip', true)::inet;
  ELSE
    v_ip := NULL;
  END IF;
  ```

---

## Conclusion & Action Plan
The database schema and stored procedures display high technical rigor, explicit fail-closed RLS policies, and effective state transition enforcement. Implementing the recommendations above—specifically fixing `migrate.mjs` transaction boundaries, resolving migration filename numbering, indexing temporary tables in `fn_run_allocation`, and optimizing RLS capability evaluation—will ensure long-term stability and high throughput under production load.
