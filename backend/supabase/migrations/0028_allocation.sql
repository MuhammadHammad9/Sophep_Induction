-- 0028 — Decisions and deterministic allocation
--
-- Fixes errata E8: v1 ranked applicants by score alone, and scores tie frequently on a coarse
-- rubric. Two runs over identical input could produce two DIFFERENT valid stable matchings.
-- "The algorithm decided" is only a defence if the algorithm decides the same thing every
-- time; otherwise the honest answer to "why was I ranked below someone with my score" is "you
-- weren't, until we re-ran it".
--
-- THE OUTPUT IS A PROPOSAL. The committee decides in an on-site meeting and announces the
-- result themselves. Deferred acceptance still earns its place — it gives that meeting a
-- defensible starting point that respects capacity and preference — but nothing becomes an
-- outcome because the algorithm said so. Every departure is an override with a written reason
-- (FR-DEC-009), and the meeting's reasoning becomes the record.
--
-- Refs: FR-DEC-001..009, DR-008, E8

BEGIN;

CREATE TYPE decision_outcome AS ENUM (
  'selected',
  'waitlisted',
  'rejected',
  'excluded'      -- CRITERION_FLOOR auto-exclusion (FR-SCR-013)
);

-- Versioned, never updated in place (DR-008). A superseded decision is retained so the record
-- shows what was proposed AND what the meeting changed it to.
CREATE TABLE decisions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  applicant_id   uuid NOT NULL REFERENCES applicants(id),
  version        int  NOT NULL DEFAULT 1,

  outcome        decision_outcome NOT NULL,
  department_id  uuid REFERENCES departments(id),
  waitlist_rank  int,

  -- TRUE while this is the algorithm's suggestion. Flipped to false by a human decision, so
  -- "did a person decide this, or did the machine?" is answerable per applicant rather than
  -- inferred from timestamps.
  is_proposal    boolean NOT NULL DEFAULT true,

  allocation_run_id uuid,
  decided_by     uuid REFERENCES users(id),
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (applicant_id, version),

  -- FR-DEC-014, enforced at the row rather than only in the dry run: a selected applicant
  -- without a department is a data error that must not be representable.
  CONSTRAINT selected_needs_department
    CHECK (outcome <> 'selected' OR department_id IS NOT NULL),

  -- A human override must say why. Without this the audit trail records that someone changed
  -- an outcome and not a word about their reasoning.
  CONSTRAINT override_needs_reason
    CHECK (is_proposal OR reason IS NOT NULL AND length(btrim(reason)) >= 5)
);

CREATE INDEX idx_decisions_current ON decisions (applicant_id, version DESC);
CREATE INDEX idx_decisions_cycle_outcome ON decisions (cycle_id, outcome);
CREATE INDEX idx_decisions_department ON decisions (department_id, waitlist_rank);

CREATE TABLE allocation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id     uuid NOT NULL REFERENCES cycles(id),
  score_run_id uuid NOT NULL REFERENCES score_runs(id),
  -- FR-DEC-007: a checksum over the ordered output. Two runs over unchanged input must
  -- produce the same digest, which is how "byte-identical" is actually asserted.
  result_checksum text NOT NULL,
  selected_count  int NOT NULL,
  waitlisted_count int NOT NULL,
  rejected_count   int NOT NULL,
  run_by       uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

/** The current decision for each applicant — the latest version. */
CREATE OR REPLACE VIEW current_decisions AS
  SELECT DISTINCT ON (applicant_id) *
    FROM decisions
   ORDER BY applicant_id, version DESC;


