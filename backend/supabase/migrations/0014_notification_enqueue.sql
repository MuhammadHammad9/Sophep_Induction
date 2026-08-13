-- 0014 — Enqueueing notifications
--
-- Found by submitting a real application through the running app: registration succeeded, then
-- the confirmation email failed with "new row violates row-level security policy for table
-- notifications". Migration 0005 enabled RLS on that table and 0008 gave it SELECT policies
-- only, so nothing could ever insert.
--
-- THE TEMPTING FIX IS A SECURITY HOLE. Adding `CREATE POLICY ... FOR INSERT WITH CHECK (true)`
-- makes the error go away and turns the public application form into an OPEN MAIL RELAY:
-- an unauthenticated caller could enqueue arbitrary subject and body content to any address
-- they like, sent from the society's verified sending domain. That is a spam and phishing
-- vector wearing SOPHEP's name, and it would pass every test in the suite.
--
-- THE FIX: a SECURITY DEFINER function that derives the recipient FROM THE APPLICANT RECORD.
-- The caller supplies who the message is about, never where it goes. An attacker who can call
-- this can, at worst, send a legitimate applicant a message that applicant was already going
-- to receive.
--
-- Refs: FR-NOT-001, FR-NOT-004, NFR-SEC-005, NFR-PRIV-002

BEGIN;

CREATE OR REPLACE FUNCTION fn_enqueue_notification(
  p_applicant_id     uuid,
  p_template_key     text,
  p_template_version smallint,
  p_subject          text,
  p_body_html        text,
  p_body_text        text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
  v_email    text;
  v_id       uuid;
BEGIN
  -- The recipient comes from here and nowhere else. This single SELECT is what stops the
  -- function being an open relay.
  SELECT cycle_id, email INTO v_cycle_id, v_email
    FROM applicants
   WHERE id = p_applicant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  -- FR-NOT-005 / FR-DEC-013: never re-send to an address that has hard bounced. Doing so
  -- damages sending reputation for the whole cohort, which on results day means other
  -- applicants never learn their outcome.
  IF EXISTS (
    SELECT 1 FROM notifications
     WHERE to_email = v_email AND state = 'bounced' AND bounce_type = 'hard'
  ) THEN
    RAISE EXCEPTION 'SUPPRESSED_HARD_BOUNCE' USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO notifications (
    cycle_id, applicant_id, template_key, template_version,
    to_email, subject, body_html, body_text, state
  ) VALUES (
    v_cycle_id, p_applicant_id, p_template_key, p_template_version,
    v_email, p_subject, p_body_html, p_body_text, 'pending'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

COMMENT ON FUNCTION fn_enqueue_notification IS
  'Enqueues an applicant notification. The recipient is derived from the applicant record and can never be supplied by the caller — otherwise the public form becomes an open mail relay. FR-NOT-001';

GRANT EXECUTE ON FUNCTION fn_enqueue_notification(uuid, text, smallint, text, text, text) TO rms_app;

-- Deliberately NO general INSERT policy on notifications. The SECURITY DEFINER function above
-- is the only write path, so the recipient constraint cannot be bypassed by a future endpoint
-- that inserts directly.

COMMIT;
