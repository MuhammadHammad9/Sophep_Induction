-- 0020 — The public display board feed
--
-- FR-OPS-009 / FR-OPS-010 / NFR-PRIV-006, and rules.md R-028.
--
-- The board shows applicant identifiers and room assignments ONLY. No names, ever.
--
-- The requirement is specific about HOW: names are excluded AT THE PUBLISHER, not omitted by
-- the client. This function is that publisher. It is physically incapable of returning a name,
-- so a careless template, a debug panel, or a future developer reading `SELECT *` cannot leak
-- one — you are not trusting a client to leave it out.
--
-- Two reasons this matters more than it looks. It is an avoidable privacy leak in a room full
-- of the applicant's peers, and it is social pressure: being visibly called, or visibly not
-- called, in front of everyone you are competing with.
--
-- Refs: FR-OPS-009, FR-OPS-010, NFR-PRIV-006, rules.md R-028

BEGIN;

CREATE OR REPLACE FUNCTION fn_display_board(p_cycle_id uuid)
RETURNS TABLE (
  display_id  text,
  room_name   text,
  called_at   timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.display_id, r.name, q.called_at
    FROM queue_entries q
    JOIN applicants a ON a.id = q.applicant_id
    JOIN panels     p ON p.id = q.panel_id
    JOIN rooms      r ON r.id = p.room_id
   WHERE q.cycle_id = p_cycle_id
     AND q.state IN ('called', 'in_interview')
   ORDER BY q.called_at DESC
   LIMIT 12
$$;

COMMENT ON FUNCTION fn_display_board IS
  'Public board feed. Returns identifiers and rooms ONLY — names are excluded at the PUBLISHER, not by the client (FR-OPS-010, rules.md R-028).';

GRANT EXECUTE ON FUNCTION fn_display_board(uuid) TO rms_app;


-- Aggregate counts for the board footer. Counts carry no identity, so this is safe to show on
-- a wall screen.
CREATE OR REPLACE FUNCTION fn_display_summary(p_cycle_id uuid)
RETURNS TABLE (
  waiting      int,
  in_interview int,
  open_panels  int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    (SELECT count(*)::int FROM queue_entries
      WHERE cycle_id = p_cycle_id AND state = 'waiting'),
    (SELECT count(*)::int FROM queue_entries
      WHERE cycle_id = p_cycle_id AND state = 'in_interview'),
    (SELECT count(*)::int FROM panels
      WHERE cycle_id = p_cycle_id AND status IN ('open', 'busy'))
$$;

GRANT EXECUTE ON FUNCTION fn_display_summary(uuid) TO rms_app;

COMMIT;
