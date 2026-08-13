-- 0017 — RLS for the event-day tables
--
-- Same fail-closed rule as migration 0008: an unset context yields zero rows, never all rows
-- (rules.md R-014). Every new table gets a policy in the same migration that creates it,
-- because a table with RLS enabled and no policy is invisible, and a table without RLS is
-- wide open — both failures are silent.
--
-- Refs: FR-RBAC-004, FR-RBAC-005, FR-INT-004, NFR-PRIV-005

BEGIN;

ALTER TABLE check_ins            ENABLE ROW LEVEL SECURITY;
ALTER TABLE panels               ENABLE ROW LEVEL SECURITY;
ALTER TABLE panel_members        ENABLE ROW LEVEL SECURITY;
ALTER TABLE panel_tracks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_entries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE recusals             ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews           ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_observations ENABLE ROW LEVEL SECURITY;


-- ── Check-ins ───────────────────────────────────────────────────────────────────────────
CREATE POLICY checkin_self_select ON check_ins FOR SELECT
  USING (applicant_id = fn_current_applicant_id());

CREATE POLICY checkin_staff_select ON check_ins FOR SELECT
  USING (fn_has_capability(cycle_id, 'checkin.perform')
      OR fn_has_capability(cycle_id, 'applicant.view'));


-- ── Panels ──────────────────────────────────────────────────────────────────────────────
-- Any staff member in the cycle may see panel status: the ops dashboard, the display board
-- publisher and a volunteer answering "which room?" all need it, and it carries no personal
-- data.
CREATE POLICY panel_staff_select ON panels FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m
             WHERE m.cycle_id = panels.cycle_id
               AND m.user_id = fn_current_user_id()
               AND m.revoked_at IS NULL)
  );

CREATE POLICY panel_manage ON panels FOR ALL
  USING (fn_has_capability(cycle_id, 'panel.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'panel.manage'));

CREATE POLICY panel_member_select ON panel_members FOR SELECT
  USING (
    interviewer_id = fn_current_user_id()
    OR EXISTS (SELECT 1 FROM panels p
                WHERE p.id = panel_members.panel_id
                  AND fn_has_capability(p.cycle_id, 'panel.manage'))
  );

CREATE POLICY panel_member_manage ON panel_members FOR ALL
  USING (EXISTS (SELECT 1 FROM panels p
                  WHERE p.id = panel_members.panel_id
                    AND fn_has_capability(p.cycle_id, 'panel.manage')))
  WITH CHECK (EXISTS (SELECT 1 FROM panels p
                       WHERE p.id = panel_members.panel_id
                         AND fn_has_capability(p.cycle_id, 'panel.manage')));

CREATE POLICY panel_track_select ON panel_tracks FOR SELECT
  USING (EXISTS (SELECT 1 FROM panels p
                  WHERE p.id = panel_tracks.panel_id
                    AND EXISTS (SELECT 1 FROM memberships m
                                 WHERE m.cycle_id = p.cycle_id
                                   AND m.user_id = fn_current_user_id()
                                   AND m.revoked_at IS NULL)));

CREATE POLICY panel_track_manage ON panel_tracks FOR ALL
  USING (EXISTS (SELECT 1 FROM panels p
                  WHERE p.id = panel_tracks.panel_id
                    AND fn_has_capability(p.cycle_id, 'panel.manage')))
  WITH CHECK (EXISTS (SELECT 1 FROM panels p
                       WHERE p.id = panel_tracks.panel_id
                         AND fn_has_capability(p.cycle_id, 'panel.manage')));


-- ── Queue entries ───────────────────────────────────────────────────────────────────────
-- An applicant sees their OWN entry — position and room when called. They must never see
-- another applicant's row: the status page shows a position, and a position is only
-- meaningful because everyone else's is hidden (NFR-PRIV-005).
CREATE POLICY queue_self_select ON queue_entries FOR SELECT
  USING (applicant_id = fn_current_applicant_id());

CREATE POLICY queue_staff_select ON queue_entries FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view')
      OR fn_has_capability(cycle_id, 'checkin.perform')
      OR fn_has_capability(cycle_id, 'queue.call_next'));

-- Writes go through the SECURITY DEFINER functions in 0016, which enforce the state machine.
-- This policy exists for direct coordinator corrections only.
CREATE POLICY queue_coordinator_update ON queue_entries FOR UPDATE
  USING (fn_has_capability(cycle_id, 'queue.adjust_priority'))
  WITH CHECK (fn_has_capability(cycle_id, 'queue.adjust_priority'));


-- ── Recusals ────────────────────────────────────────────────────────────────────────────
-- FR-INT-017: any interviewer may declare one at any time, and sees their own. Coordinators
-- see all, because they need to know why a panel keeps skipping someone.
CREATE POLICY recusal_own_select ON recusals FOR SELECT
  USING (interviewer_id = fn_current_user_id()
      OR fn_has_capability(cycle_id, 'panel.manage'));

CREATE POLICY recusal_own_insert ON recusals FOR INSERT
  WITH CHECK (interviewer_id = fn_current_user_id()
           OR fn_has_capability(cycle_id, 'panel.manage'));


-- ── Interviews ──────────────────────────────────────────────────────────────────────────
-- FR-INT-004: an interviewer sees interviews for their OWN panel and nothing else. This is
-- the row-level half of blind evaluation — the UI hiding scores is ergonomics, and a rushed
-- endpoint must not be able to leak what the policy forbids.
CREATE POLICY interview_panel_select ON interviews FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM panel_members pm
             WHERE pm.panel_id = interviews.panel_id
               AND pm.interviewer_id = fn_current_user_id())
  );

CREATE POLICY interview_privileged_select ON interviews FOR SELECT
  USING (fn_has_capability(cycle_id, 'evaluation.view_all')
      OR fn_has_capability(cycle_id, 'panel.manage'));

CREATE POLICY interview_self_select ON interviews FOR SELECT
  USING (applicant_id = fn_current_applicant_id());


-- ── Service observations ────────────────────────────────────────────────────────────────
-- Aggregate timing only, no identities. Readable by any staff member because the wait
-- estimate is computed from it and shown on the ops dashboard.
CREATE POLICY service_obs_staff_select ON service_observations FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m
             WHERE m.cycle_id = service_observations.cycle_id
               AND m.user_id = fn_current_user_id()
               AND m.revoked_at IS NULL)
  );

COMMIT;
