-- 0021 — The applicant status payload
--
-- Found by live-testing the status page: the API returned 200 with a correct state but
-- position null and an empty estimate, on an applicant who was demonstrably queued.
--
-- THE CAUSE: the route joined `stages` to get the stage start time (needed to decide whether
-- the estimate is still suppressed for the first 15 minutes). `stages` has RLS requiring a
-- membership in the cycle, and an applicant has none — correctly. So the INNER JOIN silently
-- eliminated the row, and the handler fell through to its "no queue entry" branch.
--
-- This is the failure mode RLS always has: it does not error, it returns fewer rows. The page
-- rendered, the request succeeded, and the applicant simply saw no position. On the day that
-- looks like the system forgetting them.
--
-- THE FIX: one SECURITY DEFINER function returning exactly what the status page renders,
-- scoped by the token hash. Not a broader policy on `stages` — the applicant does not need
-- read access to the stage table, only to one number derived from it.
--
-- Returns NAMED COLUMNS, never SELECT *, so a future migration adding a column to
-- queue_entries cannot start leaking it to an unauthenticated caller (NFR-PRIV-005).
--
-- Refs: FR-QUE-015..019, NFR-PRIV-005, NFR-USE-005

BEGIN;

CREATE OR REPLACE FUNCTION fn_applicant_status(p_token_hash bytea)
RETURNS TABLE (
  applicant_id     uuid,
  display_id       text,
  applicant_state  applicant_state,
  queue_entry_id   uuid,
  queue_entry_state queue_state,
  queue_position   int,
  room_name        text,
  called_at        timestamptz,
  grace_extended   boolean,
  grace_window_minutes int,
  stage_running_minutes int,
  open_panels      int,
  track_id         uuid,
  cycle_id         uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_applicant applicants;
  v_entry     queue_entries;
  v_stage     stages;
BEGIN
  SELECT a.* INTO v_applicant
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE t.token_hash = p_token_hash
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;   -- zero rows: unknown, revoked or expired. The caller renders a 404.
  END IF;

  applicant_id    := v_applicant.id;
  display_id      := v_applicant.display_id;
  applicant_state := v_applicant.state;
  cycle_id        := v_applicant.cycle_id;

  -- The most recent queue entry. An applicant may have several across rounds; the live page
  -- is always about the current one.
  SELECT q.* INTO v_entry
    FROM queue_entries q
   WHERE q.applicant_id = v_applicant.id
   ORDER BY q.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEXT;   -- registered but not yet in a queue
    RETURN;
  END IF;

  queue_entry_id    := v_entry.id;
  queue_entry_state := v_entry.state;
  called_at         := v_entry.called_at;
  grace_extended    := v_entry.grace_extended;
  track_id          := v_entry.track_id;

  SELECT s.* INTO v_stage FROM stages s WHERE s.id = v_entry.stage_id;
  stage_running_minutes := GREATEST(
    0, floor(extract(epoch FROM (now() - v_stage.starts_at)) / 60)::int
  );

  SELECT coalesce((c.config ->> 'grace_window_minutes')::int, 5)
    INTO grace_window_minutes
    FROM cycles c WHERE c.id = v_applicant.cycle_id;

  -- Position by the SAME ordering the claim uses (FR-QUE-003). Showing a number the queue
  -- does not honour is worse than showing none.
  IF v_entry.state = 'waiting' THEN
    SELECT count(*) + 1 INTO queue_position
      FROM queue_entries q
     WHERE q.track_id = v_entry.track_id
       AND q.state = 'waiting'
       AND (q.priority > v_entry.priority
            OR (q.priority = v_entry.priority AND q.enqueued_at < v_entry.enqueued_at));
  END IF;

  -- Room only once called: telling someone a room before they are called sends them to a
  -- door that is still occupied.
  IF v_entry.state IN ('called', 'in_interview') AND v_entry.panel_id IS NOT NULL THEN
    SELECT r.name INTO room_name
      FROM panels p JOIN rooms r ON r.id = p.room_id
     WHERE p.id = v_entry.panel_id;
  END IF;

  SELECT count(*)::int INTO open_panels
    FROM panels p
    JOIN panel_tracks pt ON pt.panel_id = p.id
   WHERE pt.track_id = v_entry.track_id AND p.status IN ('open', 'busy');

  RETURN NEXT;
END $$;

COMMENT ON FUNCTION fn_applicant_status IS
  'Everything the applicant status page renders, scoped by token hash. Named columns only. Exists because joining stages under applicant RLS silently returns zero rows rather than erroring.';

GRANT EXECUTE ON FUNCTION fn_applicant_status(bytea) TO rms_app;

COMMIT;
