-- 0047 — Move the notification secret to its own table
--
-- Migration 0042 protected `notifications.secret_params_enc` by revoking table-level SELECT
-- from `rms_app` and re-granting the readable columns individually. That works — the schema
-- suite proves the column is unreachable — but running the RLS suite against a real server
-- showed what it costs:
--
--     PostgresError: permission denied for table notifications
--
-- from `tests/rls/fail-closed.test.ts`, which does `SELECT * FROM notifications`. Column-level
-- grants make `SELECT *` fail for the whole table, because the star expands to every column
-- including the revoked one.
--
-- That is not a broken test. Fail-closed still holds — a permission error is, if anything,
-- more closed than zero rows. But it is a broad and surprising side effect: every present and
-- future `SELECT *` against a perfectly ordinary table now errors, and the next person to hit
-- it will not connect it to a migration about token storage. Editing the invariant test to
-- accept the new error would have been accommodating my change rather than fixing it.
--
-- So the secret moves out instead. `notification_secrets` uses the pattern already proven
-- twice in this schema — RLS enabled, NO policy, SELECT revoked — which is how
-- `idempotency_keys` (0037) and `rate_limits` (0046) are protected. There is no legitimate
-- reader except the dispatcher, so there is no policy, and `notifications` goes back to being
-- a table you can `SELECT *` from without thinking about it.
--
-- The old column is dropped rather than left behind. Leaving it would mean two places a
-- secret could live and one of them unprotected the moment someone re-granted the table.
--
-- Refs: FR-NOT-001, NFR-SEC-002, NFR-SEC-004, rules.md R-014, R-022, audit C-5

BEGIN;

CREATE TABLE IF NOT EXISTS notification_secrets (
  notification_id uuid PRIMARY KEY REFERENCES notifications(id) ON DELETE CASCADE,
  cycle_id        uuid NOT NULL REFERENCES cycles(id),   -- R-010: every table carries it
  params_enc      bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_secrets IS
  'AES-256-GCM(JSON) of template variables that must never be stored in plaintext — the status '
  'URL, which contains the raw access token. Substituted into the {{placeholder}} in the '
  'notification body at DISPATCH time. Unreadable by every role: the key is outside the '
  'database, so a dump yields no working links (R-022, NFR-SEC-002, audit C-5).';

ALTER TABLE notification_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_secrets FORCE ROW LEVEL SECURITY;

-- No policy, deliberately. RLS enabled with zero permissive policies means zero rows for every
-- role, forever; the revoke means the attempt fails before RLS is even consulted. The only
-- access is the SECURITY DEFINER function below.
REVOKE ALL ON notification_secrets FROM rms_app;
REVOKE ALL ON notification_secrets FROM PUBLIC;

-- Carry across anything 0042 already stored, then drop the column so there is exactly one
-- place a secret can live.
INSERT INTO notification_secrets (notification_id, cycle_id, params_enc)
SELECT id, cycle_id, secret_params_enc
  FROM notifications
 WHERE secret_params_enc IS NOT NULL
ON CONFLICT (notification_id) DO NOTHING;

ALTER TABLE notifications DROP COLUMN IF EXISTS secret_params_enc;

-- 0042 revoked table-level SELECT to make the column grants bite. With the column gone that
-- restriction has no purpose, and leaving it would keep breaking `SELECT *` for no benefit.
GRANT SELECT ON notifications TO rms_app;

/**
 * Enqueue, with the secret written to the side table in the SAME transaction.
 *
 * Same transaction is the whole point: a message queued without its substitution parameters
 * would send with a literal `{{statusUrl}}` in the body, and the applicant would be looking at
 * a broken link with no way to reach their status page.
 */
CREATE OR REPLACE FUNCTION fn_enqueue_notification(
  p_applicant_id      uuid,
  p_template_key      text,
  p_template_version  smallint,
  p_subject           text,
  p_body_html         text,
  p_body_text         text,
  p_secret_params_enc bytea DEFAULT NULL
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

  -- A raw token reaching a body column is the defect this exists to close, so it is checked
  -- here rather than trusted to the caller. Deliberately a hard failure: a silent strip would
  -- leave the applicant with a broken link and nobody would find out until they used it.
  IF p_body_text ~ '/q/[A-Za-z0-9_-]{22}' OR p_body_html ~ '/q/[A-Za-z0-9_-]{22}' THEN
    RAISE EXCEPTION
      'a raw access token must never be stored in a notification body — use {{statusUrl}} '
      'and pass the value in p_secret_params_enc (R-022)'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF EXISTS (
    SELECT 1 FROM notifications
     WHERE to_email = v_email
       AND state = 'bounced'
       AND bounce_type = 'hard'
       AND cycle_id = v_cycle_id
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

  IF p_secret_params_enc IS NOT NULL THEN
    INSERT INTO notification_secrets (notification_id, cycle_id, params_enc)
    VALUES (v_id, v_cycle_id, p_secret_params_enc);
  END IF;

  RETURN v_id;
END $$;

/**
 * The dispatcher's read. One message, by id.
 *
 * Scoped to a single notification rather than offering a listing: a function that could return
 * every secret in a cycle is one convenience refactor away from being called with a wider
 * argument, and there is no dispatch flow that needs more than the message it is sending.
 */
CREATE OR REPLACE FUNCTION fn_notification_secret(p_notification_id uuid)
RETURNS bytea
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT params_enc FROM notification_secrets WHERE notification_id = p_notification_id
$$;

COMMENT ON FUNCTION fn_notification_secret IS
  'Substitution parameters for ONE queued message, for the dispatcher. Single-row by design '
  '(audit C-5).';

GRANT EXECUTE ON FUNCTION fn_notification_secret(uuid) TO rms_app;

COMMIT;
