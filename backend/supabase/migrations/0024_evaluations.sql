-- 0024 — Evaluations, revisions, waivers and the interview completion gate
--
-- Blind evaluation is the point of this whole subsystem, and it is enforced at the ROW level
-- (FR-INT-004). An interviewer's connection cannot read another interviewer's evaluation
-- regardless of what the API asks for — a frontend bug cannot leak it, and neither can a
-- rushed endpoint written next year by someone who never read the spec.
--
-- IMMUTABILITY WITH AN ESCAPE HATCH. A submitted evaluation is final (FR-INT-009), because a
-- score that can be quietly edited after the fact is not evidence. But people mistype, so a
-- 15-minute window creates a NEW REVISION with a mandatory reason and keeps the original.
-- After that, only a Super Admin can unlock, and the unlock is itself audited (FR-INT-010).
--
-- THE WAIVER exists because without it one interviewer going home disables their panel for the
-- rest of the day (FR-INT-012). It requires a written reason and names the waived interviewer.
--
-- Refs: FR-INT-004, FR-INT-007..013, FR-INT-017, E17

BEGIN;

CREATE TABLE evaluations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  interview_id   uuid NOT NULL REFERENCES interviews(id),
  interviewer_id uuid NOT NULL REFERENCES users(id),

  -- E17 / FR-INT-007: pinned at interview START, never at submit. Otherwise a rubric edited
  -- mid-session splits one panel across two scales and the two scores are not comparable.
  rubric_id      uuid NOT NULL REFERENCES rubrics(id),

  -- 0–100. Computed by fn_submit_evaluation from the weighted criterion scores, never
  -- supplied by the client — a caller-supplied score is a caller-chosen outcome.
  raw_score        numeric(5, 2),

  -- Phase 4 fills these. Both are stored so raw and adjusted can be shown SIDE BY SIDE
  -- (FR-SCR-014): the review meeting must see what actually happened, not only what the
  -- maths concluded.
  adjusted_score   numeric(5, 2),
  shrinkage_weight numeric(4, 3),

  remarks             text,
  recommended_dept_id uuid REFERENCES departments(id),

  submitted_at   timestamptz,
  revision       int NOT NULL DEFAULT 1,
  revision_reason text,

  -- A waived evaluation is a real row with no scores: the absence is recorded, attributed and
  -- explained, rather than being an unexplained gap in the data.
  waived_by      uuid REFERENCES users(id),
  waiver_reason  text,
  waived_at      timestamptz,

  created_at     timestamptz NOT NULL DEFAULT now(),

  -- FR-INT-008: at most one evaluation per interviewer per interview, per revision.
  UNIQUE (interview_id, interviewer_id, revision),
  CONSTRAINT waiver_needs_reason
    CHECK (waived_by IS NULL OR (waiver_reason IS NOT NULL AND length(btrim(waiver_reason)) >= 5)),
  CONSTRAINT revision_needs_reason
    CHECK (revision = 1 OR (revision_reason IS NOT NULL AND length(btrim(revision_reason)) >= 5))
);

CREATE INDEX idx_evaluations_interview ON evaluations (interview_id, revision DESC);
CREATE INDEX idx_evaluations_interviewer ON evaluations (interviewer_id, submitted_at DESC);
-- Phase 4's shrinkage needs every submitted score for a cycle.
CREATE INDEX idx_evaluations_cycle_scored ON evaluations (cycle_id)
  WHERE submitted_at IS NOT NULL AND waived_by IS NULL;


CREATE TABLE score_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  criterion_id  uuid NOT NULL REFERENCES rubric_criteria(id),
  score         smallint NOT NULL,
  note          text,
  UNIQUE (evaluation_id, criterion_id)
);

CREATE INDEX idx_score_items_evaluation ON score_items (evaluation_id);


-- ── Submission ──────────────────────────────────────────────────────────────────────────
--
-- Scores arrive as (criterion_id, score) pairs. The function validates every criterion is
-- present and in range, computes the weighted score itself, and writes everything in one
-- transaction.
--
-- FR-INT-020 blocks submission until EVERY criterion is scored. Enforced here as well as in
-- the UI, because a partially-scored evaluation silently changes what the weighted mean means.
CREATE OR REPLACE FUNCTION fn_submit_evaluation(
  p_interview_id   uuid,
  p_interviewer_id uuid,
  p_scores         jsonb,           -- [{"criterion_id": "...", "score": 4, "note": "..."}]
  p_remarks        text DEFAULT NULL,
  p_recommended_dept_id uuid DEFAULT NULL
) RETURNS evaluations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_interview  interviews;
  v_rubric_id  uuid;
  v_eval       evaluations;
  v_expected   int;
  v_provided   int;
  v_weighted   numeric;
  v_scale_min  smallint;
  v_scale_max  smallint;
  v_item       jsonb;
