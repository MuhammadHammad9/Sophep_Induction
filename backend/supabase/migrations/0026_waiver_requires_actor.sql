-- 0026 — A waiver must have an accountable actor
--
-- Found by tests/rls/evaluation.test.ts: waiving an evaluation left the interview stuck at
-- `awaiting_evaluations` and the panel unable to call anyone.
--
-- THE BUG. fn_waive_evaluation set `waived_by = fn_current_user_id()`, which returns NULL when
-- no security context is bound. The waiver_needs_reason CHECK is written as
-- `waived_by IS NULL OR (...)`, so a NULL actor passes it. The row inserted happily — and then
-- fn_check_interview_complete, which counts `waived_by IS NOT NULL`, did not see it.
--
-- So the failure was silent and total: the waiver appeared to succeed, the interview never
-- completed, and the panel stayed blocked for the rest of the day with no error anywhere.
--
-- The deeper problem is not the count. FR-INT-012 requires a waiver to identify who waived and
-- why, precisely because it is the one action that lets an interview complete WITHOUT a score.
-- A waiver attributed to nobody is unauditable, which defeats the point of allowing it at all.
--
-- THE FIX: refuse to record a waiver without an authenticated actor, and make the CHECK
-- require the actor rather than tolerate its absence.
--
-- Refs: FR-INT-011, FR-INT-012, FR-AUD-001

BEGIN;

-- Any pre-existing unattributed waiver is a data defect, not something to migrate around.
-- There should be none — this is Phase 3 and no cycle has run — but failing loudly here is
-- better than silently deleting evidence of a real waiver.
DO $$
DECLARE v_orphans int;
BEGIN
  SELECT count(*) INTO v_orphans
    FROM evaluations WHERE waived_at IS NOT NULL AND waived_by IS NULL;

  IF v_orphans > 0 THEN
    RAISE EXCEPTION
      '% waiver(s) exist with no actor. Attribute them before applying this migration.',
      v_orphans;
  END IF;
END $$;

ALTER TABLE evaluations DROP CONSTRAINT IF EXISTS waiver_needs_reason;

-- Now symmetric: a waiver needs BOTH an actor and a reason, and neither can be present
-- without the other. The previous form only constrained the reason.
ALTER TABLE evaluations ADD CONSTRAINT waiver_needs_actor_and_reason CHECK (
  (waived_at IS NULL AND waived_by IS NULL AND waiver_reason IS NULL)
  OR (waived_at IS NOT NULL AND waived_by IS NOT NULL
      AND waiver_reason IS NOT NULL AND length(btrim(waiver_reason)) >= 5)
);

CREATE OR REPLACE FUNCTION fn_waive_evaluation(
  p_interview_id   uuid,
  p_interviewer_id uuid,
  p_reason         text
) RETURNS evaluations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_interview interviews;
  v_actor     uuid;
  v_eval      evaluations;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to waive an evaluation'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The fix. Refusing here rather than inserting an unattributed row means a
  -- misconfigured caller gets a loud failure instead of a panel that stays blocked all day.
  v_actor := fn_current_user_id();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'a waiver must be attributed to an authenticated user — no security context is bound'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_interview FROM interviews WHERE id = p_interview_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'interview % not found', p_interview_id USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM panel_members pm
     WHERE pm.panel_id = v_interview.panel_id AND pm.interviewer_id = p_interviewer_id
  ) THEN
    RAISE EXCEPTION 'that interviewer is not on this panel' USING ERRCODE = 'raise_exception';
  END IF;

  -- Waiving someone who already submitted would discard a real score.
  IF EXISTS (
    SELECT 1 FROM evaluations
     WHERE interview_id = p_interview_id
       AND interviewer_id = p_interviewer_id
       AND submitted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: that interviewer has already submitted'
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO evaluations (
    cycle_id, interview_id, interviewer_id, rubric_id, waived_by, waiver_reason, waived_at
  ) VALUES (
    v_interview.cycle_id, p_interview_id, p_interviewer_id, v_interview.rubric_id,
    v_actor, p_reason, now()
  )
  RETURNING * INTO v_eval;

  PERFORM fn_audit(
    v_interview.cycle_id, 'evaluation.waived', 'evaluation', v_eval.id,
    NULL,
    jsonb_build_object(
      'interview_id', p_interview_id,
      'waived_interviewer', p_interviewer_id,
      'waived_by', v_actor
    ),
    p_reason
  );

  PERFORM fn_check_interview_complete(p_interview_id);

  RETURN v_eval;
END $$;

COMMENT ON FUNCTION fn_waive_evaluation IS
  'Waives a missing evaluation so one absent interviewer cannot disable a panel. REQUIRES an authenticated actor: an unattributed waiver is unauditable and was silently ignored by the completion gate. FR-INT-012';

COMMIT;
