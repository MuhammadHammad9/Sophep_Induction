-- 0030 — Bulk Reconcile
--
-- The recovery path for the Level 5 offline fallback (spec §19.6, FR-CHK-019).
-- If the venue loses power or internet and devices die, the check-in desk switches to
-- the printed paper roster. When power returns, a Coordinator enters all the checked
-- boxes at once.
--
-- This function processes an array of applicant IDs. It relies on the existing idempotent
-- fn_check_in, but batches the results so the UI can report exactly which succeeded,
-- which were already checked in, and which failed (e.g. ineligible).

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
BEGIN
  -- Validate stage
  IF NOT EXISTS (SELECT 1 FROM stages WHERE id = p_stage_id) THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  FOREACH v_id IN ARRAY p_applicant_ids
  LOOP
    BEGIN
      -- We call the existing check_in function for each ID. It handles idempotency,
      -- enqueuing, and the audit log. We use method='bulk_reconcile'.
      SELECT * INTO v_rec FROM fn_check_in(
        p_applicant_id := v_id,
        p_stage_id := p_stage_id,
        p_method := 'bulk_reconcile'
      );
      
      applicant_id := v_id;
      outcome := v_rec.outcome;
      queue_position := v_rec.queue_position;
      RETURN NEXT;
    EXCEPTION WHEN raise_exception OR unique_violation OR check_violation OR foreign_key_violation THEN
      -- In a bulk operation, one domain-level failure must not abort the rest.
      -- We return the error as the outcome. Catching specific classes prevents
      -- swallowing fatal errors (OOM, connection loss).
      applicant_id := v_id;
      outcome := 'error: ' || SQLERRM;
      queue_position := NULL;
      RETURN NEXT;
    END;
  END LOOP;
  
  RETURN;
END $$;

COMMENT ON FUNCTION fn_bulk_reconcile IS
  'Recovery path for paper fallback. Wraps fn_check_in for a batch of applicant IDs and catches individual errors.';

GRANT EXECUTE ON FUNCTION fn_bulk_reconcile(uuid, uuid[]) TO rms_app;

COMMIT;
