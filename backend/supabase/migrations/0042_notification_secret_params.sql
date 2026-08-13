-- 0042 — Stop persisting raw access tokens in notification bodies
--
-- R-022 is one of the shortest rules in the file and one of the least ambiguous:
--
--   "Never persist a raw token. Store sha256(token) only — not in the database, not in logs,
--    not in backups, not in error output. Why: a database leak must yield no working QR codes
--    and no working status links."
--
-- The registration confirmation violated it on every single application.
--
-- `/api/apply` builds `statusUrl = buildQrPayload(baseUrl, registered.token.raw)` — a URL whose
-- final path segment IS the raw token — and passes it as a template variable. The template
-- renders it into the message, and fn_enqueue_notification writes the rendered text and HTML
-- into `notifications.body_text` / `body_html`, permanently.
--
-- The route's own comment says "The raw token appears in statusUrl here, in this response,
-- once. It is never persisted." That was the intent; it is not what the code did.
--
-- What it costs, concretely:
--   * Every applicant's working QR credential sits in plaintext in the database, and in every
--     backup taken from it, for as long as the row exists.
--   * `notification_staff_select` grants read to anyone holding `applicant.view` — which is
--     every volunteer. A volunteer could lift any applicant's token and check them in, open
--     their status page, or spend their one-time grace extension.
--   * The retention sweep did not touch `notifications` at all (fixed in 0040), so the tokens
--     outlived the anonymisation that was supposed to remove the applicant.
--
-- ── THE FIX, AND WHY IT IS ENCRYPTION RATHER THAN OMISSION ──────────────────────────────
--
-- The obvious fix — leave the link out of the email — is not available. The email exists to
-- deliver that link (FR-REG-012), and how results and links reach applicants is adjacent to
-- OI-6, which is a committee decision rather than an engineering one (R-054). So the delivery
-- model is unchanged; only the storage changes.
--
-- The message is stored with a `{{statusUrl}}` PLACEHOLDER, and the substitution value is held
-- separately in `secret_params_enc` — AES-256-GCM under APP_ENCRYPTION_KEY, the same scheme
-- and the same key custody already used for `cycles.qr_private_key_enc` and
-- `users.totp_secret_enc` (NFR-SEC-002). The dispatcher decrypts, substitutes, and sends; the
-- plaintext exists only in that process's memory, never in a column.
--
-- This satisfies R-022's stated purpose exactly: a database leak — a backup file, a support
-- export, a stolen snapshot — yields ciphertext and no working status links, because the key
-- is not in the database.
--
-- `body_text` and `body_html` keep the placeholder rather than being emptied, so the preview
-- route and template review still show the real message shape (FR-NOT-004), just without a
-- live credential in it.
--
-- Refs: FR-IDT-006, FR-NOT-001, FR-NOT-004, FR-REG-012, NFR-SEC-002, NFR-SEC-004,
--       rules.md R-022, R-050, audit C-5

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS secret_params_enc bytea;

COMMENT ON COLUMN notifications.secret_params_enc IS
  'AES-256-GCM(JSON) of the template variables that must never be stored in plaintext — the '
  'status URL, which contains the raw access token. Substituted into the {{placeholder}} in '
  'body_text/body_html at DISPATCH time. Key is APP_ENCRYPTION_KEY, held outside the database, '
  'so a dump yields no working links (R-022, NFR-SEC-002).';

-- Nobody reads this column through the application role. The dispatcher is a server process
-- holding the key; every other reader — the preview route, the ops dashboard, a staff member
-- with applicant.view — sees the placeholder and has no business seeing more.
-- Same trap as migration 0037's `users.totp_secret_enc`, and worth restating rather than
-- cross-referencing: `REVOKE SELECT (col) ON tbl FROM role` is a SILENT NO-OP when the role
-- holds a table-level SELECT, because column privileges in Postgres are additive. 0036 grants
-- `SELECT ON ALL TABLES TO rms_app`, so the column-only spelling protects nothing.
--
-- Drop the table grant, then re-grant the readable columns explicitly. The list is therefore
-- load-bearing: any column added to `notifications` later is unreadable by the application
-- until it is named here, which is the right default next to encrypted material.
REVOKE SELECT ON notifications FROM rms_app;
REVOKE SELECT ON notifications FROM PUBLIC;

GRANT SELECT (
  id, cycle_id, applicant_id, user_id,
  template_key, template_version,
  to_email, subject, body_html, body_text,
  state, provider_id, attempts, last_error,
  queued_at, delivered_at, bounced_at, bounce_type,
  scheduled_for, created_at
  -- secret_params_enc is deliberately absent.
) ON notifications TO rms_app;

/**
 * Enqueue, now carrying the encrypted parameters alongside the redacted body.
 *
 * Everything migration 0014 established is preserved: the recipient is still derived from the
 * applicant record and can never be supplied by the caller, which is what stops the public
 * application form being an open mail relay. The hard-bounce suppression is the cycle-scoped
 * form from 0040.
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
  SELECT cycle_id, email INTO v_cycle_id, v_email
    FROM applicants
   WHERE id = p_applicant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'applicant % not found', p_applicant_id USING ERRCODE = 'no_data_found';
  END IF;

  -- A raw token reaching a body column is the defect this migration exists to close, so it is
  -- checked here rather than trusted to the caller. `/q/` followed by a 22-character base64url
  -- segment is the shape of a status link; the placeholder form contains no such segment.
  --
  -- Deliberately a hard failure. A silent strip would leave the applicant with a broken link
  -- and nobody would find out until they tried to use it, on the day.
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
    to_email, subject, body_html, body_text, secret_params_enc, state
  ) VALUES (
    v_cycle_id, p_applicant_id, p_template_key, p_template_version,
    v_email, p_subject, p_body_html, p_body_text, p_secret_params_enc, 'pending'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

-- Argument list required: the six-argument form still exists at this point (it is dropped
-- below), so a bare function name is ambiguous and errors.
COMMENT ON FUNCTION fn_enqueue_notification(uuid, text, smallint, text, text, text, bytea) IS
  'Enqueues an applicant notification. The recipient is derived from the applicant record and '
  'can never be supplied by the caller — otherwise the public form becomes an open mail relay. '
  'Refuses any body containing a raw access token (FR-NOT-001, R-022).';

GRANT EXECUTE ON FUNCTION
  fn_enqueue_notification(uuid, text, smallint, text, text, text, bytea) TO rms_app;

-- The 6-argument form is dropped rather than kept as an overload. Leaving it would mean a
-- caller that forgets the new parameter silently gets the old behaviour, which is the exact
-- behaviour this migration exists to remove.
DROP FUNCTION IF EXISTS fn_enqueue_notification(uuid, text, smallint, text, text, text);

COMMIT;
