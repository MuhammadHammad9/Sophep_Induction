-- 0018 — Check-in
--
-- The eight-second path (NFR-PERF-003). Everything here is shaped by one fact: this runs in a
-- noisy hall, on a phone, by someone with fifteen minutes of training, with a queue of people
-- waiting. Correctness matters, but so does never making the volunteer stop and think.
--
-- fn_check_in is IDEMPOTENT and does the enqueue in the SAME transaction. Two devices scanning
-- the same QR in the same second must produce one check_in row and one queue position — not a
-- race whose loser gets a duplicate.
--
-- Refs: FR-CHK-006..011, FR-CHK-016, FR-QUE-001, FR-OPS-004

BEGIN;

-- ── Idempotent check-in ─────────────────────────────────────────────────────────────────
--
-- Returns enough for the scanner overlay to render without a second round trip: the outcome,
-- the applicant, their queue position, and — for a repeat scan — the ORIGINAL check-in time.
--
-- `outcome` distinguishes 'checked_in' from 'already' deliberately. FR-CHK-006 and NFR-USE-004
-- require the repeat case to be presented in AMBER, not red: it is the most common non-happy
-- path, it is not an error, and a red screen in front of a nervous applicant reads as "you have
-- a problem" when the correct message is "you are fine".
CREATE OR REPLACE FUNCTION fn_check_in(
  p_applicant_id uuid,
  p_stage_id     uuid,
  p_track_id     uuid DEFAULT NULL,
  p_method       text DEFAULT 'qr',
  p_client_ts    timestamptz DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL
) RETURNS TABLE (
  outcome          text,
  check_in_id      uuid,
  applicant_id     uuid,
  display_id       text,
  full_name        text,
  queue_entry_id   uuid,
  queue_position   int,
  track_id         uuid,
  checked_in_at    timestamptz,
  eta_suppressed   boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_applicant   applicants;
  v_cycle_state cycle_state;
  v_stage       stages;
  v_existing    check_ins;
  v_check_in    check_ins;
  v_entry       queue_entries;
  v_track       uuid;
  v_position    int;
  v_open_panels int;
  v_outcome     text;
BEGIN
  SELECT * INTO v_applicant FROM applicants WHERE id = p_applicant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT * INTO v_stage FROM stages WHERE id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT state INTO v_cycle_state FROM cycles WHERE id = v_applicant.cycle_id;

  IF v_cycle_state = 'archived' THEN
    RAISE EXCEPTION 'CYCLE_ARCHIVED' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_stage.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'STAGE_CLOSED' USING ERRCODE = 'raise_exception';
  END IF;

  -- Not eligible → escalate to a Coordinator. Withdrawn and screened-out applicants must not
  -- quietly join a queue they are not in.
  IF v_applicant.state IN ('withdrawn', 'screened_out') THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE: applicant is %', v_applicant.state
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Resolve the track. One general track is the committee's locked decision, so the common
  -- case needs no input from the volunteer at all.
  v_track := p_track_id;
  IF v_track IS NULL THEN
    SELECT t.id INTO v_track
      FROM tracks t
     WHERE t.cycle_id = v_applicant.cycle_id AND t.is_active
     ORDER BY (t.code = 'general') DESC, t.code
     LIMIT 1;

    IF v_track IS NULL THEN
      RAISE EXCEPTION 'no active track configured for this cycle' USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  -- ── Idempotency (FR-CHK-007, FR-CHK-008) ────────────────────────────────────────────
  -- The UNIQUE(applicant_id, stage_id) constraint is the real guarantee; this lookup turns a
  -- constraint violation into the friendly amber response instead of an error.
  SELECT * INTO v_existing
    FROM check_ins
   WHERE applicant_id = p_applicant_id AND stage_id = p_stage_id;

  IF FOUND THEN
    v_check_in := v_existing;
    v_outcome  := 'already';
  ELSE
    INSERT INTO check_ins (
      cycle_id, applicant_id, stage_id, method, checked_in_by, client_ts, client_request_id
    ) VALUES (
      v_applicant.cycle_id, p_applicant_id, p_stage_id, p_method,
      fn_current_user_id(), p_client_ts, p_client_request_id
    )
    RETURNING * INTO v_check_in;

    v_outcome := 'checked_in';

    -- The projection, written by the owning function only (E5, rules.md R-012).
    PERFORM set_config('app.state_writer', 'fn_check_in', true);
    UPDATE applicants SET state = 'checked_in' WHERE id = p_applicant_id;
    PERFORM set_config('app.state_writer', '', true);

    PERFORM fn_audit(
      v_applicant.cycle_id, 'applicant.checked_in', 'check_in', v_check_in.id,
      jsonb_build_object('state', v_applicant.state),
      jsonb_build_object('state', 'checked_in', 'method', p_method, 'stage_id', p_stage_id),
      NULL
    );
  END IF;

  -- Enqueue in the SAME transaction. A check-in that does not reach the queue is an applicant
  -- standing in a hall that believes it has already dealt with them. fn_enqueue is itself
  -- idempotent, so a repeat scan returns the existing entry rather than a second position.
  SELECT * INTO v_entry
    FROM fn_enqueue(p_applicant_id, v_track, p_stage_id);

  -- Position: how many waiting entries outrank this one, by the SAME ordering the claim uses
  -- (FR-QUE-003). Any other ordering here would show a number the queue does not honour.
  SELECT count(*) + 1 INTO v_position
    FROM queue_entries q
   WHERE q.track_id = v_track
     AND q.state = 'waiting'
     AND (q.priority > v_entry.priority
          OR (q.priority = v_entry.priority AND q.enqueued_at < v_entry.enqueued_at));

  -- FR-CHK-011: where the track has no open panel, complete the check-in, SUPPRESS the wait
  -- estimate, and raise an operations alert. Showing an ETA derived from zero panels would be
  -- a number we know to be fiction (principle 2).
  SELECT count(*) INTO v_open_panels
    FROM panels p
    JOIN panel_tracks pt ON pt.panel_id = p.id
   WHERE pt.track_id = v_track AND p.status IN ('open', 'busy');

  IF v_open_panels = 0 AND v_outcome = 'checked_in' THEN
    PERFORM fn_audit(
      v_applicant.cycle_id, 'ops.track_without_panel', 'track', v_track,
      NULL, jsonb_build_object('waiting_count', v_position), 'checked in with no open panel'
    );
  END IF;

  RETURN QUERY SELECT
    v_outcome,
    v_check_in.id,
    v_applicant.id,
    v_applicant.display_id,
    v_applicant.full_name,
    v_entry.id,
    v_position,
    v_track,
    v_check_in.created_at,
    (v_open_panels = 0);
END $$;

COMMENT ON FUNCTION fn_check_in IS
  'Idempotent check-in plus enqueue in one transaction. Returns outcome=already for a repeat scan, which the UI must render AMBER, not red (FR-CHK-006, NFR-USE-004).';


-- ── Resolve a scanned token to an applicant, for check-in ───────────────────────────────
--
-- Separate from fn_resolve_token (migration 0011, which serves the applicant status page) so
-- the two can diverge safely: this one is called by staff and returns the eligibility detail a
-- desk needs, while that one is called by an unauthenticated applicant and must stay minimal.
CREATE OR REPLACE FUNCTION fn_resolve_token_for_checkin(p_token_hash bytea)
RETURNS TABLE (
  applicant_id uuid,
  display_id   text,
  full_name    text,
  state        applicant_state,
  cycle_id     uuid,
  revoked      boolean,
  expired      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.display_id, a.full_name, a.state, a.cycle_id,
         (t.revoked_at IS NOT NULL),
         (t.expires_at <= now())
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE t.token_hash = p_token_hash
   LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION fn_resolve_token_for_checkin(bytea) TO rms_app;


-- ── Offline roster bundle (FR-CHK-018, NFR-PERF-009) ───────────────────────────────────
--
-- Returns token hashes and NOTHING else. Not names, not emails, not states — a device lost at
-- the venue leaks a set of opaque hashes, which permits neither forgery nor identification.
--
-- The public key is fetched separately from cycles; keeping it out of this function means a
-- future change here cannot accidentally start returning private material.
CREATE OR REPLACE FUNCTION fn_roster_bundle(p_cycle_id uuid)
RETURNS TABLE (token_hash_b64 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT encode(t.token_hash, 'base64')
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE a.cycle_id = p_cycle_id
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND a.state NOT IN ('withdrawn', 'screened_out')
$$;

COMMENT ON FUNCTION fn_roster_bundle IS
  'Token hashes ONLY. No names, states, scores or key material — FR-CHK-018. A lost device must leak nothing useful.';

GRANT EXECUTE ON FUNCTION fn_roster_bundle(uuid) TO rms_app;

COMMIT;