BEGIN
  SELECT * INTO v_interview FROM interviews WHERE id = p_interview_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interview % not found', p_interview_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_interview.status NOT IN ('in_progress', 'awaiting_evaluations') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: interview is %', v_interview.status
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Only a member of THIS panel may evaluate. Checked here, not only by RLS, so the error is
  -- a clear refusal rather than a constraint violation further down.
  IF NOT EXISTS (
    SELECT 1 FROM panel_members pm
     WHERE pm.panel_id = v_interview.panel_id
       AND pm.interviewer_id = p_interviewer_id
  ) THEN
    RAISE EXCEPTION 'RECUSAL_CONFLICT: not a member of this panel' USING ERRCODE = 'raise_exception';
  END IF;

  -- FR-INT-008: one evaluation per interviewer per interview.
  IF EXISTS (
    SELECT 1 FROM evaluations
     WHERE interview_id = p_interview_id
       AND interviewer_id = p_interviewer_id
       AND submitted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: you have already submitted for this interview'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The rubric pinned at interview start (E17). Falling back to the active rubric here would
  -- reintroduce exactly the mid-session split the pinning prevents.
  v_rubric_id := v_interview.rubric_id;
  IF v_rubric_id IS NULL THEN
    RAISE EXCEPTION 'interview % has no pinned rubric — it was not started correctly',
      p_interview_id USING ERRCODE = 'raise_exception';
  END IF;

  SELECT scale_min, scale_max INTO v_scale_min, v_scale_max
    FROM rubrics WHERE id = v_rubric_id;

  SELECT count(*) INTO v_expected FROM rubric_criteria WHERE rubric_id = v_rubric_id;
  SELECT count(*) INTO v_provided FROM jsonb_array_elements(p_scores);

  -- FR-INT-020.
  IF v_provided <> v_expected THEN
    RAISE EXCEPTION 'every criterion must be scored: expected %, got %', v_expected, v_provided
      USING ERRCODE = 'raise_exception';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_scores) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM rubric_criteria
       WHERE id = (v_item ->> 'criterion_id')::uuid AND rubric_id = v_rubric_id
    ) THEN
      RAISE EXCEPTION 'criterion % does not belong to the pinned rubric',
        v_item ->> 'criterion_id' USING ERRCODE = 'raise_exception';
    END IF;

    IF (v_item ->> 'score')::smallint NOT BETWEEN v_scale_min AND v_scale_max THEN
      RAISE EXCEPTION 'score % is outside the rubric scale %–%',
        v_item ->> 'score', v_scale_min, v_scale_max USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  INSERT INTO evaluations (
    cycle_id, interview_id, interviewer_id, rubric_id, remarks, recommended_dept_id, submitted_at
  ) VALUES (
    v_interview.cycle_id, p_interview_id, p_interviewer_id, v_rubric_id,
    p_remarks, p_recommended_dept_id, now()
  )
  RETURNING * INTO v_eval;

  INSERT INTO score_items (evaluation_id, criterion_id, score, note)
  SELECT v_eval.id, (e ->> 'criterion_id')::uuid, (e ->> 'score')::smallint, e ->> 'note'
    FROM jsonb_array_elements(p_scores) e;

  -- FR-SCR-001: weighted mean, normalised to 0–100.
  --
  -- Normalising by the SCALE, not by the maximum score, is what makes a 1–5 rubric and a
  -- 1–10 rubric comparable: (score − min) / (max − min) puts every criterion on 0–1 before
  -- weighting. Dividing by max alone would give a rubric with min=1 a floor of 20%.
  SELECT sum(
           ((si.score - v_scale_min)::numeric / (v_scale_max - v_scale_min)) * rc.weight
         ) INTO v_weighted
    FROM score_items si
    JOIN rubric_criteria rc ON rc.id = si.criterion_id
   WHERE si.evaluation_id = v_eval.id;

  UPDATE evaluations SET raw_score = round(v_weighted, 2)
   WHERE id = v_eval.id RETURNING * INTO v_eval;

  PERFORM fn_audit(
    v_interview.cycle_id, 'evaluation.submitted', 'evaluation', v_eval.id,
    NULL,
    jsonb_build_object('interview_id', p_interview_id, 'raw_score', v_eval.raw_score),
    NULL
  );

  PERFORM fn_check_interview_complete(p_interview_id);

  RETURN v_eval;
