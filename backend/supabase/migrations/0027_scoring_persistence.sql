-- 0027 — Persisted scores, flags and the review queue
--
-- FR-SCR-005: the adjustment is computed at REVIEW TIME against the complete cycle
-- distribution, never at submission. It depends on data that does not exist until everyone has
-- finished, so computing it early would produce a number that changes underneath a decision.
--
-- Everything is persisted rather than computed on read (FR-SCR-004). Three reasons, and the
-- third is the important one:
--   1. the review meeting reads these repeatedly and must not pay for a recomputation
--   2. allocation must run against a frozen input, or "run it twice" proves nothing
--   3. an appeal six months later must be answerable with the numbers that were ACTUALLY used,
--      not with whatever the formula produces today
--
-- Refs: FR-SCR-004..014, E2, E3

BEGIN;

-- One row per computation. Keeping the run rather than overwriting means a disputed result can
-- be traced to the exact cohort statistics it was decided against.
CREATE TABLE score_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id      uuid NOT NULL REFERENCES cycles(id),
  cohort_mean   numeric(6, 3) NOT NULL,
  shrinkage_k   smallint NOT NULL,
  evaluation_count int NOT NULL,
  computed_by   uuid REFERENCES users(id),
  computed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_score_runs_cycle ON score_runs (cycle_id, computed_at DESC);


CREATE TABLE applicant_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  score_run_id     uuid NOT NULL REFERENCES score_runs(id) ON DELETE CASCADE,
  cycle_id         uuid NOT NULL REFERENCES cycles(id),
  applicant_id     uuid NOT NULL REFERENCES applicants(id),

  -- Both retained and both displayed side by side (FR-SCR-014). The review meeting must see
  -- what actually happened, not only what the maths concluded.
  raw_mean         numeric(6, 3) NOT NULL,
  final_score      numeric(6, 3) NOT NULL,

  evaluation_count smallint NOT NULL,
  -- FR-DEC-006 level 3: agreement breaks ties, so the spread is a ranking input, not a
  -- diagnostic.
  score_spread     numeric(6, 3) NOT NULL DEFAULT 0,
  -- FR-DEC-006 level 2.
  recommendation_count smallint NOT NULL DEFAULT 0,

  flags            text[] NOT NULL DEFAULT '{}',

  UNIQUE (score_run_id, applicant_id)
);

CREATE INDEX idx_applicant_scores_lookup ON applicant_scores (cycle_id, final_score DESC);
CREATE INDEX idx_applicant_scores_run ON applicant_scores (score_run_id);


-- ── Compute the adjustment ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_compute_adjustment(p_cycle_id uuid)
RETURNS score_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run         score_runs;
  v_cohort_mean numeric;
  v_k           smallint;
  v_count       int;
  v_floor_frac  numeric;
