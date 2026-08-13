-- 0016 — The queue engine
--
-- This is the part of the system that cannot be improvised on the floor. Everything else has
-- a manual fallback: scoring can be done on paper, results can be emailed by hand. A queue
-- cannot — two hundred people in a hall need to be called in a defensible order, exactly once
-- each, and no amount of shouting recovers from a double assignment.
--
-- THE CLAIM IS PULL-BASED (FR-QUE-001). A panel that is genuinely free asks for the next
-- applicant. Push assignment goes stale the moment one interview overruns: the applicant is
-- told Room 2 while Room 2 is twenty minutes behind, and now a volunteer is mediating.
--
-- `FOR UPDATE SKIP LOCKED` is the whole trick. Ten panels can press Call Next in the same
-- millisecond and each receives a DIFFERENT applicant — no application locking, no retries,
-- no possibility of a double assignment. Zero rows means the queue is genuinely empty.
--
-- `NOT EXISTS`, never `NOT IN` (E7). `NOT IN` returns zero rows if its subquery yields a
-- single NULL: a total, silent queue stall that on the floor looks like "the system just
-- stopped giving us applicants."
--
-- Refs: FR-QUE-001..020, FR-OPS-001, E5, E7, rules.md R-012, R-013

BEGIN;

-- ── fn_queue_transition — sole owner of event-day applicant state ───────────────────────
--
-- Every queue state change goes through here, so applicants.state is projected in the SAME
-- transaction as queue_entries.state and the two cannot drift (E5). Also writes the audit row
-- (FR-AUD-002) — no audit, no commit.
CREATE OR REPLACE FUNCTION fn_queue_transition(
  p_entry_id uuid,
  p_to_state queue_state,
  p_reason   text DEFAULT NULL,
  p_panel_id uuid DEFAULT NULL
) RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before queue_entries;
  v_after  queue_entries;
  v_applicant_state applicant_state;
BEGIN
  SELECT * INTO v_before FROM queue_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue entry % not found', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_before.state = p_to_state THEN
    RETURN v_before;   -- idempotent; no spurious audit row
  END IF;

  UPDATE queue_entries
     SET state    = p_to_state,
         panel_id = coalesce(p_panel_id, panel_id),
         called_at = CASE WHEN p_to_state = 'called' THEN now() ELSE called_at END,
         done_at   = CASE WHEN p_to_state IN ('done', 'withdrawn') THEN now() ELSE done_at END,
         priority_reason = coalesce(p_reason, priority_reason)
   WHERE id = p_entry_id
   RETURNING * INTO v_after;

  -- The projection. Note this is the ONLY place event-day applicant state is written.
  v_applicant_state := CASE p_to_state
    WHEN 'waiting'      THEN 'queued'
    WHEN 'called'       THEN 'called'
    WHEN 'in_interview' THEN 'in_interview'
    WHEN 'done'         THEN 'interview_complete'
    WHEN 'skipped'      THEN 'skipped'
    WHEN 'parked'       THEN 'parked'
    WHEN 'withdrawn'    THEN 'withdrawn'
  END::applicant_state;

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = v_applicant_state WHERE id = v_after.applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(
    v_after.cycle_id, 'queue.' || p_to_state::text, 'queue_entry', p_entry_id,
    jsonb_build_object('state', v_before.state, 'panel_id', v_before.panel_id),
    jsonb_build_object('state', v_after.state,  'panel_id', v_after.panel_id),
    p_reason
  );

  RETURN v_after;
END $$;

COMMENT ON FUNCTION fn_queue_transition IS
  'Sole owner of event-day applicants.state. Projects in the same transaction as queue_entries.state. E5, FR-OPS-002';


-- ── fn_enqueue — put a checked-in applicant into a track queue ──────────────────────────
CREATE OR REPLACE FUNCTION fn_enqueue(
  p_applicant_id uuid,
  p_track_id     uuid,
  p_stage_id     uuid,
  p_priority     smallint DEFAULT 10,
  p_reason       text DEFAULT NULL,
  p_round        smallint DEFAULT 1
) RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
  v_entry    queue_entries;
