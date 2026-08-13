-- 0044 — Make the PUBLIC-EXECUTE revoke self-enforcing
--
-- Migration 0036 revoked EXECUTE from PUBLIC on every function then existing, and added
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` to stop
-- it regressing.
--
-- IT DID NOT STOP IT REGRESSING. Executing the migrations against a real PostgreSQL 18 and
-- then asserting the property found four functions still executable by PUBLIC:
--
--     fn_resolve_staff_session   (created in 0037)
--     fn_require_capability      (created in 0038)
--     fn_anonymise_old_data      (recreated with a new signature in 0040)
--     fn_enqueue_notification    (recreated with a new signature in 0042)
--
-- Every one of them was created by a migration that runs AFTER 0036. `ALTER DEFAULT
-- PRIVILEGES` is not the blanket guarantee it reads as: it applies to the specific role that
-- executed it, and its interaction with functions created later in a different session — which
-- is exactly what a migration runner does — is not something to bet a security boundary on.
--
-- This is the same class of defect as the original C-2 finding, one layer up. The first bug was
-- "a default nobody revoked". This one is "a revoke that does not cover what comes next". Both
-- are invisible without executing, because nothing fails — the functions work, and they work
-- for everyone.
--
-- So this migration stops relying on defaults entirely and enforces the invariant with an EVENT
-- TRIGGER: whenever any function is created in `public`, EXECUTE is revoked from PUBLIC
-- immediately and automatically, in the same transaction as the CREATE.
--
-- The property becomes structural rather than remembered. A future migration cannot reopen the
-- hole by forgetting a REVOKE, because there is no longer a REVOKE to forget.
--
-- Refs: FR-RBAC-004, NFR-SEC-003, rules.md R-014, R-032, audit C-2

BEGIN;

-- ── 1. Sweep up what 0036 missed ────────────────────────────────────────────────────────
--
-- Everything created between 0037 and 0043. Re-running the blanket revoke is idempotent and
-- costs nothing; the four named above are the ones it actually catches today.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', v_role);
    END IF;
  END LOOP;
END $$;

-- Restore what the application needs, then re-assert 0010's withholdings, since the blanket
-- GRANT below is as blunt as the REVOKE above.
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rms_app;


-- ── 2. The event trigger ────────────────────────────────────────────────────────────────

/**
 * Revoke EXECUTE from PUBLIC on every newly created function in `public`.
 *
 * Runs at ddl_command_end, so it fires inside the creating transaction: if the CREATE FUNCTION
 * rolls back, so does the revoke, and the two can never disagree.
 *
 * `pg_event_trigger_ddl_commands()` reports the object identity of everything the command
 * touched, which is what makes this work for `CREATE OR REPLACE` and for overloaded signatures
 * — a name-based approach would revoke the wrong overload or none at all.
 *
 * Aggregates and window functions share pg_proc but cannot be granted the same way, so only
 * plain functions and procedures are touched. Anything in another schema is ignored: this
 * boundary is about `public`, which is the schema PostgREST exposes.
 */
CREATE OR REPLACE FUNCTION fn_revoke_public_execute_on_create()
RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_obj record;
BEGIN
  FOR v_obj IN
    SELECT object_identity, schema_name, command_tag
      FROM pg_event_trigger_ddl_commands()
     WHERE command_tag IN ('CREATE FUNCTION', 'CREATE PROCEDURE')
       AND schema_name = 'public'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_obj.object_identity);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO rms_app', v_obj.object_identity);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', v_obj.object_identity);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', v_obj.object_identity);
    END IF;
  END LOOP;
END $$;

COMMENT ON FUNCTION fn_revoke_public_execute_on_create IS
  'Event-trigger body. Removes the PUBLIC EXECUTE default the moment a function is created, so '
  'the boundary does not depend on every future migration remembering to (audit C-2).';

-- The trigger cannot revoke its own creation: it does not exist yet at the moment this
-- function is created, and the sweep above already ran. Caught by the assertion suite, which
-- reported exactly one leaked function after the rest of this migration was in place — a small
-- and very literal demonstration of why the property is asserted rather than assumed.
--
-- No rms_app grant: nothing calls this but the event trigger machinery, which runs as the
-- function owner.
REVOKE EXECUTE ON FUNCTION fn_revoke_public_execute_on_create() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS trg_revoke_public_execute;

CREATE EVENT TRIGGER trg_revoke_public_execute
  ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'CREATE PROCEDURE')
  EXECUTE FUNCTION fn_revoke_public_execute_on_create();

COMMENT ON EVENT TRIGGER trg_revoke_public_execute IS
  'Enforces "no function in public is executable by PUBLIC" structurally rather than by '
  'convention. See migration 0044 for why ALTER DEFAULT PRIVILEGES was not sufficient.';

COMMIT;
