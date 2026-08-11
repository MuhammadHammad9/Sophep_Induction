-- 0006 — State ownership enforcement and the application-lifecycle transition function
--
-- Fixes errata E5. v1 had applicants.state and queue_entries.state both encoding
-- queued/called/in_interview, with nothing keeping them consistent. They drift, and the first
-- symptom is an applicant whose status page says "Position 4" while the panel screen says they
-- are mid-interview — during the event, in front of them, and unfixable afterwards because
-- nothing recorded which was right.
--
-- Architecture spec §4 makes state ownership normative but states the rule in prose. Prose is
-- what produced E5 in the first place, so this migration makes it a database property: a direct
-- UPDATE of applicants.state from application code RAISES.
--
--
-- ⚠ SPECIFICATION GAP — RAISED, NOT SILENTLY RESOLVED
--
-- Spec §4's ownership table names four owners (fn_check_in, fn_queue_transition,
-- fn_interview_transition, fn_apply_decision) covering event-day states onward. It names NO
-- owner for the pre-event lifecycle: draft → submitted → eligible / screened_out, or the
-- withdrawn transition available at any point pre-decision.
--
-- Those states exist in §5.1's state machine and are written during Phase 1, so an owner is
-- required or R-012 is unenforceable for exactly the states this phase creates. This migration
-- introduces fn_application_transition() as the fifth owner. Per the JSON's
-- notes_for_implementers, this is raised as a spec defect rather than quietly patched.
--
-- Refs: FR-OPS-001, FR-OPS-002, FR-AUD-001, FR-AUD-002, E5, rules.md R-011, R-012

BEGIN;

-- ── Audit helper ────────────────────────────────────────────────────────────────────────
-- Called INSIDE the same transaction as the change it describes. If this insert fails the
-- whole transaction rolls back — that is the point. No audit, no commit (FR-AUD-002).
CREATE OR REPLACE FUNCTION fn_audit(
  p_cycle_id    uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_before      jsonb DEFAULT NULL,
  p_after       jsonb DEFAULT NULL,
  p_reason      text  DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO audit_events (
    cycle_id, actor_id, actor_role, actor_label,
    action, entity_type, entity_id, before, after, reason, ip
  ) VALUES (
    p_cycle_id,
    nullif(current_setting('app.user_id', true), '')::uuid,
    nullif(current_setting('app.actor_role', true), '')::role_name,
    nullif(current_setting('app.actor_label', true), ''),
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason,
    nullif(current_setting('app.client_ip', true), '')::inet
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION fn_audit IS
  'Writes an audit row in the caller''s transaction. Failure rolls back the change. FR-AUD-002';


-- ── State-ownership guard ───────────────────────────────────────────────────────────────
-- applicants.state is a PROJECTION. The owning functions announce themselves by setting a
-- TRANSACTION-LOCAL flag (is_local = true) before writing. Transaction-local matters: under a
-- transaction-mode connection pooler a session-level SET would leak into unrelated requests —
-- the same mechanism that caused E9.
CREATE OR REPLACE FUNCTION fn_guard_applicant_state() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_writer text := nullif(current_setting('app.state_writer', true), '');
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF v_writer IS NULL OR v_writer NOT IN (
      'fn_application_transition',
      'fn_check_in',
      'fn_queue_transition',
      'fn_interview_transition',
      'fn_apply_decision'
    ) THEN
      RAISE EXCEPTION
        'applicants.state is a projection and cannot be written directly (attempted % -> %). Use an owning transition function. E5, FR-OPS-002, rules.md R-012',
        OLD.state, NEW.state
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_guard_applicant_state BEFORE UPDATE ON applicants
  FOR EACH ROW EXECUTE FUNCTION fn_guard_applicant_state();


-- ── Legal pre-event transitions ─────────────────────────────────────────────────────────
-- Anything not listed is rejected with INVALID_TRANSITION. Ambiguous state is the root cause
-- of most "the system did something weird" reports (spec §5).
CREATE TABLE application_transitions (
  from_state  applicant_state NOT NULL,
  to_state    applicant_state NOT NULL,
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO application_transitions (from_state, to_state) VALUES
  ('draft',       'submitted'),
  ('submitted',   'eligible'),
  ('submitted',   'screened_out'),
  ('submitted',   'withdrawn'),
  ('eligible',    'screened_out'),
  ('eligible',    'withdrawn'),
  -- Re-admitting a screened-out applicant is a deliberate, audited correction. Volunteers
  -- screen under time pressure and get it wrong occasionally; the alternative is a person
  -- with no route back into their own induction.
  ('screened_out', 'eligible');


-- ── fn_application_transition — owner of pre-event applicant state ──────────────────────
CREATE OR REPLACE FUNCTION fn_application_transition(
  p_applicant_id uuid,
  p_to_state     applicant_state,
  p_reason       text DEFAULT NULL
) RETURNS applicants
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before applicants;
  v_after  applicants;
  v_cycle_state cycle_state;
BEGIN
  SELECT * INTO v_before FROM applicants WHERE id = p_applicant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  -- FR-CYC-005: an archived cycle is read-only at the database level.
  SELECT state INTO v_cycle_state FROM cycles WHERE id = v_before.cycle_id;
  IF v_cycle_state = 'archived' THEN
    RAISE EXCEPTION 'CYCLE_ARCHIVED' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_before.state = p_to_state THEN
    RETURN v_before;   -- idempotent, no spurious audit row
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM application_transitions
     WHERE from_state = v_before.state AND to_state = p_to_state
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: % -> %', v_before.state, p_to_state
      USING ERRCODE = 'raise_exception';
  END IF;

  IF p_to_state IN ('screened_out', 'withdrawn')
     AND (p_reason IS NULL OR length(btrim(p_reason)) < 5) THEN
    RAISE EXCEPTION 'a reason is required to transition to %', p_to_state
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Announce ourselves to the guard trigger, transaction-scoped.
  PERFORM set_config('app.state_writer', 'fn_application_transition', true);

  UPDATE applicants
     SET state        = p_to_state,
         submitted_at = CASE WHEN p_to_state = 'submitted' THEN now() ELSE submitted_at END,
         screened_at  = CASE WHEN p_to_state IN ('eligible', 'screened_out') THEN now() ELSE screened_at END,
         screened_by  = CASE WHEN p_to_state IN ('eligible', 'screened_out')
                             THEN nullif(current_setting('app.user_id', true), '')::uuid
                             ELSE screened_by END,
         withdrawn_at = CASE WHEN p_to_state = 'withdrawn' THEN now() ELSE withdrawn_at END
   WHERE id = p_applicant_id
   RETURNING * INTO v_after;

  PERFORM set_config('app.state_writer', '', true);

  -- Same transaction. FR-AUD-002.
  PERFORM fn_audit(
    v_after.cycle_id,
    'applicant.state_changed',
    'applicant',
    p_applicant_id,
    jsonb_build_object('state', v_before.state),
    jsonb_build_object('state', v_after.state),
    p_reason
  );

  RETURN v_after;
END $$;

COMMENT ON FUNCTION fn_application_transition IS
  'Sole owner of pre-event applicants.state. Fifth owner, extending spec §4 which covers only event-day onward — raised as a spec gap. E5, FR-OPS-002';

COMMIT;
