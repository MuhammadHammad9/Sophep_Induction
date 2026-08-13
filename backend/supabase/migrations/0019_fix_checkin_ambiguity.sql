-- 0019 — Fix an ambiguous column reference in fn_check_in
--
-- Found by tests/concurrency/checkin.test.ts: "column reference applicant_id is ambiguous".
--
-- In plpgsql, the column names declared in RETURNS TABLE become variables in scope for the
-- whole function body. fn_check_in returns a column called `applicant_id`, so inside the body
-- an unqualified `applicant_id` in
--
--     SELECT * FROM check_ins WHERE applicant_id = p_applicant_id
--
-- is ambiguous between the OUT variable and check_ins.applicant_id, and Postgres refuses to
-- guess. The fix is to qualify every column reference with a table alias.
--
-- Worth noting the failure mode: this is a RUNTIME error, not a creation-time one. The
-- function was created successfully by migration 0018 and only failed when called — so a
-- deployment could look entirely healthy right up until the first person tried to check in.
--
-- Amended here rather than by editing 0018, which has already been applied (rules.md R-053:
-- an applied migration is history, not source).
--
-- Refs: FR-CHK-006..011

BEGIN;

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
  SELECT a.* INTO v_applicant FROM applicants a WHERE a.id = p_applicant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT s.* INTO v_stage FROM stages s WHERE s.id = p_stage_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT c.state INTO v_cycle_state FROM cycles c WHERE c.id = v_applicant.cycle_id;

  IF v_cycle_state = 'archived' THEN
    RAISE EXCEPTION 'CYCLE_ARCHIVED' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_stage.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'STAGE_CLOSED' USING ERRCODE = 'raise_exception';
  END IF;

  -- Withdrawn and screened-out applicants must not quietly join a queue they are not in.
  IF v_applicant.state IN ('withdrawn', 'screened_out') THEN
    RAISE EXCEPTION 'NOT_ELIGIBLE: applicant is %', v_applicant.state
      USING ERRCODE = 'raise_exception';
  END IF;

  -- One general track is the locked decision, so the common case needs no volunteer input.
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

  -- Idempotency (FR-CHK-007, FR-CHK-008). UNIQUE(applicant_id, stage_id) is the real
  -- guarantee; this lookup turns a constraint violation into the amber response.
  SELECT ci.* INTO v_existing
    FROM check_ins ci
   WHERE ci.applicant_id = p_applicant_id AND ci.stage_id = p_stage_id;

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

    PERFORM set_config('app.state_writer', 'fn_check_in', true);
    UPDATE applicants a SET state = 'checked_in' WHERE a.id = p_applicant_id;
    PERFORM set_config('app.state_writer', '', true);

    PERFORM fn_audit(
      v_applicant.cycle_id, 'applicant.checked_in', 'check_in', v_check_in.id,
      jsonb_build_object('state', v_applicant.state),
      jsonb_build_object('state', 'checked_in', 'method', p_method, 'stage_id', p_stage_id),
      NULL
    );
  END IF;

  -- Enqueue in the SAME transaction. A check-in that does not reach the queue is an applicant
  -- standing in a hall that believes it has already dealt with them.
  SELECT e.* INTO v_entry FROM fn_enqueue(p_applicant_id, v_track, p_stage_id) e;

  -- Position by the SAME ordering the claim uses (FR-QUE-003). Any other would display a
  -- number the queue does not honour.
  SELECT count(*) + 1 INTO v_position
    FROM queue_entries q
   WHERE q.track_id = v_track
     AND q.state = 'waiting'
     AND (q.priority > v_entry.priority
          OR (q.priority = v_entry.priority AND q.enqueued_at < v_entry.enqueued_at));

  -- FR-CHK-011: no open panel → check in anyway, suppress the ETA, raise an ops alert.
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

  outcome        := v_outcome;
  check_in_id    := v_check_in.id;
  applicant_id   := v_applicant.id;
  display_id     := v_applicant.display_id;
  full_name      := v_applicant.full_name;
  queue_entry_id := v_entry.id;
  queue_position := v_position;
  track_id       := v_track;
  checked_in_at  := v_check_in.created_at;
  eta_suppressed := (v_open_panels = 0);
  RETURN NEXT;
END $$;

COMMIT;