BEGIN
  SELECT cycle_id INTO v_cycle_id FROM applicants WHERE id = p_applicant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  IF p_priority NOT IN (5, 10, 30, 50, 100) THEN
    RAISE EXCEPTION 'priority % is not a defined tier (5, 10, 30, 50, 100)', p_priority
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Idempotent: scanning the same QR twice must not produce two queue positions.
  SELECT * INTO v_entry
    FROM queue_entries
   WHERE applicant_id = p_applicant_id AND track_id = p_track_id AND round = p_round;

  IF FOUND THEN
    RETURN v_entry;
  END IF;

  INSERT INTO queue_entries (
    cycle_id, applicant_id, track_id, stage_id, round, state, priority, priority_reason
  ) VALUES (
    v_cycle_id, p_applicant_id, p_track_id, p_stage_id, p_round, 'waiting', p_priority, p_reason
  )
  RETURNING * INTO v_entry;

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = 'queued' WHERE id = p_applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(
    v_cycle_id, 'queue.enqueued', 'queue_entry', v_entry.id,
    NULL,
    jsonb_build_object('track_id', p_track_id, 'priority', p_priority, 'round', p_round),
    p_reason
  );

  RETURN v_entry;
END $$;


-- ── fn_claim_next — THE CLAIM (FR-QUE-002) ──────────────────────────────────────────────
--
-- Returns zero rows when the queue is genuinely empty, which the caller must distinguish from
-- an error. The panel state gate is inside this function, not in the UI: a disabled button is
-- ergonomics, never a control (FR-RBAC-004).
CREATE OR REPLACE FUNCTION fn_claim_next(p_panel_id uuid)
RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_panel        panels;
  v_entry        queue_entries;
  v_grace        int;
BEGIN
  SELECT * INTO v_panel FROM panels WHERE id = p_panel_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'panel % not found', p_panel_id USING ERRCODE = 'no_data_found';
  END IF;

  -- FR-INT-013: a panel awaiting evaluations cannot claim. The UI must also state WHICH
  -- interviewer is outstanding — a greyed-out control with no explanation is a defect
  -- (rules.md R-058).
  IF v_panel.status = 'awaiting_evaluations' THEN
    RAISE EXCEPTION 'PANEL_AWAITING_EVALUATIONS' USING ERRCODE = 'raise_exception';
  END IF;

  IF v_panel.status NOT IN ('open', 'busy') THEN
    RAISE EXCEPTION 'PANEL_NOT_OPEN' USING ERRCODE = 'raise_exception';
  END IF;

  -- The claim.
  --
  -- FOR UPDATE SKIP LOCKED: concurrent callers skip rows another transaction has locked
  -- rather than queueing behind them, so each gets a different applicant. Without SKIP
  -- LOCKED, ten panels would serialise on the same head-of-queue row and nine would receive
  -- the same applicant once the first committed.
  --
  -- NOT EXISTS, never NOT IN (E7, rules.md R-013).
  SELECT q.* INTO v_entry
    FROM queue_entries q
   WHERE q.cycle_id = v_panel.cycle_id
     AND q.state    = 'waiting'
     AND q.track_id IN (SELECT track_id FROM panel_tracks WHERE panel_id = p_panel_id)
     AND NOT EXISTS (
           SELECT 1
             FROM recusals r
             JOIN panel_members pm
               ON pm.interviewer_id = r.interviewer_id
              AND pm.panel_id = p_panel_id
              AND pm.left_at IS NULL
            WHERE r.applicant_id = q.applicant_id
         )
   ORDER BY q.priority DESC, q.enqueued_at ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;   -- QUEUE_EMPTY — genuinely empty, not an error
  END IF;

  SELECT coalesce((config ->> 'grace_window_minutes')::int, 5)
    INTO v_grace FROM cycles WHERE id = v_panel.cycle_id;

  UPDATE queue_entries
     SET state = 'called', panel_id = p_panel_id,
         called_at = now(), call_count = call_count + 1
   WHERE id = v_entry.id
   RETURNING * INTO v_entry;

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = 'called' WHERE id = v_entry.applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  UPDATE panels SET status = 'busy', last_heartbeat = now() WHERE id = p_panel_id;

  PERFORM fn_audit(
    v_entry.cycle_id, 'queue.called', 'queue_entry', v_entry.id,
    jsonb_build_object('state', 'waiting'),
    jsonb_build_object('state', 'called', 'panel_id', p_panel_id,
                       'call_count', v_entry.call_count,
                       'grace_expires_at', now() + make_interval(mins => v_grace)),
    NULL
  );

  RETURN v_entry;
