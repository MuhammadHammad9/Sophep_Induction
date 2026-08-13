-- 0044 — One unknown identifier must not abort the whole reconciliation batch
--
-- `fn_bulk_reconcile` already wraps each applicant in its own BEGIN/EXCEPTION block, with a
-- comment stating the intent exactly right: "In a bulk operation, one domain-level failure must
-- not abort the rest."
--
-- It did not do that. The handler caught
--
--     raise_exception OR unique_violation OR check_violation OR foreign_key_violation
--
-- but `fn_check_in` raises "applicant % not found" with ERRCODE `no_data_found`, which is in
-- none of those classes. So the single most likely error during a paper transcription — one
-- mistyped identifier out of eighty — propagated out and rolled back the entire batch.
--
-- The Coordinator's experience of that: they type eighty rows at the end of a long day, press
-- the button, and get one error naming a UUID. Nobody is checked in. There is no indication
-- which of the eighty was wrong. Found by the test added alongside this migration, which passes
-- a real applicant and one unknown id and expects TWO result rows.
--
-- The narrow catch list is kept rather than replaced with WHEN OTHERS, for the reason the
-- original comment gives: a bare handler would also swallow connection loss and out-of-memory,
-- turning an infrastructure failure into eighty rows of plausible-looking 'error:' text.
--
-- Refs: FR-CHK-017, FR-CHK-019

BEGIN;

CREATE OR REPLACE FUNCTION fn_bulk_reconcile(
  p_stage_id uuid,
  p_applicant_ids uuid[]
) RETURNS TABLE (
  applicant_id uuid,
  outcome text,
  queue_position int
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_rec record;
  v_cycle_id uuid;
BEGIN
  SELECT s.cycle_id INTO v_cycle_id FROM stages s WHERE s.id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM fn_require_capability(v_cycle_id, 'checkin.reconcile');

  IF array_length(p_applicant_ids, 1) > 500 THEN
    RAISE EXCEPTION 'RATE_LIMITED: reconcile at most 500 applicants per call, got %',
      array_length(p_applicant_ids, 1) USING ERRCODE = 'raise_exception';
  END IF;

  PERFORM fn_audit(
    v_cycle_id, 'checkin.bulk_reconciled', 'stage', p_stage_id,
    NULL,
    jsonb_build_object('count', COALESCE(array_length(p_applicant_ids, 1), 0)),
    'paper-fallback recovery'
  );

  FOREACH v_id IN ARRAY p_applicant_ids
  LOOP
    BEGIN
      SELECT * INTO v_rec FROM fn_check_in(
        p_applicant_id := v_id,
        p_stage_id := p_stage_id,
        p_method := 'bulk_reconcile'
      );

      applicant_id := v_id;
      outcome := v_rec.outcome;
      queue_position := v_rec.queue_position;
      RETURN NEXT;
    EXCEPTION WHEN raise_exception
                OR no_data_found              -- the mistyped identifier: THE common case
                OR invalid_text_representation
                OR unique_violation
                OR check_violation
                OR foreign_key_violation THEN
      applicant_id := v_id;
      outcome := 'error: ' || SQLERRM;
      queue_position := NULL;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END $$;

COMMIT;
