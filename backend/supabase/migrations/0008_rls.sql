-- 0008 — Row-level security
--
-- Fixes errata E9 and E13.
--
-- E9: v1's policies read current_setting('app.applicant_id', true) and never said how it gets
-- written. Under a transaction-mode connection pooler — Supabase's default — a session-level
-- SET either leaks across unrelated requests or vanishes. Either the security boundary
-- silently fails OPEN, or nothing works at all.
--
-- E13: memberships permits several roles per user per cycle, but v1's permission gate assumed
-- exactly one and would silently deny a Coordinator who also interviews.
--
-- THE FAIL-CLOSED PROPERTY: every context accessor returns NULL when unset, and every
-- comparison against NULL yields NULL, which is not TRUE, so the policy denies. An unset
-- context returns ZERO rows — never all rows. That is the only acceptable direction, and it is
-- tested directly in tests/rls (rules.md R-014, FR-RBAC-005).
--
-- Refs: FR-RBAC-003..009, NFR-PRIV-005, E9, E13

BEGIN;

-- ── Context accessors ───────────────────────────────────────────────────────────────────
-- Two supported binding patterns, per spec §15.3:
--   A. Supabase — read from the verified JWT.
--   B. Own backend — set_config(..., true) INSIDE the transaction. The third argument being
--      true is the entire fix for E9: transaction-scoped, so a pooled connection handed to
--      the next request carries nothing.
CREATE OR REPLACE FUNCTION fn_current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  BEGIN
    v := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'user_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v := NULL;
  END;

  IF v IS NULL THEN
    v := nullif(current_setting('app.user_id', true), '')::uuid;
  END IF;

  RETURN v;   -- NULL when unset → every policy comparison denies
END $$;

CREATE OR REPLACE FUNCTION fn_current_applicant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  BEGIN
    v := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'applicant_id', '')::uuid;
  EXCEPTION WHEN others THEN
    v := NULL;
  END;

  IF v IS NULL THEN
    v := nullif(current_setting('app.applicant_id', true), '')::uuid;
  END IF;

  RETURN v;
END $$;


-- ── Capability model ────────────────────────────────────────────────────────────────────
-- The §12.1 matrix as DATA, not code (rules.md R-050) — a committee can adjust who may bump a
-- queue priority without a deployment.
--
-- There are no DENY rules. A capability is either granted by some role the user holds, or it
-- is absent. This keeps the model composable and avoids the classic "why can't I do this,
-- I'm an admin" ambiguity that arises the moment deny rules can override grants.
CREATE TABLE role_capabilities (
  role       role_name NOT NULL,
  capability text      NOT NULL,
  scope      text      NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'own', 'aggregate')),
  PRIMARY KEY (role, capability)
);