END $$;


-- ── The completion gate (FR-INT-011) ────────────────────────────────────────────────────
--
-- An interview completes only when EVERY panel member has submitted, or a Coordinator has
-- waived a specific outstanding evaluation. Until then the panel sits in
-- `awaiting_evaluations` and cannot claim (FR-INT-013).
--
-- Blocking is deliberate. The alternative is discovering eleven missing evaluations three days
-- later, when the interviewers no longer remember the candidates and the scores are guesses.
CREATE OR REPLACE FUNCTION fn_check_interview_complete(p_interview_id uuid)
RETURNS interviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_interview  interviews;
  v_members    int;
  v_accounted  int;
  v_duration   int;
BEGIN
  SELECT * INTO v_interview FROM interviews WHERE id = p_interview_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interview % not found', p_interview_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_interview.status IN ('complete', 'voided') THEN
    RETURN v_interview;
  END IF;

  SELECT count(*) INTO v_members
    FROM panel_members WHERE panel_id = v_interview.panel_id AND left_at IS NULL;

  -- Submitted OR waived both count as accounted for.
  SELECT count(*) INTO v_accounted
    FROM evaluations
   WHERE interview_id = p_interview_id
     AND (submitted_at IS NOT NULL OR waived_by IS NOT NULL);

  IF v_accounted >= v_members THEN
    UPDATE interviews SET status = 'complete', ended_at = coalesce(ended_at, now())
     WHERE id = p_interview_id RETURNING * INTO v_interview;

    -- Free the panel and mark the queue entry done, in the same transaction.
    UPDATE panels SET status = 'open'
     WHERE id = v_interview.panel_id AND status IN ('busy', 'awaiting_evaluations');

    PERFORM fn_queue_transition(v_interview.queue_entry_id, 'done'::queue_state);

    -- Feed the wait estimator. Recorded only for completed interviews, so an abandoned one
    -- does not poison the EWMA with a duration that was never a real interview.
    v_duration := GREATEST(
      1, extract(epoch FROM (v_interview.ended_at - v_interview.started_at))::int
    );
    INSERT INTO service_observations (cycle_id, track_id, panel_id, duration_seconds)
    SELECT v_interview.cycle_id, q.track_id, v_interview.panel_id, v_duration
      FROM queue_entries q WHERE q.id = v_interview.queue_entry_id;

    PERFORM fn_audit(
      v_interview.cycle_id, 'interview.completed', 'interview', p_interview_id,
      NULL, jsonb_build_object('duration_seconds', v_duration), NULL
    );
  ELSE
    -- E10: `awaiting_evaluations` exists precisely so "blocked" is representable rather than
    -- something the UI has to infer from an absence.
    UPDATE interviews SET status = 'awaiting_evaluations'
     WHERE id = p_interview_id AND status = 'in_progress'
     RETURNING * INTO v_interview;

    UPDATE panels SET status = 'awaiting_evaluations'
     WHERE id = v_interview.panel_id AND status = 'busy';
  END IF;

  RETURN v_interview;
END $$;