-- ── Pre-flight (FR-DEC-001..003, plus one) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_allocation_preflight(p_cycle_id uuid)
RETURNS TABLE (blocker text, detail text, entity_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- FR-DEC-001: every interview complete or explicitly voided.
  SELECT 'interview_incomplete', a.display_id || ' · ' || i.status::text, i.id
    FROM interviews i
    JOIN applicants a ON a.id = i.applicant_id
   WHERE i.cycle_id = p_cycle_id
     AND i.status NOT IN ('complete', 'voided')

  UNION ALL

  -- FR-DEC-002: shrinkage computed.
  SELECT 'shrinkage_not_computed', 'run fn_compute_adjustment first', NULL::uuid
   WHERE NOT EXISTS (SELECT 1 FROM score_runs WHERE cycle_id = p_cycle_id)

  UNION ALL

  -- FR-DEC-003: every active department has a capacity.
  SELECT 'department_without_capacity', d.name, d.id
    FROM departments d
   WHERE d.cycle_id = p_cycle_id AND d.is_active AND d.capacity IS NULL

  UNION ALL

  -- The fifth gate, added because the desk registration path (FR-CHK-010) creates applicants
  -- with NO ranked preferences — a walk-in with a queue behind them cannot fill in a form.
  --
  -- Deferred acceptance is APPLICANT-PROPOSING, so an empty preference list means proposing to
  -- nobody. Without this gate those applicants would be interviewed, scored, and then silently
  -- allocated nothing at all. Neither the spec nor the JSON covers this case.
  SELECT 'applicant_without_preferences', a.display_id, a.id
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id
     AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show')
     AND EXISTS (SELECT 1 FROM interviews i
                  WHERE i.applicant_id = a.id AND i.status = 'complete')
     AND NOT EXISTS (SELECT 1 FROM applicant_preferences ap WHERE ap.applicant_id = a.id)
$$;

GRANT EXECUTE ON FUNCTION fn_allocation_preflight(uuid) TO rms_app;


-- ── Allocation (FR-DEC-005..008) ────────────────────────────────────────────────────────
--
-- Applicant-proposing deferred acceptance (Gale-Shapley).
--
-- Properties it gives us, all of which matter in a dispute:
--   * STABLE — no applicant/department pair would both prefer each other
--   * APPLICANT-OPTIMAL among stable matchings
--   * EXPLAINABLE — for any outcome you can name which department rejected them and why
--   * DETERMINISTIC — the ordering is total, so re-runs are identical
CREATE OR REPLACE FUNCTION fn_run_allocation(p_cycle_id uuid)
RETURNS allocation_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_blockers    int;
  v_run         allocation_runs;
  v_score_run   uuid;
  v_proposals   int;
  v_version     int;
  v_checksum    text;
  v_selected    int;
  v_waitlisted  int;
  v_rejected    int;
BEGIN
  -- FR-DEC-004: an advisory lock scoped to the cycle. Two concurrent allocations would
  -- interleave writes and produce a matching that is neither run's result.
  IF NOT pg_try_advisory_xact_lock(hashtext('allocation:' || p_cycle_id::text)) THEN
    RAISE EXCEPTION 'ALLOCATION_IN_PROGRESS' USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO v_blockers FROM fn_allocation_preflight(p_cycle_id);
  IF v_blockers > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: % blocking item(s)', v_blockers
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT id INTO v_score_run
    FROM score_runs WHERE cycle_id = p_cycle_id ORDER BY computed_at DESC LIMIT 1;

  -- Working set, materialised so the loop reads a frozen snapshot. Reading live tables inside
  -- the loop would let a concurrent edit change the ranking midway through.
  CREATE TEMP TABLE alloc_pref ON COMMIT DROP AS
    SELECT ap.applicant_id,
           ap.department_id,
           ap.rank AS pref_rank,
           s.final_score,
           s.recommendation_count,
           s.score_spread,
           a.submitted_at,
           ('CRITERION_FLOOR' = ANY(s.flags)) AS excluded
      FROM applicant_preferences ap
      JOIN applicants a ON a.id = ap.applicant_id
      JOIN departments d ON d.id = ap.department_id AND d.is_active
      JOIN applicant_scores s ON s.applicant_id = ap.applicant_id AND s.score_run_id = v_score_run
     WHERE ap.cycle_id = p_cycle_id
       AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show');

  -- FR-SCR-013: CRITERION_FLOOR is auto-excluded irrespective of rank. Removed BEFORE the
  -- matching rather than filtered after, so an excluded applicant never displaces anyone.
  DELETE FROM alloc_pref WHERE excluded;

  CREATE INDEX idx_alloc_pref_app_rank ON alloc_pref (applicant_id, pref_rank);
  CREATE INDEX idx_alloc_pref_app_dept ON alloc_pref (applicant_id, department_id);

  -- ON COMMIT DROP belongs AFTER the column list.
  CREATE TEMP TABLE alloc_held (
    department_id uuid NOT NULL,
    applicant_id  uuid NOT NULL,
    PRIMARY KEY (applicant_id)
  ) ON COMMIT DROP;

  CREATE TEMP TABLE alloc_rejected (
    applicant_id  uuid NOT NULL,
    department_id uuid NOT NULL,
    PRIMARY KEY (applicant_id, department_id)
  ) ON COMMIT DROP;

  -- Created ONCE and truncated per pass. Creating a temp table inside the loop means DDL on
  -- every iteration and invalidates plpgsql's cached plans each time.
  CREATE TEMP TABLE alloc_round (
    applicant_id  uuid NOT NULL,
    department_id uuid NOT NULL,
    final_score   numeric,
    recommendation_count smallint,
    score_spread  numeric,
    submitted_at  timestamptz
  ) ON COMMIT DROP;

  -- The proposal loop. Each pass: every unmatched applicant proposes to their most-preferred
  -- department that has not yet rejected them; each department then keeps its best `capacity`
  -- proposals and rejects the rest.
  LOOP
    TRUNCATE alloc_round;

    INSERT INTO alloc_round (applicant_id, department_id, final_score,
                             recommendation_count, score_spread, submitted_at)
      SELECT DISTINCT ON (p.applicant_id)
             p.applicant_id, p.department_id, p.final_score,
             p.recommendation_count, p.score_spread, p.submitted_at
        FROM alloc_pref p
       WHERE NOT EXISTS (SELECT 1 FROM alloc_held h WHERE h.applicant_id = p.applicant_id)
         AND NOT EXISTS (SELECT 1 FROM alloc_rejected r
                          WHERE r.applicant_id = p.applicant_id
                            AND r.department_id = p.department_id)
       ORDER BY p.applicant_id, p.pref_rank ASC;

    SELECT count(*) INTO v_proposals FROM alloc_round;
    EXIT WHEN v_proposals = 0;

    -- Departments consider held candidates and new proposals together, and keep the best.
    -- Considering them together is what makes this deferred acceptance rather than
    -- first-come-first-served: a held candidate can be displaced by a better proposal.
    WITH pool AS (
      SELECT h.department_id, h.applicant_id, p.final_score,
             p.recommendation_count, p.score_spread, p.submitted_at
        FROM alloc_held h
        JOIN alloc_pref p ON p.applicant_id = h.applicant_id
                         AND p.department_id = h.department_id
      UNION ALL
      SELECT department_id, applicant_id, final_score,
             recommendation_count, score_spread, submitted_at
        FROM alloc_round
    ), ranked AS (
      SELECT pool.*,
             row_number() OVER (
               PARTITION BY pool.department_id
               -- FR-DEC-006, the TOTAL order. Levels 4 and 5 are arbitrary, and that is
               -- precisely the point: without them the ordering is partial and re-runs can
               -- differ (E8).
               ORDER BY pool.final_score DESC,
                        pool.recommendation_count DESC,
                        pool.score_spread ASC,
                        pool.submitted_at ASC,
                        pool.applicant_id ASC
             ) AS rnk,
             d.capacity
        FROM pool
        JOIN departments d ON d.id = pool.department_id
    )
    INSERT INTO alloc_rejected (applicant_id, department_id)
    SELECT applicant_id, department_id FROM ranked WHERE rnk > capacity
    ON CONFLICT DO NOTHING;

    -- Anyone rejected this round loses their hold.
    DELETE FROM alloc_held h
     USING alloc_rejected r
     WHERE h.applicant_id = r.applicant_id AND h.department_id = r.department_id;

    -- New holds for proposals that survived.
    INSERT INTO alloc_held (department_id, applicant_id)
    SELECT ar.department_id, ar.applicant_id
      FROM alloc_round ar
     WHERE NOT EXISTS (SELECT 1 FROM alloc_rejected r
                        WHERE r.applicant_id = ar.applicant_id
                          AND r.department_id = ar.department_id)
    ON CONFLICT (applicant_id) DO NOTHING;
  END LOOP;

  -- ── Write decisions ───────────────────────────────────────────────────────────────────
  SELECT coalesce(max(version), 0) + 1 INTO v_version
    FROM decisions WHERE cycle_id = p_cycle_id;

  INSERT INTO allocation_runs (
    cycle_id, score_run_id, result_checksum, selected_count, waitlisted_count, rejected_count, run_by
  ) VALUES (p_cycle_id, v_score_run, '', 0, 0, 0, fn_current_user_id())
  RETURNING * INTO v_run;

  -- Matched.
  INSERT INTO decisions (
    cycle_id, applicant_id, version, outcome, department_id, is_proposal, allocation_run_id
  )
  SELECT p_cycle_id, h.applicant_id, v_version, 'selected', h.department_id, true, v_run.id
    FROM alloc_held h;

  -- FR-DEC-008: unmatched applicants are waitlisted per department, ranked by the SAME
  -- ordering. Ranked against their top remaining preference so the cascade has somewhere to
  -- start.
  INSERT INTO decisions (
    cycle_id, applicant_id, version, outcome, department_id, waitlist_rank,
    is_proposal, allocation_run_id
  )
  SELECT p_cycle_id, w.applicant_id, v_version, 'waitlisted', w.department_id, w.rnk,
         true, v_run.id
    FROM (
      SELECT DISTINCT ON (p.applicant_id)
             p.applicant_id, p.department_id,
             row_number() OVER (
               PARTITION BY p.department_id
               ORDER BY p.final_score DESC, p.recommendation_count DESC,
                        p.score_spread ASC, p.submitted_at ASC, p.applicant_id ASC
             )::int AS rnk
        FROM alloc_pref p
       WHERE NOT EXISTS (SELECT 1 FROM alloc_held h WHERE h.applicant_id = p.applicant_id)
       ORDER BY p.applicant_id, p.pref_rank ASC
    ) w;

  -- Auto-excluded (FR-SCR-013). Recorded as a decision rather than an omission, so the reason
  -- is visible and the override path is obvious.
  INSERT INTO decisions (
    cycle_id, applicant_id, version, outcome, is_proposal, allocation_run_id, reason
  )
  SELECT p_cycle_id, s.applicant_id, v_version, 'excluded', true, v_run.id,
         'criterion floor — automatic, subject to override'
    FROM applicant_scores s
   WHERE s.score_run_id = v_score_run
     AND 'CRITERION_FLOOR' = ANY(s.flags)
  ON CONFLICT (applicant_id, version) DO NOTHING;

  -- FR-DEC-007: the checksum is over the ORDERED output, so two runs over unchanged input
  -- produce the same digest. Computed by fn_allocation_checksum, which uses the Postgres
  -- built-in sha256 rather than pgcrypto — Supabase installs pgcrypto outside this function's
  -- pinned search_path (see migration 0029).
  SELECT * INTO v_run FROM fn_set_allocation_checksum(v_run.id);

  v_checksum   := v_run.result_checksum;
  v_selected   := v_run.selected_count;
  v_waitlisted := v_run.waitlisted_count;
  v_rejected   := v_run.rejected_count;

  PERFORM fn_audit(
    p_cycle_id, 'allocation.run', 'allocation_run', v_run.id,
    NULL,
    jsonb_build_object('checksum', v_checksum, 'selected', v_selected,
                       'waitlisted', v_waitlisted, 'excluded', v_rejected,
                       'version', v_version),
    NULL
  );

  RETURN v_run;
END $$;

COMMENT ON FUNCTION fn_run_allocation IS
  'Deterministic applicant-proposing deferred acceptance. Output is a PROPOSAL — the committee decides. Total ordering per FR-DEC-006 so re-runs are identical (E8).';


-- ── Override (FR-DEC-009) ───────────────────────────────────────────────────────────────
-- Creates a NEW version and retains the prior one. The algorithm proposes, humans decide —
-- and the record shows both.
CREATE OR REPLACE FUNCTION fn_override_decision(
  p_applicant_id  uuid,
  p_outcome       decision_outcome,
  p_department_id uuid,
  p_reason        text
) RETURNS decisions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_current decisions;
  v_new     decisions;
  v_actor   uuid;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to override a decision'
      USING ERRCODE = 'raise_exception';
  END IF;

  v_actor := fn_current_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'an override must be attributed to an authenticated user'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_current FROM decisions
   WHERE applicant_id = p_applicant_id ORDER BY version DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no decision exists for applicant %', p_applicant_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Results are locked once dual control completes; changing one afterwards is a CORRECTION,
  -- which follows a different path and produces a distinct notice (FR-DEC-016).
  IF EXISTS (
    SELECT 1 FROM cycles
     WHERE id = v_current.cycle_id AND state IN ('results_locked', 'published', 'archived')
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: results are locked — use the correction path'
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO decisions (
    cycle_id, applicant_id, version, outcome, department_id,
    is_proposal, decided_by, reason, allocation_run_id
  ) VALUES (
    v_current.cycle_id, p_applicant_id, v_current.version + 1, p_outcome, p_department_id,
    false, v_actor, p_reason, v_current.allocation_run_id
  )
  RETURNING * INTO v_new;

  PERFORM fn_audit(
    v_current.cycle_id, 'decision.overridden', 'decision', v_new.id,
    jsonb_build_object('outcome', v_current.outcome, 'department_id', v_current.department_id,
                       'version', v_current.version),
    jsonb_build_object('outcome', v_new.outcome, 'department_id', v_new.department_id,
                       'version', v_new.version),
    p_reason
  );

  RETURN v_new;
END $$;


ALTER TABLE decisions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE allocation_runs ENABLE ROW LEVEL SECURITY;

-- An applicant sees their OWN decision, and only once results are published. Before that it is
-- a proposal, and showing someone a proposal as though it were an outcome would be the worst
-- possible reading of "never present a number you know is provisional as if it were final".
CREATE POLICY decision_self_select ON decisions FOR SELECT
  USING (
    applicant_id = fn_current_applicant_id()
    AND EXISTS (SELECT 1 FROM cycles c WHERE c.id = decisions.cycle_id AND c.state = 'published')
  );

CREATE POLICY decision_privileged ON decisions FOR SELECT
  USING (fn_has_capability(cycle_id, 'evaluation.view_all'));

CREATE POLICY allocation_run_privileged ON allocation_runs FOR SELECT
  USING (fn_has_capability(cycle_id, 'allocation.run')
      OR fn_has_capability(cycle_id, 'aggregates.view'));

COMMIT;
