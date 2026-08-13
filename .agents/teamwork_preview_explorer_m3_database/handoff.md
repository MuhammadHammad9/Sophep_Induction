# Handoff Report — Database Schema & SQL Audit (`m3_database`)

## 1. Observation
Direct observations from analyzing database migration scripts, stored procedures, RLS policies, index definitions, and `migrate.mjs`:

1. **Migration Naming Duplication**:
   - `backend/supabase/migrations/0030_bulk_reconcile.sql`
   - `backend/supabase/migrations/0030_lock_offers_cascade.sql`
   - `backend/supabase/migrations/0031_consistency_and_anonymisation.sql`
   - `backend/supabase/migrations/0031_policy_subquery_visibility.sql`
   - `backend/scripts/migrate.mjs:51-53`: `const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()`

2. **Migration Ledger Runner Transaction Boundary**:
   - `backend/scripts/migrate.mjs:77-80`:
     ```javascript
     await sql.unsafe(body)
     await sql`
       INSERT INTO schema_migrations (filename, checksum) VALUES (${file}, ${checksum})
     `
     ```

3. **Anonymisation Cycle Age Calculation**:
   - `backend/supabase/migrations/0031_consistency_and_anonymisation.sql:64-69`:
     ```sql
     SELECT array_agg(id) INTO v_archived_cycles
     FROM cycles
     WHERE state = 'archived' 
       AND (SELECT min(created_at) FROM stages WHERE cycle_id = cycles.id) < now() - interval '2 years';
     ```

4. **Temporary Table Operations in Allocation Loop**:
   - `backend/supabase/migrations/0028_allocation.sql:170-202 & 217-282`: `alloc_pref`, `alloc_held`, `alloc_rejected`, `alloc_round` created without indexes on `(applicant_id, department_id)`.

5. **Queue Claim Indexing**:
   - `backend/supabase/migrations/0015_event_schema.sql:183-185`: `CREATE INDEX idx_queue_claim ON queue_entries (cycle_id, track_id, priority DESC, enqueued_at ASC);`
   - `backend/supabase/migrations/0016_queue_engine.sql:180-196`: `SELECT q.* FROM queue_entries q WHERE q.cycle_id = ... AND q.state = 'waiting' ORDER BY q.priority DESC, q.enqueued_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;`

6. **Savepoints in Bulk Reconciliation**:
   - `backend/supabase/migrations/0030_bulk_reconcile.sql:34-54`: `FOREACH v_id IN ARRAY p_applicant_ids LOOP BEGIN ... EXCEPTION WHEN OTHERS THEN ... END; END LOOP;`

7. **Consistency Verification Function Scope**:
   - `backend/supabase/migrations/0031_consistency_and_anonymisation.sql:23-47`: `fn_check_consistency` only checks `v_row.queue_state IS NOT NULL AND v_row.projected_state = 'checked_in' AND v_row.queue_state = 'waiting'`.

8. **RLS Capability Function Per-Row Evaluation**:
   - `backend/supabase/migrations/0008_rls.sql:158-170`: `fn_has_capability` executes `SELECT EXISTS (SELECT 1 FROM memberships m JOIN role_capabilities rc ...)` per candidate row.

9. **Lock Confirmation Payload Aggregation**:
   - `backend/supabase/migrations/0030_lock_offers_cascade.sql:145-175`: `SELECT jsonb_agg(row ORDER BY row ->> 'display_id'), count(*)` loads all applicant decisions for a cycle into memory.

10. **Fail-Closed Context Accessors**:
    - `backend/supabase/migrations/0012_harden_context_accessors.sql:26-79`: `fn_current_user_id` and `fn_current_applicant_id` return `NULL` on malformed context strings.

---

