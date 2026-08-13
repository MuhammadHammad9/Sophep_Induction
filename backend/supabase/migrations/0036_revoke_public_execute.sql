-- 0036 — Close the privilege perimeter
--
-- THE SINGLE MOST SERIOUS DEFECT FOUND IN THE 2026-08-12 AUDIT, and it is a default rather than
-- a mistake anyone made — which is why it survived every review.
--
-- Postgres grants EXECUTE to PUBLIC on `CREATE FUNCTION`. Across migrations 0006–0035 this
-- repository creates 77 functions and REVOKEs that default exactly zero times. The
-- `GRANT EXECUTE ... TO rms_app` lines throughout are therefore decorative: rms_app already
-- held EXECUTE via PUBLIC, and so did every other role in the cluster.
--
-- That would be a containable internal detail if the database were not directly reachable. It
-- is. Supabase exposes the `public` schema over PostgREST to `anon` and `authenticated`, and
-- `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships inside the browser bundle by design. So:
--
--     POST https://<project>.supabase.co/rest/v1/rpc/fn_export_selected
--     apikey: <the key in every page source>
--     {"p_cycle_id": "<the uuid printed in the /display URL on the hall TV>"}
--
-- returns the name and final score of every selected applicant. `fn_roster_bundle_v2` returns
-- the whole cohort's identities. `fn_run_allocation` writes decisions. `fn_anonymise_old_data`
-- destroys PII. Every one of these is SECURITY DEFINER, which means it runs as the OWNER and
-- **row-level security does not apply to it at all**.
--
-- So the entire boundary that migrations 0008, 0010, 0017 and 0033 exist to build — the five
-- invariants, the fail-closed accessors, the NOBYPASSRLS application role — is bypassed by
-- calling the functions directly. RLS was never the weak part. The door beside it was open.
--
-- WHAT THIS MIGRATION DOES, AND WHY IN THIS ORDER
--
--   1. Revoke the PUBLIC default, present and future. Future matters most: without the
--      ALTER DEFAULT PRIVILEGES line, migration 0041 reintroduces the hole for its own
--      functions and nobody notices, because nothing fails.
--   2. Revoke the Supabase edge roles explicitly. Belt and braces — `anon` is a member of
--      PUBLIC so (1) already covers it, but an explicit revoke is what a reader checks for,
--      and it survives someone re-granting to PUBLIC later.
--   3. Take `USAGE ON SCHEMA public` away from the edge roles. This is the real lock: without
--      schema usage, PostgREST cannot resolve a function name at all, so an RPC call fails
--      before privilege is even considered. Defence that does not depend on enumerating 77
--      function signatures correctly.
--   4. Re-grant to rms_app, which is the only role the application ever assumes.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--
--   * `service_role` — the backend jobs key (jobs/consistency.ts, jobs/anonymisation.ts). It
--     bypasses RLS and must keep working. It is a server-held secret, never shipped to a
--     client, and it is not the vector here.
--   * `postgres` / the migration owner — superuser, unaffected by grants either way.
--
-- AFTER THIS MIGRATION, the public application form and status page still work: they run
-- through the application role via `withContext`, not through PostgREST. Nothing in
-- `frontend/` talks to PostgREST directly except the Realtime client, which is addressed
-- separately.
--
-- Verification (should return zero rows):
--     SELECT p.proname
--       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND has_function_privilege('anon', p.oid, 'EXECUTE');
--
-- Refs: FR-RBAC-004, FR-RBAC-005, NFR-SEC-003, rules.md R-014, R-032, audit C-2

BEGIN;

-- ── 1. The PUBLIC default, present and future ───────────────────────────────────────────

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- The one line that stops this regressing. Applies to functions created LATER by whichever
-- role runs migrations, which is how every future migration inherits the correct default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Same reasoning for tables and sequences. RLS covers tables, but "RLS plus no grant" is two
-- independent failures rather than one, and 0036's whole lesson is that a single default can
-- undo a whole design.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;


-- ── 2 & 3. The Supabase edge roles ──────────────────────────────────────────────────────
--
-- Guarded by existence checks: these roles are created by the Supabase platform and are absent
-- on a plain Postgres used for local development and CI. A migration that fails on a developer
-- laptop is a migration that gets commented out, and then it protects nobody.

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', v_role);

      -- The decisive one. No schema usage, no name resolution, no RPC.
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', v_role);

      RAISE NOTICE 'revoked public-schema access from role %', v_role;
    ELSE
      RAISE NOTICE 'role % not present (local/CI Postgres) — nothing to revoke', v_role;
    END IF;
  END LOOP;
END $$;


-- ── 4. Restore what the application actually needs ──────────────────────────────────────
--
-- rms_app is NOLOGIN and NOBYPASSRLS, assumed only via `SET LOCAL ROLE` inside withContext
-- (services/db.ts). Every policy in 0008/0017/0033 therefore still applies to it — these
-- grants decide which objects it may attempt to touch, and RLS decides which rows it sees.
-- The two are independent, and both are required.

GRANT USAGE ON SCHEMA public TO rms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rms_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO rms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rms_app;

-- Re-assert 0010's restrictions. `GRANT ... ON ALL TABLES` above is a blunt instrument and
-- would otherwise hand back the privileges 0010 deliberately withheld: no DELETE anywhere
-- (deletion is a state transition, R-031/DR-006), and audit_events is append-only (R-011).
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM rms_app;
REVOKE UPDATE, DELETE ON audit_events FROM rms_app;
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
REVOKE INSERT, UPDATE ON role_capabilities, application_transitions FROM rms_app;

COMMIT;
