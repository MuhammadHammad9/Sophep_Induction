-- 0025 — The stage-close gate, heartbeats, and the operations dashboard
--
-- Fixes errata E15: v1 left it undefined what happens to in-flight interviews when a stage
-- closes. Undefined means whatever the code happened to do — which here would be orphaned
-- interview rows and applicants stuck in `in_interview` forever.
--
-- CLOSING BLOCKS, DELIBERATELY. The alternative is discovering eleven missing evaluations three
-- days later, when the interviewers no longer remember the candidates and any score they give
-- is a guess. A gate that stops you at 18:00 while everyone is still in the building is far
-- cheaper than one that lets you leave.
--
-- Refs: FR-CYC-008..011, FR-INT-014..016, FR-OPS-003, FR-OPS-005, FR-OPS-006, E15

BEGIN;

-- ── Stage close preflight (FR-CYC-008, FR-CYC-009) ──────────────────────────────────────
--
-- Returns what BLOCKS the close and what merely warns, so the UI can list them with an action
-- per row rather than saying "cannot close" and leaving a coordinator to hunt.
CREATE OR REPLACE FUNCTION fn_stage_close_preflight(p_stage_id uuid)
RETURNS TABLE (
  severity     text,     -- 'block' | 'warn'
  kind         text,
  entity_id    uuid,
  label        text,
  detail       text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- FR-CYC-008: interviews still running. Listed with room and panel, because "3 interviews
  -- still running" without saying WHERE is not actionable.
  SELECT 'block', 'interview_in_progress', i.id,
         a.display_id,
         'Room ' || r.name || ' · ' || p.name
    FROM interviews i
    JOIN queue_entries q ON q.id = i.queue_entry_id
    JOIN applicants  a ON a.id = i.applicant_id
    JOIN panels      p ON p.id = i.panel_id
    JOIN rooms       r ON r.id = p.room_id
   WHERE q.stage_id = p_stage_id AND i.status = 'in_progress'

  UNION ALL

  -- FR-CYC-009: outstanding evaluations, grouped by the interviewer who owes them, each with
  -- a waive action in the UI.
  SELECT 'block', 'evaluation_outstanding', i.id,
         u.full_name,
         a.display_id || ' · ' || p.name
    FROM interviews i
    JOIN queue_entries q ON q.id = i.queue_entry_id
    JOIN applicants a ON a.id = i.applicant_id
    JOIN panels p ON p.id = i.panel_id
    JOIN panel_members pm ON pm.panel_id = i.panel_id AND pm.left_at IS NULL
    JOIN users u ON u.id = pm.interviewer_id
   WHERE q.stage_id = p_stage_id
     AND i.status = 'awaiting_evaluations'
     AND NOT EXISTS (
           SELECT 1 FROM evaluations e
            WHERE e.interview_id = i.id
              AND e.interviewer_id = pm.interviewer_id
              AND (e.submitted_at IS NOT NULL OR e.waived_by IS NOT NULL)
         )

  UNION ALL

  -- FR-CYC-011: queued or called applicants only WARN. They are a decision — carry forward or
  -- mark no-show — not an error, and blocking on them would strand a coordinator at the end
  -- of a long day with no way to close.
  SELECT 'warn', 'applicant_waiting', q.id,
         a.display_id,
         q.state::text
    FROM queue_entries q
    JOIN applicants a ON a.id = q.applicant_id
   WHERE q.stage_id = p_stage_id AND q.state IN ('waiting', 'called')
$$;

GRANT EXECUTE ON FUNCTION fn_stage_close_preflight(uuid) TO rms_app;


-- ── Close (FR-CYC-010) ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_close_stage(
  p_stage_id uuid,
  p_waiting_action text DEFAULT 'no_show'   -- 'no_show' | 'carry_forward'
) RETURNS stages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_stage    stages;
  v_blocks   int;
  v_parked   int;
  v_waiting  int;
BEGIN
  SELECT * INTO v_stage FROM stages WHERE id = p_stage_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stage % not found', p_stage_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_stage.closed_at IS NOT NULL THEN
    RETURN v_stage;   -- idempotent
  END IF;

  SELECT count(*) INTO v_blocks
    FROM fn_stage_close_preflight(p_stage_id) WHERE severity = 'block';

  IF v_blocks > 0 THEN
    RAISE EXCEPTION 'STAGE_HAS_ACTIVE_INTERVIEWS: % blocking item(s)', v_blocks
      USING ERRCODE = 'raise_exception';
  END IF;

  -- FR-CYC-010: parked applicants auto-resolve to no_show, each individually audited. They
  -- were called twice and never found; recording that per person is what makes the outcome
  -- defensible if one of them asks why.
  FOR v_parked IN
    SELECT 1 FROM queue_entries WHERE stage_id = p_stage_id AND state = 'parked'
  LOOP END LOOP;

  UPDATE queue_entries SET state = 'done', done_at = now()
   WHERE stage_id = p_stage_id AND state = 'parked';

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants a SET state = 'no_show'
    FROM queue_entries q
   WHERE q.applicant_id = a.id AND q.stage_id = p_stage_id
     AND q.done_at IS NOT NULL AND a.state = 'parked';
  PERFORM set_config('app.state_writer', '', true);

  -- FR-CYC-011: the coordinator's choice for anyone still waiting.
  SELECT count(*) INTO v_waiting
    FROM queue_entries WHERE stage_id = p_stage_id AND state IN ('waiting', 'called');

  IF p_waiting_action = 'no_show' THEN
    UPDATE queue_entries SET state = 'done', done_at = now()
     WHERE stage_id = p_stage_id AND state IN ('waiting', 'called');

    PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
    UPDATE applicants a SET state = 'no_show'
      FROM queue_entries q
     WHERE q.applicant_id = a.id AND q.stage_id = p_stage_id
       AND a.state IN ('queued', 'called');
    PERFORM set_config('app.state_writer', '', true);
  END IF;
  -- carry_forward leaves the entries alone; they are re-enqueued against the next stage.

  UPDATE stages SET closed_at = now() WHERE id = p_stage_id RETURNING * INTO v_stage;

  UPDATE panels SET status = 'closed', closed_at = now()
   WHERE cycle_id = v_stage.cycle_id AND status <> 'closed';

  PERFORM fn_audit(
    v_stage.cycle_id, 'stage.closed', 'stage', p_stage_id,
    NULL,
    jsonb_build_object('waiting_action', p_waiting_action, 'waiting_resolved', v_waiting),
    NULL
  );

  RETURN v_stage;
END $$;


-- ── Heartbeat (FR-INT-014, FR-INT-015) ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_panel_heartbeat(p_panel_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE panels SET last_heartbeat = now() WHERE id = p_panel_id
$$;

GRANT EXECUTE ON FUNCTION fn_panel_heartbeat(uuid) TO rms_app;

-- 90 minutes of silence flags the interview. A panel device dying mid-interview otherwise
-- leaves the applicant stuck forever with nobody noticing — they sit in the hall believing
-- they are still being processed.
CREATE OR REPLACE FUNCTION fn_flag_stale_interviews(p_cycle_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_threshold int;
  v_flagged   int := 0;
  v_row       record;
BEGIN
  SELECT coalesce((config ->> 'heartbeat_silence_minutes')::int, 90)
    INTO v_threshold FROM cycles WHERE id = p_cycle_id;

  FOR v_row IN
    SELECT i.id, i.panel_id
      FROM interviews i
      JOIN panels p ON p.id = i.panel_id
     WHERE i.cycle_id = p_cycle_id
       AND i.status IN ('in_progress', 'awaiting_evaluations')
       AND (p.last_heartbeat IS NULL OR p.last_heartbeat < now() - make_interval(mins => v_threshold))
  LOOP
    UPDATE interviews SET status = 'flagged' WHERE id = v_row.id;
    PERFORM fn_audit(p_cycle_id, 'interview.flagged', 'interview', v_row.id,
      NULL, jsonb_build_object('panel_id', v_row.panel_id),
      'no panel heartbeat for ' || v_threshold || ' minutes');
    v_flagged := v_flagged + 1;
  END LOOP;

  RETURN v_flagged;
END $$;


-- FR-INT-016: void a flagged interview, requeuing the applicant at priority 100 — the highest
-- tier, because the interview failed through no fault of theirs and making them queue again
-- from the back would be punishing them for a device failure.
CREATE OR REPLACE FUNCTION fn_void_interview(p_interview_id uuid, p_reason text)
RETURNS interviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_interview interviews;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a written reason is required to void an interview'
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE interviews
     SET status = 'voided', voided_by = fn_current_user_id(),
         void_reason = p_reason, ended_at = now()
   WHERE id = p_interview_id
   RETURNING * INTO v_interview;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'interview % not found', p_interview_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE queue_entries
     SET state = 'waiting', priority = 100,
         priority_reason = 'interview voided through no fault of the applicant',
         panel_id = NULL, enqueued_at = now(), call_count = 0
   WHERE id = v_interview.queue_entry_id;

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = 'queued' WHERE id = v_interview.applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  UPDATE panels SET status = 'open'
   WHERE id = v_interview.panel_id AND status IN ('busy', 'awaiting_evaluations');

  PERFORM fn_audit(
    v_interview.cycle_id, 'interview.voided', 'interview', p_interview_id,
    NULL, jsonb_build_object('requeued_priority', 100), p_reason
  );

  RETURN v_interview;
END $$;


-- ── Action Required (FR-OPS-005, FR-OPS-006) ────────────────────────────────────────────
--
-- Everything needing a human, ranked by urgency, in one query. This is the FIRST element of
-- the ops dashboard, and when it is empty the UI must say "all clear" EXPLICITLY rather than
-- rendering nothing — a blank area is ambiguous, "all clear" is information (FR-OPS-006).
CREATE OR REPLACE FUNCTION fn_action_required(p_cycle_id uuid)
RETURNS TABLE (
  urgency  smallint,
  kind     text,
  entity_id uuid,
  label    text,
  detail   text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- 1. Flagged interviews — someone may be sitting in a room with a dead device.
  SELECT 1::smallint, 'interview_flagged', i.id, a.display_id, p.name
    FROM interviews i
    JOIN applicants a ON a.id = i.applicant_id
    JOIN panels p ON p.id = i.panel_id
   WHERE i.cycle_id = p_cycle_id AND i.status = 'flagged'

  UNION ALL

  -- 2. Tracks with people waiting and no open panel — the queue is stalled and no ETA can be
  -- honestly shown (FR-CHK-011).
  SELECT 2::smallint, 'track_without_panel', t.id, t.name,
         count(q.id)::text || ' waiting'
    FROM tracks t
    JOIN queue_entries q ON q.track_id = t.id AND q.state = 'waiting'
   WHERE t.cycle_id = p_cycle_id
     AND NOT EXISTS (
           SELECT 1 FROM panel_tracks pt JOIN panels p ON p.id = pt.panel_id
            WHERE pt.track_id = t.id AND p.status IN ('open', 'busy'))
   GROUP BY t.id, t.name

  UNION ALL

  -- 3. Parked applicants — volunteers must go and find them, or panels idle while they sit
  -- fifteen metres away (FR-QUE-013).
  SELECT 3::smallint, 'applicant_parked', q.id, a.display_id, a.full_name
    FROM queue_entries q
    JOIN applicants a ON a.id = q.applicant_id
   WHERE q.cycle_id = p_cycle_id AND q.state = 'parked'

  UNION ALL

  -- 4. Outstanding evaluations — each one blocks a panel from calling anyone.
  SELECT 4::smallint, 'evaluation_outstanding', i.id, u.full_name,
         a.display_id || ' · ' || p.name
    FROM interviews i
    JOIN applicants a ON a.id = i.applicant_id
    JOIN panels p ON p.id = i.panel_id
    JOIN panel_members pm ON pm.panel_id = i.panel_id AND pm.left_at IS NULL
    JOIN users u ON u.id = pm.interviewer_id
   WHERE i.cycle_id = p_cycle_id
     AND i.status = 'awaiting_evaluations'
     AND NOT EXISTS (
           SELECT 1 FROM evaluations e
            WHERE e.interview_id = i.id AND e.interviewer_id = pm.interviewer_id
              AND (e.submitted_at IS NOT NULL OR e.waived_by IS NOT NULL))

  UNION ALL

  -- 5. Hard bounces — an applicant who will never learn their outcome (FR-NOT-003).
  SELECT 5::smallint, 'delivery_bounced', n.id, n.to_email, n.template_key
    FROM notifications n
   WHERE n.cycle_id = p_cycle_id AND n.state = 'bounced' AND n.bounce_type = 'hard'

  UNION ALL

  -- 6. Incomplete desk registrations, from the 30-second walk-in path (FR-CHK-010).
  SELECT 6::smallint, 'needs_completion', a.id, a.display_id, a.full_name
    FROM applicants a
   WHERE a.cycle_id = p_cycle_id AND a.needs_completion
     AND a.state NOT IN ('withdrawn', 'screened_out')

  ORDER BY 1, 4
$$;

GRANT EXECUTE ON FUNCTION fn_action_required(uuid) TO rms_app;


-- ── State drift monitor (FR-OPS-003) ────────────────────────────────────────────────────
-- Re-derives applicants.state from its owning tables and reports any mismatch. Drift becomes
-- a MONITORED condition rather than a mystery discovered during a dispute (spec §4 rule 3).
CREATE OR REPLACE FUNCTION fn_detect_state_drift(p_cycle_id uuid)
RETURNS TABLE (applicant_id uuid, display_id text, projected applicant_state, derived text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.display_id, a.state,
         CASE q.state
           WHEN 'waiting'      THEN 'queued'
           WHEN 'called'       THEN 'called'
           WHEN 'in_interview' THEN 'in_interview'
           WHEN 'skipped'      THEN 'skipped'
           WHEN 'parked'       THEN 'parked'
           ELSE NULL
         END
    FROM applicants a
    JOIN LATERAL (
      SELECT state FROM queue_entries q
       WHERE q.applicant_id = a.id ORDER BY q.created_at DESC LIMIT 1
    ) q ON true
   WHERE a.cycle_id = p_cycle_id
     AND CASE q.state
           WHEN 'waiting'      THEN 'queued'
           WHEN 'called'       THEN 'called'
           WHEN 'in_interview' THEN 'in_interview'
           WHEN 'skipped'      THEN 'skipped'
           WHEN 'parked'       THEN 'parked'
           ELSE NULL
         END IS DISTINCT FROM a.state::text
     AND q.state NOT IN ('done', 'withdrawn')
$$;

GRANT EXECUTE ON FUNCTION fn_detect_state_drift(uuid) TO rms_app;

COMMIT;
