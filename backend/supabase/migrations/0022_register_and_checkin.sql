-- 0022 — Register-and-check-in, and TOTP storage
--
-- FR-CHK-010: where no applicant record exists, the desk must be able to register AND check in
-- from ONE screen, in under 30 seconds, flagging the record `needs_completion`.
--
-- The deliberate design choice is that this record is INCOMPLETE ON PURPOSE. A walk-in at
-- 10:40 with a queue behind them does not have two minutes for department preferences and a
-- CV. Speed at the desk matters more than completeness, and `needs_completion` is what makes
-- that a tracked follow-up rather than a silent gap — the alternative is a volunteer inventing
-- answers to satisfy a form.
--
-- Refs: FR-CHK-010, FR-REG-002, FR-RBAC-008, NFR-SEC-002

BEGIN;

CREATE OR REPLACE FUNCTION fn_register_and_checkin(
  p_cycle_id   uuid,
  p_stage_id   uuid,
  p_full_name  text,
  p_email      text,
  p_phone      text,
  p_source     registration_channel DEFAULT 'walkin_digital',
  p_roll_number text DEFAULT NULL,
  p_override_reason text DEFAULT NULL
) RETURNS TABLE (
  outcome        text,
  applicant_id   uuid,
  display_id     text,
  queue_position int,
  eta_suppressed boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_applicant applicants;
  v_checkin   record;
BEGIN
  -- One code path with ordinary registration (FR-REG-002). A separate, looser insert here is
  -- exactly how walk-ins become second-class records with a different ID format and no token.
  SELECT * INTO v_applicant
    FROM fn_register_applicant(
      p_cycle_id, p_full_name, p_email, p_phone, p_source,
      p_roll_number, '{}'::jsonb, NULL, p_override_reason,
      true   -- needs_completion
    );

  -- Screened straight to eligible: someone standing at the desk has self-evidently arrived,
  -- and making them wait for a separate screening step would strand them in the hall.
  PERFORM fn_application_transition(v_applicant.id, 'eligible'::applicant_state);

  SELECT * INTO v_checkin FROM fn_check_in(
    v_applicant.id, p_stage_id, NULL, 'register_and_checkin'
  );

  PERFORM fn_audit(
    p_cycle_id, 'applicant.register_and_checkin', 'applicant', v_applicant.id,
    NULL,
    jsonb_build_object('display_id', v_applicant.display_id, 'needs_completion', true),
    'registered at the desk on the day'
  );

  outcome        := v_checkin.outcome;
  applicant_id   := v_applicant.id;
  display_id     := v_applicant.display_id;
  queue_position := v_checkin.queue_position;
  eta_suppressed := v_checkin.eta_suppressed;
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION fn_register_and_checkin IS
  'One-screen desk registration. Record is deliberately incomplete and flagged needs_completion — speed at the desk beats a volunteer inventing answers. FR-CHK-010';

GRANT EXECUTE ON FUNCTION fn_register_and_checkin(uuid, uuid, text, text, text, registration_channel, text, text) TO rms_app;


-- ── Applicants needing follow-up ────────────────────────────────────────────────────────
-- Surfaces on the ops dashboard so the flag is a worklist rather than a column nobody reads.
CREATE OR REPLACE FUNCTION fn_incomplete_registrations(p_cycle_id uuid)
RETURNS TABLE (applicant_id uuid, display_id text, full_name text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.display_id, a.full_name, a.created_at
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id
     AND a.needs_completion
     AND a.state NOT IN ('withdrawn', 'screened_out')
   ORDER BY a.created_at
$$;

GRANT EXECUTE ON FUNCTION fn_incomplete_registrations(uuid) TO rms_app;


-- ── TOTP (FR-RBAC-008) ──────────────────────────────────────────────────────────────────
-- The secret is encrypted at the APPLICATION layer before it arrives here (NFR-SEC-002), on
-- top of storage encryption, so a database dump yields no working second factors.
--
-- last_used_step enforces RFC 6238 §5.2: a code is accepted only once. Without it, a code read
-- over a shoulder stays usable for the rest of its 30-second window.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_used_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamptz;

CREATE OR REPLACE FUNCTION fn_record_totp_use(p_user_id uuid, p_step bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- GREATEST guards against an out-of-order write moving the watermark backwards and
  -- re-opening a code that was already spent.
  UPDATE users
     SET totp_last_used_step = GREATEST(coalesce(totp_last_used_step, 0), p_step)
   WHERE id = p_user_id;
END $$;

GRANT EXECUTE ON FUNCTION fn_record_totp_use(uuid, bigint) TO rms_app;

COMMIT;