## 2. Logic Chain
1. *Observation 1 & `migrate.mjs:51`*: `readdirSync().sort()` sorts duplicate prefix files alphabetically by suffix (`bulk_reconcile` before `lock_offers_cascade`). Standard CLI migration tools fail or misorder duplicate integer prefixes.
2. *Observation 2 & `migrate.mjs:77-80`*: DDL is executed outside a single JavaScript transaction block with `INSERT INTO schema_migrations`. A process crash after DDL execution leaves the schema modified but unrecorded in the ledger, causing re-run failures.
3. *Observation 3 & `0031_consistency_and_anonymisation.sql:64`*: `min(created_at)` from `stages` measures stage setup time rather than when the cycle was archived, leading to immediate anonymisation of recently archived cycles.
4. *Observation 4 & `0028_allocation.sql:170-282`*: Unindexed temporary tables inside iterative Gale-Shapley matching loops cause full sequential scans per iteration, degrading to $O(N^2)$ performance.
5. *Observation 5 & `0015_event_schema.sql:183`*: Index `idx_queue_claim` lacks a partial filter on `state = 'waiting'`, forcing `FOR UPDATE SKIP LOCKED` to scan past non-waiting entries.
6. *Observation 6 & `0030_bulk_reconcile.sql:34`*: PL/pgSQL `BEGIN ... EXCEPTION WHEN OTHERS` inside loops creates per-element savepoints and catches fatal system exceptions.
7. *Observation 7 & `0031_consistency_and_anonymisation.sql:23`*: `fn_check_consistency` covers only one specific state mismatch out of all possible queue/interview/checkin states.
8. *Observation 8 & `0008_rls.sql:158`*: `fn_has_capability` called inside row-level security predicates executes a join on `memberships` for every row fetched.
9. *Observation 9 & `0030_lock_offers_cascade.sql:145`*: `jsonb_agg` loads cycle-wide decisions into a single JSON object in memory, risking `work_mem` exhaustion.
10. *Observation 10 & `0012_harden_context_accessors.sql:26`*: Malformed UUIDs yield `NULL`, guaranteeing zero-row access under RLS (R-014 compliance).

---

## 3. Caveats
- No live database connection was executed during this read-only audit. Analysis is based on static code evaluation of SQL migrations and node scripts.
- Application-layer callers (TypeScript service layer) were inspected only for context binding interfaces and stored procedure invocation patterns.

---

## 4. Conclusion
The database schema and stored procedures exhibit exemplary security design (fail-closed context accessors, state machine protection, write-once audit logs). Addressing the 10 identified issues—specifically fixing the non-transactional ledger writes in `migrate.mjs`, unique migration prefix numbering, temporary table indexing in `fn_run_allocation`, partial indexing on `queue_entries`, and RLS capability inlining—will prevent production deadlocks, data corruption, and query performance bottlenecks.

Full detailed report is saved at `.agents/teamwork_preview_explorer_m3_database/analysis.md`.

---

## 5. Verification Method
1. **Migration File Inspection**:
   - Inspect files in `backend/supabase/migrations/` to verify duplicate prefixes `0030_*` and `0031_*`.
   - Inspect `backend/scripts/migrate.mjs` lines 75–85 to verify ledger insertion behavior.
2. **SQL Query Analysis**:
   - Inspect `backend/supabase/migrations/0028_allocation.sql` lines 170–282 for unindexed temporary tables.
   - Inspect `backend/supabase/migrations/0015_event_schema.sql` line 183 and `0016_queue_engine.sql` line 180 for partial index requirements.
   - Inspect `backend/supabase/migrations/0031_consistency_and_anonymisation.sql` lines 64–69 for stage `created_at` filtering in `fn_anonymise_old_data`.
3. **Invalidation Conditions**:
   - If `migrate.mjs` is updated to wrap migration execution and ledger entry in `sql.begin()`, Issue 2 is resolved.
   - If migration files are renumbered with unique prefixes, Issue 1 is resolved.
   - If temporary tables in `fn_run_allocation` have explicit indexes added, Issue 4 is resolved.
