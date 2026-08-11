-- 0032 — Consistency and Anonymisation
--
-- Support functions for Phase 5 (Resilience) cron jobs.
-- 
-- 1. fn_check_consistency: Verifies that applicants.state matches the true state 
-- derived from event tables. Fixes discrepancies and logs them.
-- 2. fn_anonymise_old_data: Scrubs PII from cycles older than 2 years.

BEGIN;

CREATE OR REPLACE FUNCTION fn_check_consistency(p_cycle_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fixed_count int := 0;
  v_row record;
  v_true_state applicant_state;
BEGIN
  FOR v_row IN 
    SELECT applicant_id, projected, derived 
    FROM fn_detect_state_drift(p_cycle_id)
  LOOP
    PERFORM set_config('app.state_writer', 'fn_check_consistency', true);
    UPDATE applicants SET state = v_row.derived::applicant_state WHERE id = v_row.applicant_id;
    PERFORM set_config('app.state_writer', '', true);
    
    PERFORM fn_audit(
      p_cycle_id, 'ops.consistency_fixed', 'applicant', v_row.applicant_id,
      jsonb_build_object('state', v_row.projected),
      jsonb_build_object('state', v_row.derived),
      'State discrepancy fixed by consistency job'
    );
    v_fixed_count := v_fixed_count + 1;
  END LOOP;

  RETURN v_fixed_count;
END $$;

GRANT EXECUTE ON FUNCTION fn_check_consistency(uuid) TO rms_app;


CREATE OR REPLACE FUNCTION fn_anonymise_old_data()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_archived_cycles uuid[];
  v_c uuid;
  v_count int := 0;
  v_affected int;
BEGIN
  -- Find cycles archived more than 2 years ago
  SELECT array_agg(id) INTO v_archived_cycles
  FROM cycles
  WHERE state = 'archived' 
    AND archived_at < now() - interval '2 years';
    
  IF v_archived_cycles IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_c IN ARRAY v_archived_cycles
  LOOP
    -- Anonymise applicants
    UPDATE applicants
    SET full_name = 'ANONYMISED',
        email = id::text || '@anonymised.local',
        phone = '000000000',
        roll_number = 'ANON',
        cv_object_key = NULL
    WHERE cycle_id = v_c AND full_name <> 'ANONYMISED';
    
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_count := v_count + v_affected;
    
    -- Anonymise audit events related to these applicants? 
    -- PII shouldn't be in audit events generally, except perhaps before/after blobs.
    -- Strict anonymisation would scrub the JSON blobs too.
    UPDATE audit_events
    SET before = '{}'::jsonb, after = '{}'::jsonb
    WHERE cycle_id = v_c 
      AND entity_type = 'applicant' 
      AND (before <> '{}'::jsonb OR after <> '{}'::jsonb);
      
  END LOOP;

  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION fn_anonymise_old_data() TO rms_app;

COMMIT;