END $$;

COMMENT ON FUNCTION fn_claim_next IS
  'Atomic pull-based claim. FOR UPDATE SKIP LOCKED makes double assignment structurally impossible; NOT EXISTS keeps a NULL recusal from stalling the queue. FR-QUE-002, FR-QUE-006, E7';


-- ── Grace expiry: skip, requeue, park (FR-QUE-010..012) ─────────────────────────────────
--
-- A SOFT penalty, deliberately. Sending someone from position 3 to position 40 over a
-- two-minute absence provokes an argument at the desk that costs more time than the delay did.
-- First skip returns them at priority 30 with enqueued_at backdated 10 minutes, so they
-- re-enter near where they were rather than at the back.
CREATE OR REPLACE FUNCTION fn_expire_grace(p_entry_id uuid)
RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry queue_entries;
BEGIN
  SELECT * INTO v_entry FROM queue_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue entry % not found', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_entry.state <> 'called' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: grace can only expire from called, not %', v_entry.state
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Free the panel immediately: it must be able to claim the next applicant without waiting
  -- for anyone to notice (FR-QUE-010).
  UPDATE panels SET status = 'open'
   WHERE id = v_entry.panel_id AND status = 'busy';

  IF v_entry.call_count >= 2 THEN
    -- Second skip → parked. Off the panel-visible queue, onto the volunteer worklist.
    UPDATE queue_entries
       SET state = 'parked', panel_id = NULL
     WHERE id = p_entry_id
     RETURNING * INTO v_entry;

    PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
    UPDATE applicants SET state = 'parked' WHERE id = v_entry.applicant_id;
    PERFORM set_config('app.state_writer', '', true);

    PERFORM fn_audit(v_entry.cycle_id, 'queue.parked', 'queue_entry', p_entry_id,
      jsonb_build_object('state', 'called', 'call_count', v_entry.call_count),
      jsonb_build_object('state', 'parked'), 'second no-show');
  ELSE
    -- First skip → requeue at priority 30, effective enqueue time backdated 10 minutes.
    UPDATE queue_entries
       SET state = 'waiting',
           priority = 30,
           priority_reason = 'returned after a missed call',
           enqueued_at = now() - interval '10 minutes',
           panel_id = NULL
     WHERE id = p_entry_id
     RETURNING * INTO v_entry;

    PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
    UPDATE applicants SET state = 'queued' WHERE id = v_entry.applicant_id;
    PERFORM set_config('app.state_writer', '', true);

    PERFORM fn_audit(v_entry.cycle_id, 'queue.skipped', 'queue_entry', p_entry_id,
      jsonb_build_object('state', 'called'),
      jsonb_build_object('state', 'waiting', 'priority', 30), 'missed call, requeued');
  END IF;

  RETURN v_entry;
END $$;


