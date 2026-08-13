-- 0040 — Audit integrity, retention, and closing the JWT-claim side door
--
-- R-011 says the audit log's only value is that it "cannot be edited and cannot be missing".
-- Three separate defects undermined that, and they compound: the log could be FABRICATED, it
-- could be EDITED by the one function most obliged not to, and the edit itself left no trace.
--
--
-- DEFECT 1 — anyone could forge an audit row.
--
--     CREATE POLICY audit_insert ON audit_events FOR INSERT WITH CHECK (true);   -- 0008
--
-- Any context at all — an applicant token session, and before 0036 an anonymous PostgREST
-- caller — could insert rows with any actor_id, action, entity and before/after payload.
--
-- The append-only property is what makes this permanent rather than merely annoying: UPDATE
-- and DELETE are correctly revoked, so forged rows can never be removed. In a disputed result
-- the log is the evidence, and an attacker could bury the real rows under plausible ones
-- attributing decisions to a real coordinator. Immutability protected the forgery.
--
-- Fixed by removing INSERT from the application role entirely. `fn_audit` is SECURITY DEFINER
-- and is the only writer in the schema (verified: the sole INSERT INTO audit_events statements
-- are inside fn_audit itself, in 0006 and 0012). This is the same shape as `notifications`,
-- where 0014 deliberately declines to add an INSERT policy so that its SECURITY DEFINER
-- function is the only write path — a pattern that migration praised and this table lacked.
--
--
-- DEFECT 2 — fn_anonymise_old_data edited the audit log.
--
--     UPDATE audit_events SET before = '{}', after = '{}' WHERE ...
--
-- R-011 revokes UPDATE on audit_events at the role level. That revoke does not apply here,
-- because the function is SECURITY DEFINER and runs as the owner. So the one operation in the
-- system that most needed to respect append-only was the one able to ignore it.
--
-- It also wrote no audit row of its own, had no capability check, and never touched
-- `notifications` — which is where the real retention exposure lives, since notification
-- bodies hold applicant-facing content indefinitely.
--
-- Replaced with a forward-only redaction: the original rows are left intact and a single
-- `data.redacted` audit row records what was scrubbed, for which cycles, by whom. That is
-- strictly more honest than blanking payloads in place, and it satisfies retention without
-- making the log lie about its own history.
--
--
-- DEFECT 3 — the accessors trusted an unverified JWT claim first.
--
-- fn_current_user_id reads `request.jwt.claims ->> 'user_id'` BEFORE falling back to the
-- transaction-local `app.user_id`. No Supabase JWT carries a top-level `user_id`, so this is
-- inert today — which is exactly why it would survive review until the day someone adds a
-- custom Auth Hook or JWT template that flattens `user_metadata`. Users can edit their own
-- user_metadata via `auth.updateUser()`. At that moment the branch becomes a self-service
-- impersonation primitive for every account in the system.
--
-- fn_has_capability already carries the definitive comment on this class of mistake: a fast
-- path reading a caller-supplied GUC "was tried and removed" because "the boundary must not
-- depend on the application telling the truth". The same reasoning applies to a claim in a
-- token whose contents the subject can influence. Since 0036 removed PostgREST access
-- entirely, the branch has no remaining caller and is pure liability. Removed.
--
-- Refs: FR-AUD-001, FR-AUD-002, FR-AUD-003, FR-RBAC-005, DR-006, NFR-PRIV-004,
--       rules.md R-011, R-014, R-031, audit H-1, H-2, M-7, M-9

BEGIN;

-- ── 1. fn_audit becomes the only writer ─────────────────────────────────────────────────

DROP POLICY IF EXISTS audit_insert ON audit_events;

-- A narrow policy remains rather than none, because `fn_audit` runs as the owner and FORCE ROW
-- LEVEL SECURITY (0037) makes the owner subject to policies wherever the owner lacks BYPASSRLS.
-- Binding the row to the acting user means a forged actor_id cannot be inserted even on that
-- path: you may write an audit row about yourself, or an unattributed system row, and nothing
-- else.
CREATE POLICY audit_attributed_insert ON audit_events FOR INSERT
  WITH CHECK (actor_id IS NULL OR actor_id = fn_current_user_id());