BEGIN
  SELECT coalesce((config ->> 'shrinkage_k')::smallint, 5),
         coalesce((config ->> 'criterion_floor_fraction')::numeric, 0.25)
    INTO v_k, v_floor_frac
    FROM cycles WHERE id = p_cycle_id;

  -- Only SUBMITTED, non-waived evaluations count. A waived evaluation records an absence with
  -- a reason; including it would treat "nobody scored this" as a score.
  SELECT count(*), avg(raw_score) INTO v_count, v_cohort_mean
    FROM evaluations
   WHERE cycle_id = p_cycle_id AND submitted_at IS NOT NULL AND waived_by IS NULL;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: no submitted evaluations to score'
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO score_runs (cycle_id, cohort_mean, shrinkage_k, evaluation_count, computed_by)
  VALUES (p_cycle_id, round(v_cohort_mean, 3), v_k, v_count, fn_current_user_id())
  RETURNING * INTO v_run;

  -- Per-interviewer bias, then shrinkage. Written back onto the evaluation so the weight used
  -- is auditable per score (FR-SCR-004) — "why is my adjusted score lower than my raw" has to
  -- be answerable without re-deriving the whole cohort.
  WITH interviewer_stats AS (
    SELECT interviewer_id,
           count(*) AS n,
           avg(raw_score) AS mean
      FROM evaluations
     WHERE cycle_id = p_cycle_id AND submitted_at IS NOT NULL AND waived_by IS NULL
     GROUP BY interviewer_id
  ), shrunk AS (
    SELECT e.id,
           (s.n::numeric / (s.n + v_k)) AS w,
           (s.mean - v_cohort_mean) AS bias
      FROM evaluations e
      JOIN interviewer_stats s ON s.interviewer_id = e.interviewer_id
     WHERE e.cycle_id = p_cycle_id AND e.submitted_at IS NOT NULL AND e.waived_by IS NULL
  )
  UPDATE evaluations e
     SET adjusted_score   = round(e.raw_score - (shrunk.w * shrunk.bias), 2),
         shrinkage_weight = round(shrunk.w, 3)
    FROM shrunk
   WHERE e.id = shrunk.id;

  -- Applicant aggregates, flags included.
  --
  -- CRITERION_FLOOR is expressed as a FRACTION of the rubric scale rather than a literal
  -- "<= 2". FR-SCR-008 assumes a 5-point scale; our rubrics are configurable, so 0.25 is
  -- exactly "<= 2" on 1-5 and generalises to any scale.
  INSERT INTO applicant_scores (
    score_run_id, cycle_id, applicant_id, raw_mean, final_score,
    evaluation_count, score_spread, recommendation_count, flags
  )
  SELECT
    v_run.id,
    p_cycle_id,
    i.applicant_id,
    round(avg(e.raw_score), 3),
    round(avg(e.adjusted_score), 3),
    count(*),
    round(coalesce(max(e.adjusted_score) - min(e.adjusted_score), 0), 3),
    count(*) FILTER (WHERE e.recommended_dept_id IS NOT NULL),
    (
      ARRAY[]::text[]
      || CASE WHEN count(*) = 1 THEN ARRAY['SINGLE_EVALUATOR'] ELSE ARRAY[]::text[] END
      || CASE WHEN count(*) >= 2
                AND (max(e.adjusted_score) - min(e.adjusted_score))
                    > coalesce((c.config ->> 'disagreement_threshold')::numeric, 20)
              THEN ARRAY['HIGH_DISAGREEMENT'] ELSE ARRAY[]::text[] END
      || CASE WHEN EXISTS (
                  SELECT 1
                    FROM score_items si
                    JOIN rubric_criteria rc ON rc.id = si.criterion_id
                    JOIN rubrics r ON r.id = rc.rubric_id
                    JOIN evaluations e2 ON e2.id = si.evaluation_id
                   WHERE e2.interview_id = i.id
                     AND e2.submitted_at IS NOT NULL
                     AND (si.score - r.scale_min)::numeric / (r.scale_max - r.scale_min)
                         <= v_floor_frac
                ) THEN ARRAY['CRITERION_FLOOR'] ELSE ARRAY[]::text[] END
      || CASE WHEN bool_and(
                  (SELECT count(*) FROM evaluations e3
                    WHERE e3.interviewer_id = e.interviewer_id
                      AND e3.cycle_id = p_cycle_id
                      AND e3.submitted_at IS NOT NULL AND e3.waived_by IS NULL)
                  < coalesce((c.config ->> 'low_confidence_n')::int, 5)
                ) THEN ARRAY['LOW_CONFIDENCE'] ELSE ARRAY[]::text[] END
    )
  FROM interviews i
  JOIN evaluations e ON e.interview_id = i.id
                    AND e.submitted_at IS NOT NULL AND e.waived_by IS NULL
  JOIN cycles c ON c.id = p_cycle_id
  WHERE i.cycle_id = p_cycle_id
    AND i.status = 'complete'
  GROUP BY i.applicant_id, i.id, c.config;

  PERFORM fn_audit(
    p_cycle_id, 'scoring.computed', 'score_run', v_run.id,
    NULL,
    jsonb_build_object('cohort_mean', v_run.cohort_mean, 'evaluations', v_count, 'k', v_k),
    NULL
  );

  RETURN v_run;
END $$;

COMMENT ON FUNCTION fn_compute_adjustment IS
  'Empirical-Bayes shrinkage over the complete cycle distribution. Computed at review time, never at submission (FR-SCR-005). Persisted so allocation runs against a frozen input.';