-- FR-QUE-009: "I'm on my way" — one extension per call, exactly once. Each avoided skip is an
-- argument that never happens at the desk.
CREATE OR REPLACE FUNCTION fn_extend_grace(p_entry_id uuid)
RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry queue_entries;
BEGIN
  SELECT * INTO v_entry FROM queue_entries WHERE id = p_entry_id FOR UPDATE;

  IF v_entry.state <> 'called' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: not currently called' USING ERRCODE = 'raise_exception';
  END IF;
  IF v_entry.grace_extended THEN
    RAISE EXCEPTION 'GRACE_ALREADY_EXTENDED' USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE queue_entries SET grace_extended = true WHERE id = p_entry_id
  RETURNING * INTO v_entry;

  PERFORM fn_audit(v_entry.cycle_id, 'queue.grace_extended', 'queue_entry', p_entry_id,
    NULL, jsonb_build_object('grace_extended', true), 'applicant tapped "on my way"');

  RETURN v_entry;
END $$;


-- FR-QUE-014: any volunteer can reactivate a parked applicant, returning them at priority 30.
CREATE OR REPLACE FUNCTION fn_reactivate_parked(p_entry_id uuid, p_reason text DEFAULT NULL)
RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_entry queue_entries;
BEGIN
  SELECT * INTO v_entry FROM queue_entries WHERE id = p_entry_id FOR UPDATE;

  IF v_entry.state <> 'parked' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: entry is %, not parked', v_entry.state
      USING ERRCODE = 'raise_exception';
  END IF;

  UPDATE queue_entries
     SET state = 'waiting', priority = 30, call_count = 0,
         priority_reason = coalesce(p_reason, 'reactivated after being located'),
         enqueued_at = now()
   WHERE id = p_entry_id
   RETURNING * INTO v_entry;

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = 'queued' WHERE id = v_entry.applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(v_entry.cycle_id, 'queue.reactivated', 'queue_entry', p_entry_id,
    jsonb_build_object('state', 'parked'),
    jsonb_build_object('state', 'waiting', 'priority', 30), p_reason);

  RETURN v_entry;
END $$;


-- FR-QUE-005: a Coordinator may set any entry's priority, with a MANDATORY reason recorded in
-- the audit log. Floor managers will need to bump someone; a system that forbids it is a
-- system they stop using — but every bump must be answerable afterwards.
CREATE OR REPLACE FUNCTION fn_set_priority(
  p_entry_id uuid,
  p_priority smallint,
  p_reason   text
) RETURNS queue_entries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before queue_entries;
  v_after  queue_entries;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'a reason of at least 5 characters is required to change priority'
      USING ERRCODE = 'raise_exception';
  END IF;
  IF p_priority NOT IN (5, 10, 30, 50, 100) THEN
    RAISE EXCEPTION 'priority % is not a defined tier', p_priority USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_before FROM queue_entries WHERE id = p_entry_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'queue entry % not found', p_entry_id USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE queue_entries SET priority = p_priority, priority_reason = p_reason
   WHERE id = p_entry_id RETURNING * INTO v_after;

  PERFORM fn_audit(v_after.cycle_id, 'queue.priority_changed', 'queue_entry', p_entry_id,
    jsonb_build_object('priority', v_before.priority),
    jsonb_build_object('priority', v_after.priority), p_reason);

  RETURN v_after;
END $$;


-- FR-QUE-020: withdrawal deletes the queue entry in the SAME transaction as the state change,
-- so a withdrawn applicant cannot be claimed by a panel a moment later.
CREATE OR REPLACE FUNCTION fn_withdraw_from_queue(p_applicant_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
BEGIN
  SELECT cycle_id INTO v_cycle_id FROM applicants WHERE id = p_applicant_id;

  DELETE FROM queue_entries
   WHERE applicant_id = p_applicant_id AND state IN ('waiting', 'called', 'parked', 'skipped');

  PERFORM set_config('app.state_writer', 'fn_queue_transition', true);
  UPDATE applicants SET state = 'withdrawn', withdrawn_at = now() WHERE id = p_applicant_id;
  PERFORM set_config('app.state_writer', '', true);

  PERFORM fn_audit(v_cycle_id, 'applicant.withdrawn', 'applicant', p_applicant_id,
    NULL, jsonb_build_object('state', 'withdrawn'), p_reason);
END $$;

COMMIT;
