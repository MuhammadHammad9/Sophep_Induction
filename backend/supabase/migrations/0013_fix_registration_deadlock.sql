-- 0013 — Fix a lock-upgrade deadlock in registration
--
-- Found by tests/concurrency/registration.test.ts, "produces 20 distinct identifiers with no
-- gaps from contention" (FR-IDT-004). Under 20 simultaneous registrations the transactions
-- deadlocked and several rolled back.
--
-- THE BUG — a textbook lock upgrade:
--
--   1. fn_register_applicant read the cycle state with `FOR SHARE`, taking a SHARED row lock
--      on cycles.
--   2. fn_allocate_applicant_id then ran `UPDATE cycles SET applicant_seq = ...`, which needs
--      an EXCLUSIVE lock on that same row.
--
-- Shared locks are, by definition, held by many transactions at once. So two concurrent
-- registrations both acquired the share lock, then both waited for the other to release it
-- before the exclusive lock could be granted. Neither ever could. Postgres detected the cycle
-- and killed one.
--
-- Why this matters more than a failing test: it appears ONLY under genuine concurrency, which
-- is to say only on the day, with two desks working the queue, and it presents as a
-- registration that mysteriously fails while a volunteer is standing in front of an applicant.
-- Every single-user test passes.
--
-- THE FIX: acquire the exclusive lock ONCE, up front, instead of upgrading to it.
--
-- `FOR UPDATE` is not a heavier cost here — registrations on one cycle already serialise on
-- this row because of the counter (§3.1, and honestly so: a few hundred per second, roughly
-- 100x the realistic peak). The upgrade bought nothing and cost correctness.
--
-- Refs: FR-IDT-003, FR-IDT-004, FR-REG-001

BEGIN;

CREATE OR REPLACE FUNCTION fn_register_applicant(
  p_cycle_id        uuid,
  p_full_name       text,
  p_email           text,
  p_phone           text,
  p_source          registration_channel,
  p_roll_number     text    DEFAULT NULL,
  p_answers         jsonb   DEFAULT '{}'::jsonb,
  p_preferences     uuid[]  DEFAULT NULL,
  p_override_reason text    DEFAULT NULL,
  p_needs_completion boolean DEFAULT false
) RETURNS applicants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_state cycle_state;
  v_seq         int;
  v_display_id  text;
  v_code        text;
  v_season      char(2);
  v_year        smallint;
  v_applicant   applicants;
  v_dept        uuid;
  v_rank        smallint := 1;
  v_max_prefs   smallint;
BEGIN
  -- Single exclusive lock, acquired once. This both gates on cycle state and reserves the
  -- counter — no second lock, therefore no upgrade, therefore no deadlock.
  --
  -- Reading config in the same statement avoids a second visit to the row.
  SELECT state, coalesce((config ->> 'max_preferences')::smallint, 3)
    INTO v_cycle_state, v_max_prefs
    FROM cycles
   WHERE id = p_cycle_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle % not found', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;

  -- FR-CYC-005: an archived cycle is read-only at the database level.
  IF v_cycle_state = 'archived' THEN
    RAISE EXCEPTION 'CYCLE_ARCHIVED' USING ERRCODE = 'raise_exception';
  END IF;

  -- FR-CYC-004, checked at the WRITE rather than in the UI. Walk-in channels stay open during
  -- interviews: someone arriving at the desk with no prior application is a normal case
  -- (FR-CHK-010), not an error.
  IF v_cycle_state <> 'registration_open'
     AND NOT (p_source IN ('walkin_digital', 'walkin_paper')
              AND v_cycle_state IN ('registration_closed', 'interviews_active')) THEN
    RAISE EXCEPTION 'STAGE_CLOSED' USING ERRCODE = 'raise_exception';
  END IF;

  IF p_preferences IS NOT NULL AND array_length(p_preferences, 1) > v_max_prefs THEN
    RAISE EXCEPTION 'at most % department preferences may be ranked', v_max_prefs
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Counter increment. The row is already exclusively locked by the SELECT above, so this
  -- cannot block on anything a concurrent registration holds.
  --
  -- Still an in-transaction increment, never SELECT MAX()+1 (FR-IDT-003, rules.md R-020).
  -- On rollback the increment is undone with everything else, so a rejected registration
  -- consumes no identifier.
  UPDATE cycles
     SET applicant_seq = applicant_seq + 1
   WHERE id = p_cycle_id
   RETURNING applicant_seq, season, year INTO v_seq, v_season, v_year;

  SELECT s.code INTO v_code
    FROM societies s JOIN cycles c ON c.society_id = s.id
   WHERE c.id = p_cycle_id;

  v_display_id := format('%s-%s%s-%s', v_code, v_season, right(v_year::text, 2),
                         lpad(v_seq::text, 4, '0'));

  INSERT INTO applicants (
    cycle_id, display_id, sequence, state, full_name, email, phone, roll_number,
    source, answers, dedupe_override_reason, dedupe_override_by, needs_completion, submitted_at
  ) VALUES (
    p_cycle_id, v_display_id, v_seq, 'submitted', btrim(p_full_name), btrim(p_email),
    btrim(p_phone), nullif(btrim(coalesce(p_roll_number, '')), ''),
    p_source, p_answers, p_override_reason,
    CASE WHEN p_override_reason IS NOT NULL THEN fn_current_user_id() END,
    p_needs_completion, now()
  )
  RETURNING * INTO v_applicant;

  IF p_preferences IS NOT NULL THEN
    FOREACH v_dept IN ARRAY p_preferences LOOP
      INSERT INTO applicant_preferences (cycle_id, applicant_id, department_id, rank)
      VALUES (p_cycle_id, v_applicant.id, v_dept, v_rank);
      v_rank := v_rank + 1;
    END LOOP;
  END IF;

  PERFORM fn_audit(
    p_cycle_id, 'applicant.registered', 'applicant', v_applicant.id,
    NULL,
    jsonb_build_object(
      'display_id', v_display_id,
      'source', p_source,
      'needs_completion', p_needs_completion,
      'preference_count', coalesce(array_length(p_preferences, 1), 0)
    ),
    p_override_reason
  );

  -- FR-REG-008: the override is its own audited event, so "who decided these were different
  -- people, and why" is answerable without inferring it from a registration row.
  IF p_override_reason IS NOT NULL THEN
    PERFORM fn_audit(
      p_cycle_id, 'applicant.dedupe_overridden', 'applicant', v_applicant.id,
      NULL, jsonb_build_object('display_id', v_display_id), p_override_reason
    );
  END IF;

  RETURN v_applicant;
END $$;

COMMENT ON FUNCTION fn_register_applicant IS
  'Single code path for all three channels. Takes ONE exclusive lock on the cycle row — never a share lock upgraded to exclusive, which deadlocked under concurrent desks. FR-REG-001, FR-REG-002, FR-IDT-004';

-- fn_allocate_applicant_id is now inlined above so registration holds exactly one lock.
-- Kept for direct callers and tests, with the hazard documented.
COMMENT ON FUNCTION fn_allocate_applicant_id IS
  'Standalone identifier allocation. Callers MUST NOT hold a weaker lock on the same cycle row first — upgrading a share lock to exclusive deadlocks under concurrency (see migration 0013).';

COMMIT;