-- ── The review queue (FR-SCR-011) ───────────────────────────────────────────────────────
--
-- Rank within department, banded RELATIVE TO CAPACITY. Absolute cutoffs need recalibrating
-- every cycle and were miscalibrated in v1 (E2); rank scales to any cohort automatically.
CREATE OR REPLACE FUNCTION fn_review_queue(p_cycle_id uuid, p_score_run_id uuid DEFAULT NULL)
RETURNS TABLE (
  department_id   uuid,
  department_name text,
  capacity        smallint,
  applicant_id    uuid,
  display_id      text,
  full_name       text,
  preference_rank smallint,
  final_score     numeric,
  raw_mean        numeric,
  score_spread    numeric,
  recommendation_count smallint,
  flags           text[],
  rank_in_department int,
  band            text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_run    uuid;
  v_clear  numeric;
  v_discuss numeric;
BEGIN
  v_run := coalesce(
    p_score_run_id,
    (SELECT id FROM score_runs WHERE cycle_id = p_cycle_id ORDER BY computed_at DESC LIMIT 1)
  );

  IF v_run IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAILED: no score run — compute the adjustment first'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT coalesce((config ->> 'band_clear_multiplier')::numeric, 0.75),
         coalesce((config ->> 'band_discuss_multiplier')::numeric, 2.0)
    INTO v_clear, v_discuss
    FROM cycles WHERE id = p_cycle_id;

  RETURN QUERY
  WITH ranked AS (
    SELECT
      d.id AS dept_id, d.name AS dept_name, d.capacity AS dept_capacity,
      a.id AS app_id, a.display_id AS app_display, a.full_name AS app_name,
      ap.rank AS pref_rank,
      s.final_score AS score, s.raw_mean AS raw, s.score_spread AS spread,
      s.recommendation_count AS recs, s.flags AS app_flags,
      -- The SAME ordering allocation uses (FR-DEC-006). A review queue ordered differently
      -- from the allocation would have the meeting discussing a ranking the algorithm then
      -- ignores.
      row_number() OVER (
        PARTITION BY d.id
        ORDER BY s.final_score DESC,
                 s.recommendation_count DESC,
                 s.score_spread ASC,
                 a.submitted_at ASC,
                 a.id ASC
      )::int AS rnk
    FROM applicant_preferences ap
    JOIN departments d ON d.id = ap.department_id AND d.is_active
    JOIN applicants  a ON a.id = ap.applicant_id
    JOIN applicant_scores s ON s.applicant_id = a.id AND s.score_run_id = v_run
    WHERE ap.cycle_id = p_cycle_id
      AND a.state NOT IN ('withdrawn', 'screened_out', 'no_show')
  )
  SELECT
    r.dept_id, r.dept_name, r.dept_capacity, r.app_id, r.app_display, r.app_name,
    r.pref_rank, r.score, r.raw, r.spread, r.recs, r.app_flags, r.rnk,
    CASE
      -- FR-SCR-013: auto-excluded irrespective of rank, subject to override. Checked first —
      -- a criterion floor is a substantive concern that ranking first does not answer.
      WHEN 'CRITERION_FLOOR' = ANY(r.app_flags) THEN 'excluded'
      WHEN r.dept_capacity IS NULL THEN 'discuss'
      WHEN r.rnk > r.dept_capacity * v_discuss THEN 'below'
      -- FR-SCR-012: any flag forces a discussion regardless of rank.
      WHEN array_length(r.app_flags, 1) > 0 THEN 'discuss'
      WHEN r.rnk <= r.dept_capacity * v_clear THEN 'clear'
      ELSE 'discuss'
    END
  FROM ranked r
  ORDER BY r.dept_name, r.rnk;
END $$;

GRANT EXECUTE ON FUNCTION fn_review_queue(uuid, uuid) TO rms_app;


ALTER TABLE score_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicant_scores ENABLE ROW LEVEL SECURITY;

-- Scores are Super Admin and Auditor only. The Coordinator runs the floor and must not see
-- them — that separation is the entire reason the role exists.
CREATE POLICY score_run_privileged ON score_runs FOR SELECT
  USING (fn_has_capability(cycle_id, 'aggregates.view'));

CREATE POLICY applicant_scores_privileged ON applicant_scores FOR SELECT
  USING (fn_has_capability(cycle_id, 'evaluation.view_all'));

COMMIT;
