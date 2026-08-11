-- 0010 — The application role
--
-- A subtle and dangerous gap, worth stating plainly:
--
-- Migration 0008 enables and FORCEs row-level security, and the fail-closed tests assert that
-- an unset context returns zero rows. But a superuser — or any role holding BYPASSRLS —
-- ignores RLS entirely. So if the application (or the test suite, or CI) connects as
-- `postgres`, every policy in 0008 is decorative, and NOTHING would tell you: queries succeed,
-- data flows, and the boundary simply is not there.
--
-- FORCE ROW LEVEL SECURITY does not save you either. It makes the table OWNER subject to
-- policies, but BYPASSRLS is checked first and wins.
--
-- The fix is a dedicated role that can never bypass RLS, combined with `SET LOCAL ROLE` in
-- every transaction (see services/db.ts). Then the policy boundary holds regardless of which
-- role the connection pool happened to authenticate as — which is exactly the property
-- rules.md R-014 claims.
--
-- Refs: FR-RBAC-004, FR-RBAC-005, rules.md R-014

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rms_app') THEN
    -- NOBYPASSRLS is the entire point. NOLOGIN because nothing connects AS this role
    -- directly; transactions assume it with SET LOCAL ROLE.
    CREATE ROLE rms_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rms_app;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO rms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rms_app;

-- DR-006 / rules.md R-031: deletion is a state transition. The application role is granted no
-- DELETE anywhere, so a hard-delete is impossible even if an endpoint tried — the privilege
-- simply does not exist.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM rms_app;

-- FR-AUD-003: append-only, restated at the role level as well as the trigger.
REVOKE UPDATE, DELETE ON audit_events FROM rms_app;

-- Configuration lookups are read-only to the application. They change through migrations,
-- which is what makes the capability matrix reviewable.
REVOKE INSERT, UPDATE ON role_capabilities, application_transitions FROM rms_app;

-- Tables added by later migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO rms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO rms_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO rms_app;

-- Let whichever role runs migrations assume rms_app without being superuser.
DO $$
BEGIN
  EXECUTE format('GRANT rms_app TO %I', current_user);
EXCEPTION WHEN duplicate_object OR insufficient_privilege THEN
  NULL;
END $$;

COMMENT ON ROLE rms_app IS
  'Application role. NOBYPASSRLS so row-level policies always apply. Assumed via SET LOCAL ROLE. rules.md R-014';

COMMIT;