COMMENT ON POLICY audit_attributed_insert ON audit_events IS
  'An audit row may only be attributed to the acting user, or to nobody (system actions). '
  'Replaces WITH CHECK (true), which permitted forging rows against any actor and — because '
  'the table is append-only — made the forgery permanent (R-011, audit H-1).';

-- The real control. With no INSERT privilege the application role cannot write here at all,
-- policy or no policy, so fn_audit is structurally the only path.
REVOKE INSERT ON audit_events FROM rms_app;
REVOKE INSERT ON audit_events FROM PUBLIC;

COMMENT ON TABLE audit_events IS
  'Append-only. INSERT only via fn_audit (SECURITY DEFINER); UPDATE and DELETE revoked from '
  'every role. No audit, no commit (R-011, FR-AUD-001..003).';


-- ── 2. Retention: forward-only redaction, audited, and covering notifications ───────────

CREATE OR REPLACE FUNCTION fn_anonymise_old_data(p_cycle_id uuid DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycles   uuid[];
  v_c        uuid;
  v_count    int := 0;
  v_affected int;
  v_notes    int := 0;
BEGIN
  -- Was callable by anyone, with no argument and no check, and it destroys PII irreversibly.
  --
  -- Scoped to one cycle when given one so the capability can be checked against that cycle.
  -- The unscoped sweep is the scheduled-job form and requires the capability on EVERY cycle it
  -- would touch — checked inside the loop, so a partially-privileged caller cannot use the
  -- broad form to reach a cycle they do not administer.
  SELECT array_agg(id) INTO v_cycles
    FROM cycles
   WHERE state = 'archived'
     AND archived_at < now() - interval '2 years'
     AND (p_cycle_id IS NULL OR id = p_cycle_id);

  IF v_cycles IS NULL THEN
    RETURN 0;
  END IF;

  FOREACH v_c IN ARRAY v_cycles
  LOOP
    -- Two legitimate callers, distinguished by something the application cannot forge.
    --
    -- Every request path runs `SET LOCAL ROLE rms_app` (services/db.ts), so current_user is
    -- 'rms_app' for anything reachable from the web. Those callers must hold the capability.
    --
    -- The scheduled sweep connects as the owner and never assumes rms_app. rms_app holds no
    -- grant that would let it become the owner, so this is not a flag the application can set
    -- — it is a property of how the connection authenticated.
    --
    -- The system path still writes an audit row; its actor_id is NULL, which the
    -- audit_attributed_insert policy permits precisely for unattributed system actions.
    IF current_user = 'rms_app' THEN
      PERFORM fn_require_capability(v_c, 'cycle.configure');
    END IF;

    UPDATE applicants
       SET full_name   = 'ANONYMISED',
           email       = id::text || '@anonymised.local',
           phone       = '000000000',
           roll_number = 'ANON',
           cv_object_key = NULL
     WHERE cycle_id = v_c AND full_name <> 'ANONYMISED';

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_count := v_count + v_affected;

    -- The gap that mattered most. Notification bodies are rendered per applicant and retained
    -- indefinitely; leaving them intact meant "anonymised" applicants remained fully
    -- identifiable, and any status link embedded in a body stayed live (R-022).
    UPDATE notifications
       SET to_email  = applicant_id::text || '@anonymised.local',
           subject   = 'REDACTED',
           body_html = '',
           body_text = ''
     WHERE cycle_id = v_c AND subject <> 'REDACTED';

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_notes := v_notes + v_affected;

    -- audit_events is NOT touched. The previous implementation blanked before/after payloads
    -- in place, which is an UPDATE on an append-only table (R-011) performed by the one caller
    -- privileged enough to get away with it. A forward-only record of the redaction is both
    -- honest and sufficient: it says what was scrubbed and when, without rewriting history.
    PERFORM fn_audit(
      v_c, 'data.redacted', 'cycle', v_c,
      NULL,
      jsonb_build_object('applicants_anonymised', v_count,
                         'notifications_redacted', v_notes,
                         'policy', 'archived + 2 years'),
      'scheduled retention sweep (DR-006, NFR-PRIV-004)'
    );
  END LOOP;

  RETURN v_count;
END $$;

-- Argument list required: the zero-argument form still exists at this point in the migration
-- (it is dropped a few lines below), so a bare name is ambiguous and errors.
COMMENT ON FUNCTION fn_anonymise_old_data(uuid) IS
  'Retention sweep over cycles archived more than two years ago. Requires cycle.configure on '
  'every cycle touched, audits what it redacted, and never edits audit_events (audit H-2).';

GRANT EXECUTE ON FUNCTION fn_anonymise_old_data(uuid) TO rms_app;

-- The old zero-argument form is gone: its signature is what made it callable with no scope and
-- therefore no checkable capability. Dropped rather than left as a wrapper, so a stale caller
-- fails loudly instead of silently reaching an unscoped sweep.
DROP FUNCTION IF EXISTS fn_anonymise_old_data();


-- ── 3. Hard-bounce suppression, scoped to the cycle ─────────────────────────────────────
--
-- fn_enqueue_notification refuses to send to an address that has ever hard-bounced. The check
-- carried no cycle filter, so one bounce in a 2024 cycle permanently suppresses that address
-- in 2026 — and since registration is open to anyone, an address can be poisoned in advance of
-- the person who will actually use it. Reputation protection is per-send-domain and per-event,
-- not per-lifetime.
CREATE OR REPLACE FUNCTION fn_enqueue_notification(
  p_applicant_id     uuid,
  p_template_key     text,
  p_template_version smallint,
  p_subject          text,
  p_body_html        text,
  p_body_text        text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cycle_id uuid;
  v_email    text;
  v_id       uuid;
BEGIN
  -- The recipient comes from here and nowhere else. This single SELECT is what stops the
  -- function being an open relay.
  SELECT cycle_id, email INTO v_cycle_id, v_email
    FROM applicants
   WHERE id = p_applicant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM notifications
     WHERE to_email = v_email
       AND state = 'bounced'
       AND bounce_type = 'hard'
       AND cycle_id = v_cycle_id          -- the filter that was missing (audit M-9)
  ) THEN
    RAISE EXCEPTION 'SUPPRESSED_HARD_BOUNCE' USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO notifications (
    cycle_id, applicant_id, template_key, template_version,
    to_email, subject, body_html, body_text, state
  ) VALUES (
    v_cycle_id, p_applicant_id, p_template_key, p_template_version,
    v_email, p_subject, p_body_html, p_body_text, 'pending'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;


-- ── 4. Remove the JWT-claim branch from both context accessors ──────────────────────────

CREATE OR REPLACE FUNCTION fn_current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_raw text;
BEGIN
  -- ONE source: the transaction-local value bound by withContext (E9).
  --
  -- The `request.jwt.claims ->> 'user_id'` branch that used to be read first is gone. It had
  -- no caller — the application binds app.user_id via set_config — and PostgREST cannot reach
  -- these functions since 0036. What it did have was a failure mode: any future JWT template
  -- exposing self-editable user_metadata at the top level would turn it into impersonation.
  v_raw := nullif(current_setting('app.user_id', true), '');

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  -- A malformed value is treated as absent, never as an error (0012).
  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION fn_current_applicant_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_raw text;
BEGIN
  v_raw := nullif(current_setting('app.applicant_id', true), '');

  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_raw::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
END $$;

COMMENT ON FUNCTION fn_current_user_id IS
  'Security context accessor. Transaction-local app.user_id only — no JWT claim is trusted '
  '(E9, audit M-7). NULL when unset OR malformed; both deny. Never raises. FR-RBAC-005';
COMMENT ON FUNCTION fn_current_applicant_id IS
  'Security context accessor. Transaction-local app.applicant_id only. NULL when unset OR '
  'malformed; both deny. Never raises. FR-RBAC-005';

COMMIT;
