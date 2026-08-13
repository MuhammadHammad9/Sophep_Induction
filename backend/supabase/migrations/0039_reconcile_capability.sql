-- 0039 — Bulk reconcile is a Coordinator action, not a volunteer one
--
-- Migration 0038 closed a real hole by requiring `checkin.perform` on `fn_bulk_reconcile`,
-- which was previously ungated. It deliberately invented no new capability, and that was the
-- right call for an audit whose job was to stop the bleeding.
--
-- It leaves one gap, though, and the spec is unambiguous about it:
--
--   spec.json api_surface → POST /api/stages/:id/reconcile → "auth": "coordinator+"
--
-- `checkin.perform` is held by volunteers. So as of 0038 any signed-in volunteer can check in
-- up to 500 people from a list they typed. Every other check-in path has an applicant standing
-- in front of somebody; this is the only one where a mistake — or a bored volunteer — is
-- invisible until the queue fills with people who are not in the building.
--
-- This is implementing the stated requirement rather than deciding one (R-054): the spec names
-- the authorisation level, and the only reason it was not enforced is that no capability
-- carried it. `checkin.reconcile` goes to the two roles that "coordinator+" denotes, matching
-- how `evaluation.waive` and `interview.void` are already granted.
--
-- Refs: FR-CHK-017, FR-CHK-019, spec.json api_surface, rules.md R-032, R-054

BEGIN;

INSERT INTO role_capabilities (role, capability, scope) VALUES
  ('super_admin', 'checkin.reconcile', 'all'),
  ('coordinator', 'checkin.reconcile', 'all')
ON CONFLICT DO NOTHING;

/**
 * Same body as 0038, with the capability tightened.
 *
 * Everything else 0038 established is preserved deliberately: the stage lookup that derives the
 * cycle, the 500-row bound, and the per-row exception handler that stops one domain failure
 * aborting the rest of the batch.
 */
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

  -- One audit row for the BATCH, in addition to the per-applicant rows fn_check_in writes.
  -- Without it there is nothing recording that a bulk entry happened at all — only eighty
  -- individually plausible check-ins, which is precisely what an investigation would need to
  -- distinguish from eighty real ones (R-011).
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
    EXCEPTION WHEN raise_exception OR unique_violation OR check_violation OR foreign_key_violation THEN
      -- In a bulk operation, one domain-level failure must not abort the rest. The error
      -- becomes this row's outcome so the Coordinator sees exactly who did not go through.
      applicant_id := v_id;
      outcome := 'error: ' || SQLERRM;
      queue_position := NULL;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END $$;

COMMIT;