-- ── Revision within the window (FR-INT-009) ─────────────────────────────────────────────
-- Creates a NEW revision and RETAINS the original. The original is never overwritten: an
-- amended score with no trace of what it replaced is indistinguishable from a rewritten one.
CREATE OR REPLACE FUNCTION fn_revise_evaluation(
  p_evaluation_id uuid,
  p_scores        jsonb,
  p_reason        text,
  p_remarks       text DEFAULT NULL
) RETURNS evaluations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_original evaluations;
  v_window   int;
  v_new      evaluations;
  v_scale_min smallint;
  v_scale_max smallint;
  v_weighted numeric;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to amend an evaluation'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_original FROM evaluations WHERE id = p_evaluation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluation % not found', p_evaluation_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT coalesce((config ->> 'evaluation_revision_window_minutes')::int, 15)
    INTO v_window FROM cycles WHERE id = v_original.cycle_id;

  -- FR-INT-010: after the window, only a Super Admin unlock permits an amendment, and the
  -- unlock is audited separately.
  IF v_original.submitted_at + make_interval(mins => v_window) < now()
     AND NOT fn_has_capability(v_original.cycle_id, 'evaluation.unlock') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: the % minute amendment window has closed', v_window
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT scale_min, scale_max INTO v_scale_min, v_scale_max
    FROM rubrics WHERE id = v_original.rubric_id;

  INSERT INTO evaluations (
    cycle_id, interview_id, interviewer_id, rubric_id, remarks,
    recommended_dept_id, submitted_at, revision, revision_reason
  ) VALUES (
    v_original.cycle_id, v_original.interview_id, v_original.interviewer_id,
    v_original.rubric_id, coalesce(p_remarks, v_original.remarks),
    v_original.recommended_dept_id, now(),
    v_original.revision + 1, p_reason
  )
  RETURNING * INTO v_new;

  INSERT INTO score_items (evaluation_id, criterion_id, score, note)
  SELECT v_new.id, (e ->> 'criterion_id')::uuid, (e ->> 'score')::smallint, e ->> 'note'
    FROM jsonb_array_elements(p_scores) e;

  SELECT sum(
           ((si.score - v_scale_min)::numeric / (v_scale_max - v_scale_min)) * rc.weight
         ) INTO v_weighted
    FROM score_items si
    JOIN rubric_criteria rc ON rc.id = si.criterion_id
   WHERE si.evaluation_id = v_new.id;

  UPDATE evaluations SET raw_score = round(v_weighted, 2)
   WHERE id = v_new.id RETURNING * INTO v_new;

  PERFORM fn_audit(
    v_original.cycle_id, 'evaluation.revised', 'evaluation', v_new.id,
    jsonb_build_object('revision', v_original.revision, 'raw_score', v_original.raw_score),
    jsonb_build_object('revision', v_new.revision, 'raw_score', v_new.raw_score),
    p_reason
  );

  RETURN v_new;
END $$;


-- ── Waiver (FR-INT-012) ─────────────────────────────────────────────────────────────────
-- Without this, one interviewer leaving disables their panel for the rest of the day.
CREATE OR REPLACE FUNCTION fn_waive_evaluation(
  p_interview_id   uuid,
  p_interviewer_id uuid,
  p_reason         text
) RETURNS evaluations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_interview interviews;
  v_eval      evaluations;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to waive an evaluation'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_interview FROM interviews WHERE id = p_interview_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interview % not found', p_interview_id USING ERRCODE = 'no_data_found';
  END IF;

  -- A waived evaluation is a real row with no scores. The absence is recorded, attributed and
  -- explained — rather than being a gap that looks like an oversight later.
  INSERT INTO evaluations (
    cycle_id, interview_id, interviewer_id, rubric_id,
    waived_by, waiver_reason, waived_at
  ) VALUES (
    v_interview.cycle_id, p_interview_id, p_interviewer_id, v_interview.rubric_id,
    fn_current_user_id(), p_reason, now()
  )
  RETURNING * INTO v_eval;

  PERFORM fn_audit(
    v_interview.cycle_id, 'evaluation.waived', 'evaluation', v_eval.id,
    NULL,
    jsonb_build_object('interview_id', p_interview_id, 'waived_interviewer', p_interviewer_id),
    p_reason
  );

  PERFORM fn_check_interview_complete(p_interview_id);

  RETURN v_eval;
END $$;


-- ── RLS: blind evaluation at the row level (FR-INT-004) ─────────────────────────────────
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_items ENABLE ROW LEVEL SECURITY;

-- An interviewer sees their OWN evaluations and nothing else. Not other panel members'
-- scores, not aggregates, not ranks — the UI hiding them is ergonomics; this is the control.
CREATE POLICY evaluation_own_select ON evaluations FOR SELECT
  USING (interviewer_id = fn_current_user_id());

-- Super Admin and Auditor see everything within their cycle (FR-RBAC-009). Coordinator does
-- NOT appear here: floor authority without score visibility is the entire reason that role
-- exists.
CREATE POLICY evaluation_privileged_select ON evaluations FOR SELECT
  USING (fn_has_capability(cycle_id, 'evaluation.view_all'));

CREATE POLICY score_item_own_select ON score_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM evaluations e
                  WHERE e.id = score_items.evaluation_id
                    AND (e.interviewer_id = fn_current_user_id()
                         OR fn_has_capability(e.cycle_id, 'evaluation.view_all'))));

COMMIT;