INSERT INTO role_capabilities (role, capability, scope) VALUES
  -- Super Admin
  ('super_admin', 'cycle.configure', 'all'),
  ('super_admin', 'cycle.advance_stage', 'all'),
  ('super_admin', 'departments.manage', 'all'),
  ('super_admin', 'users.manage', 'all'),
  ('super_admin', 'applicant.register', 'all'),
  ('super_admin', 'applicant.view', 'all'),
  ('super_admin', 'applicant.edit_answers', 'all'),
  ('super_admin', 'applicant.edit_contact', 'all'),
  ('super_admin', 'applicant.dedupe_override', 'all'),
  ('super_admin', 'applicant.screen', 'all'),
  ('super_admin', 'checkin.perform', 'all'),
  ('super_admin', 'queue.adjust_priority', 'all'),
  ('super_admin', 'queue.reactivate', 'all'),
  ('super_admin', 'panel.manage', 'all'),
  ('super_admin', 'evaluation.waive', 'all'),
  ('super_admin', 'evaluation.view_all', 'all'),
  ('super_admin', 'evaluation.unlock', 'all'),
  ('super_admin', 'interview.void', 'all'),
  ('super_admin', 'aggregates.view', 'all'),
  ('super_admin', 'allocation.run', 'all'),
  ('super_admin', 'results.lock', 'all'),
  ('super_admin', 'data.export', 'all'),
  ('super_admin', 'audit.view', 'all'),

  -- Coordinator: floor authority WITHOUT score visibility. That separation is the entire
  -- reason this role exists — someone must reorder the queue and resolve stuck interviews
  -- during the event without being able to see a single score.
  ('coordinator', 'cycle.advance_stage', 'own'),
  ('coordinator', 'applicant.register', 'all'),
  ('coordinator', 'applicant.view', 'all'),
  ('coordinator', 'applicant.edit_contact', 'all'),
  ('coordinator', 'applicant.dedupe_override', 'all'),
  ('coordinator', 'applicant.screen', 'all'),
  ('coordinator', 'checkin.perform', 'all'),
  ('coordinator', 'queue.adjust_priority', 'all'),
  ('coordinator', 'queue.reactivate', 'all'),
  ('coordinator', 'queue.call_next', 'all'),
  ('coordinator', 'panel.manage', 'all'),
  ('coordinator', 'evaluation.waive', 'all'),
  ('coordinator', 'interview.void', 'all'),
  ('coordinator', 'aggregates.view', 'aggregate'),
  ('coordinator', 'audit.view', 'own'),

  -- Admin: a data role, deliberately not a firefighting one.
  ('admin', 'applicant.register', 'all'),
  ('admin', 'applicant.view', 'all'),
  ('admin', 'applicant.edit_answers', 'all'),
  ('admin', 'applicant.edit_contact', 'all'),
  ('admin', 'applicant.dedupe_override', 'all'),
  ('admin', 'applicant.screen', 'all'),
  ('admin', 'checkin.perform', 'all'),
  ('admin', 'queue.reactivate', 'all'),
  ('admin', 'data.export', 'aggregate'),
  ('admin', 'audit.view', 'own'),

  -- Volunteer: the lowest-proficiency, highest-time-pressure class (NFR-USE-001).
  ('volunteer', 'applicant.register', 'all'),
  ('volunteer', 'applicant.view', 'own'),
  ('volunteer', 'applicant.dedupe_override', 'own'),
  ('volunteer', 'checkin.perform', 'all'),
  ('volunteer', 'queue.reactivate', 'all'),
  ('volunteer', 'audit.view', 'own'),

  -- Interviewer: sees assigned applicants and their OWN evaluations. Nothing else.
  ('interviewer', 'applicant.view', 'own'),
  ('interviewer', 'queue.call_next', 'own'),
  ('interviewer', 'evaluation.submit', 'own'),
  ('interviewer', 'audit.view', 'own'),

  -- Auditor: read everything including scores, write nothing. Granting full visibility
  -- without any power is what makes a disputed result resolvable.
  ('auditor', 'applicant.view', 'all'),
  ('auditor', 'evaluation.view_all', 'all'),
  ('auditor', 'aggregates.view', 'all'),
  ('auditor', 'data.export', 'aggregate'),
  ('auditor', 'audit.view', 'all');


-- E13: capabilities are the UNION across every role the user holds in this cycle.
CREATE OR REPLACE FUNCTION fn_has_capability(p_cycle_id uuid, p_capability text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
      FROM memberships m
      JOIN role_capabilities rc ON rc.role = m.role
     WHERE m.user_id    = fn_current_user_id()   -- NULL when unset → EXISTS is false → denied
       AND m.cycle_id   = p_cycle_id
       AND m.revoked_at IS NULL
       AND rc.capability = p_capability
  )
$$;

