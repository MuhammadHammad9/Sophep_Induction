-- 0051 — Redact raw access tokens already sitting in notification bodies
--
-- Migrations 0042 and 0047 stop NEW tokens being stored: the body carries a `{{statusUrl}}`
-- placeholder, the value lives encrypted in `notification_secrets`, and
-- `fn_enqueue_notification` now refuses outright any body matching `/q/<22 chars>`.
--
-- None of that touches a row that is already there. On a database that has been taking
-- registrations, every confirmation email ever queued still holds a working credential in
-- plaintext, readable by anyone with `applicant.view` — which is every volunteer — and present
-- in every backup taken since. The preflight script reports the count; on an existing
-- deployment it will not be zero.
--
-- Closing C-5 on a live database therefore needs this pass as well. Without it the fix is
-- "no new leaks", which is not what R-022 says.
--
-- ── WHAT HAPPENS TO EACH ROW, AND WHY THEY DIFFER ───────────────────────────────────────
--
-- ALREADY SENT (queued, delivered, bounced, complained, failed): the body is a historical
-- record of a message that has already left. Redacting the token costs nothing — the applicant
-- has the real link in their inbox — and removes the credential from the database. The
-- placeholder is substituted back in so the row still shows what was sent.
--
-- STILL PENDING: redacting alone would send an email containing the literal text
-- `{{statusUrl}}` and no way to reach the status page, because the substitution value was never
-- captured for these rows — the raw token is not recoverable from anywhere (only its sha256 is
-- stored, by design, R-022). So the token is removed AND the row is marked `failed` with a
-- reason, rather than being sent broken or silently dropped.
--
-- Re-enqueueing those is an operator action, deliberately: it needs a freshly issued token per
-- applicant (`fn_issue_token`), which rotates a live credential and belongs behind a human
-- decision rather than inside a migration. `fn_open_sync_conflicts` is the precedent — surface
-- it, do not guess.
--
-- The count is audited so the size of the exposure is on the record rather than inferred from
-- a diff later.
--
-- Refs: FR-IDT-006, FR-NOT-001, NFR-SEC-004, rules.md R-011, R-022, audit C-5

BEGIN;

DO $$
DECLARE
  v_pattern    text := '/q/[A-Za-z0-9_-]{22}';
  v_sent       int  := 0;
  v_pending    int  := 0;
  v_cycle      uuid;
BEGIN
  -- Nothing to do on a fresh database. Guarded so this is a no-op rather than an error there.
  IF NOT EXISTS (
    SELECT 1 FROM notifications
     WHERE body_text ~ v_pattern OR body_html ~ v_pattern
  ) THEN
    RAISE NOTICE '0051: no notification body contains a raw access token — nothing to redact';
    RETURN;
  END IF;

  -- Already sent: redact in place, keep the row readable.
  UPDATE notifications
     SET body_text = regexp_replace(body_text, 'https?://[^\s<>"]*' || v_pattern, '{{statusUrl}}', 'g'),
         body_html = regexp_replace(body_html, 'https?://[^\s<>"]*' || v_pattern, '{{statusUrl}}', 'g')
   WHERE (body_text ~ v_pattern OR body_html ~ v_pattern)
     AND state <> 'pending';
  GET DIAGNOSTICS v_sent = ROW_COUNT;

  -- Still pending: redact, then refuse to send rather than send something broken.
  UPDATE notifications
     SET body_text = regexp_replace(body_text, 'https?://[^\s<>"]*' || v_pattern, '{{statusUrl}}', 'g'),
         body_html = regexp_replace(body_html, 'https?://[^\s<>"]*' || v_pattern, '{{statusUrl}}', 'g'),
         state      = 'failed',
         last_error = 'redacted by migration 0051: contained a raw access token (R-022). '
                   || 'Re-enqueue with a freshly issued token — the original is unrecoverable.'
   WHERE (body_text ~ v_pattern OR body_html ~ v_pattern)
     AND state = 'pending';
  GET DIAGNOSTICS v_pending = ROW_COUNT;

  -- One audit row per cycle affected. The exposure is recorded as a number rather than left to
  -- be reconstructed from a backup diff (R-011).
  FOR v_cycle IN
    SELECT DISTINCT cycle_id FROM notifications WHERE body_text LIKE '%{{statusUrl}}%'
  LOOP
    PERFORM fn_audit(
      v_cycle, 'data.redacted', 'cycle', v_cycle,
      NULL,
      jsonb_build_object('sent_redacted', v_sent, 'pending_failed', v_pending,
                         'reason', 'raw access tokens removed from notification bodies'),
      'migration 0051 — R-022 remediation on existing rows'
    );
  END LOOP;

  RAISE NOTICE '0051: redacted % sent and % pending notification(s)', v_sent, v_pending;
END $$;

COMMIT;