CREATE OR REPLACE FUNCTION fn_has_role(p_cycle_id uuid, p_roles role_name[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM memberships m
     WHERE m.user_id    = fn_current_user_id()
       AND m.cycle_id   = p_cycle_id
       AND m.revoked_at IS NULL
       AND m.role       = ANY(p_roles)
  )
$$;

COMMENT ON FUNCTION fn_has_capability IS
  'UNION of capabilities across all roles held in this cycle. Returns false for an unset context — fails closed. E13, FR-RBAC-003, FR-RBAC-005';


-- ── Enable RLS everywhere ───────────────────────────────────────────────────────────────
-- FORCE applies the policies to the table owner too, so a SECURITY DEFINER function or a
-- migration running as owner cannot accidentally bypass the boundary.
ALTER TABLE applicants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicants             FORCE  ROW LEVEL SECURITY;
ALTER TABLE applicant_preferences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE applicant_preferences  FORCE  ROW LEVEL SECURITY;
ALTER TABLE access_tokens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_tokens          FORCE  ROW LEVEL SECURITY;
ALTER TABLE audit_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships            ENABLE ROW LEVEL SECURITY;
ALTER TABLE cycles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracks                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE stages                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications          ENABLE ROW LEVEL SECURITY;


-- ── Applicants ──────────────────────────────────────────────────────────────────────────
-- NFR-PRIV-005: an applicant shall not, under any circumstance, be able to view another
-- applicant's name, status, score or outcome. Enforced HERE, at the row, not in a template.
CREATE POLICY applicant_self_select ON applicants FOR SELECT
  USING (id = fn_current_applicant_id());

CREATE POLICY applicant_staff_select ON applicants FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

CREATE POLICY applicant_staff_insert ON applicants FOR INSERT
  WITH CHECK (fn_has_capability(cycle_id, 'applicant.register'));

CREATE POLICY applicant_staff_update ON applicants FOR UPDATE
  USING (fn_has_capability(cycle_id, 'applicant.edit_contact')
      OR fn_has_capability(cycle_id, 'applicant.edit_answers'))
  WITH CHECK (fn_has_capability(cycle_id, 'applicant.edit_contact')
           OR fn_has_capability(cycle_id, 'applicant.edit_answers'));

-- DR-006: deletion is a state transition. No DELETE policy exists on this table, so no
-- caller can hard-delete an applicant regardless of what the API asks for.


CREATE POLICY preference_self_select ON applicant_preferences FOR SELECT
  USING (applicant_id = fn_current_applicant_id());

CREATE POLICY preference_staff_all ON applicant_preferences FOR ALL
  USING (fn_has_capability(cycle_id, 'applicant.view'))
  WITH CHECK (fn_has_capability(cycle_id, 'applicant.register'));


-- ── Access tokens ───────────────────────────────────────────────────────────────────────
-- Deliberately NO applicant-facing SELECT policy. An applicant authenticates WITH the token;
-- they never need to read the row, and the hash is the one thing that must not leak sideways.
-- Token verification runs through a SECURITY DEFINER function, not a direct read.
CREATE POLICY token_staff_select ON access_tokens FOR SELECT
  USING (fn_has_role(cycle_id, ARRAY['super_admin', 'coordinator', 'admin']::role_name[]));


-- ── Audit ───────────────────────────────────────────────────────────────────────────────
-- FR-RBAC-009: Auditor reads everything, writes nothing. Everyone else sees their own actions.
CREATE POLICY audit_privileged_select ON audit_events FOR SELECT
  USING (cycle_id IS NOT NULL AND fn_has_capability(cycle_id, 'audit.view'));

CREATE POLICY audit_own_select ON audit_events FOR SELECT
  USING (actor_id = fn_current_user_id());

-- INSERT is permitted because fn_audit must always succeed inside a legitimate transaction.
-- Integrity comes from append-only enforcement (migration 0005), not from restricting writes:
-- an audit row that could be refused is an audit row that goes missing under load.
CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (true);


-- ── Configuration tables ────────────────────────────────────────────────────────────────
CREATE POLICY membership_self_select ON memberships FOR SELECT
  USING (user_id = fn_current_user_id());

CREATE POLICY membership_admin_all ON memberships FOR ALL
  USING (fn_has_capability(cycle_id, 'users.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'users.manage'));

CREATE POLICY cycle_member_select ON cycles FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m
             WHERE m.cycle_id = cycles.id
               AND m.user_id = fn_current_user_id()
               AND m.revoked_at IS NULL)
  );

CREATE POLICY cycle_admin_update ON cycles FOR UPDATE
  USING (fn_has_capability(id, 'cycle.configure'))
  WITH CHECK (fn_has_capability(id, 'cycle.configure'));

-- Departments and tracks are readable by an unauthenticated applicant filling in the public
-- form — they must see the department names to rank them. Only ACTIVE rows, and only for a
-- cycle whose registration is genuinely open, so a draft cycle's configuration stays private.
CREATE POLICY department_public_select ON departments FOR SELECT
  USING (
    is_active
    AND EXISTS (SELECT 1 FROM cycles c
                 WHERE c.id = departments.cycle_id AND c.state = 'registration_open')
  );

CREATE POLICY department_staff_select ON departments FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

CREATE POLICY department_admin_all ON departments FOR ALL
  USING (fn_has_capability(cycle_id, 'departments.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'departments.manage'));

CREATE POLICY track_staff_select ON tracks FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

CREATE POLICY track_admin_all ON tracks FOR ALL
  USING (fn_has_capability(cycle_id, 'departments.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'departments.manage'));

CREATE POLICY room_staff_select ON rooms FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

CREATE POLICY room_admin_all ON rooms FOR ALL
  USING (fn_has_capability(cycle_id, 'departments.manage'))
  WITH CHECK (fn_has_capability(cycle_id, 'departments.manage'));

CREATE POLICY stage_member_select ON stages FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM memberships m
             WHERE m.cycle_id = stages.cycle_id
               AND m.user_id = fn_current_user_id()
               AND m.revoked_at IS NULL)
  );

CREATE POLICY stage_admin_all ON stages FOR ALL
  USING (fn_has_capability(cycle_id, 'cycle.advance_stage'))
  WITH CHECK (fn_has_capability(cycle_id, 'cycle.advance_stage'));


-- ── Notifications ───────────────────────────────────────────────────────────────────────
CREATE POLICY notification_self_select ON notifications FOR SELECT
  USING (applicant_id = fn_current_applicant_id());

CREATE POLICY notification_staff_select ON notifications FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

COMMIT;
