-- 0005 — Audit log, idempotency, notifications
--
-- The audit log's entire value is that it cannot be edited and cannot be missing. Both of
-- those are enforced here at the database level, because an audit that depends on application
-- discipline is an audit that disappears exactly when it matters — during a disputed result.
--
-- Refs: FR-AUD-001..004, FR-OPS-004, FR-NOT-001..005, DR-006

BEGIN;

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  cycle_id     uuid REFERENCES cycles(id),

  -- actor_id is NULL for system-initiated transitions (scheduled stage advance, grace
  -- expiry). actor_role records which of a multi-role user's hats they were wearing.
  actor_id     uuid REFERENCES users(id),
  actor_role   role_name,
  actor_label  text,          -- 'system', 'applicant:SPH-SP26-0042', for non-user actors

  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    uuid,

  before       jsonb,
  after        jsonb,
  reason       text,

  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_cycle_time ON audit_events (cycle_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_events (actor_id, created_at DESC);

-- FR-AUD-003: append-only, enforced by privilege. Revoking from PUBLIC alone is not enough
-- on Supabase, where application roles are granted explicitly.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON audit_events FROM %I', r);
      EXECUTE format('GRANT INSERT, SELECT ON audit_events TO %I', r);
    END IF;
  END LOOP;
END $$;

-- Belt and braces. Privileges can be re-granted by a careless later migration; this trigger
-- cannot be bypassed by anything short of dropping it, which is visible in review.
CREATE OR REPLACE FUNCTION fn_audit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (FR-AUD-003, rules.md R-011): % attempted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fn_audit_immutable();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION fn_audit_immutable();

COMMENT ON TABLE audit_events IS
  'Append-only. Written in the SAME TRANSACTION as the change described — no audit, no commit. FR-AUD-001/002/003, rules.md R-011';


-- FR-OPS-004 / FR-CHK-008. One mechanism makes the flaky-network double-tap harmless and
-- offline replay safe by construction (rules.md R-051).
--
-- Same key + same request hash -> replay the stored response.
-- Same key + different hash    -> 409 IDEMPOTENCY_KEY_REUSED.
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  cycle_id      uuid REFERENCES cycles(id),
  endpoint      text NOT NULL,
  request_hash  bytea NOT NULL,
  response_body jsonb,
  status_code   smallint,

  -- Set on insert, cleared when the response is stored. Lets a concurrent duplicate wait
  -- or fail fast rather than executing the operation a second time.
  in_flight     boolean NOT NULL DEFAULT true,

  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE INDEX idx_idempotency_expiry ON idempotency_keys (expires_at);


-- FR-NOT-001: all outbound email is dispatched via an asynchronous queue with retry. Email
-- is NEVER sent synchronously inside a request a user is waiting on.
--
-- While no Resend account and verified domain exist, the mock adapter writes rows here and
-- stops at 'queued'; they render at the local preview route. The asynchronous contract holds
-- either way, so swapping the real provider in is an adapter change, not an architecture change.
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id       uuid NOT NULL REFERENCES cycles(id),
  applicant_id   uuid REFERENCES applicants(id),
  user_id        uuid REFERENCES users(id),

  -- FR-NOT-004: templates are configuration, previewable and versioned. Never hard-coded.
  template_key   text NOT NULL,
  template_version smallint NOT NULL DEFAULT 1,

  to_email       text NOT NULL,
  subject        text NOT NULL,
  body_html      text NOT NULL,
  body_text      text NOT NULL,

  state          notification_state NOT NULL DEFAULT 'pending',
  provider_id    text,
  attempts       smallint NOT NULL DEFAULT 0,
  last_error     text,

  -- FR-NOT-002: per-recipient delivery state from provider webhooks.
  queued_at      timestamptz,
  delivered_at   timestamptz,
  bounced_at     timestamptz,
  bounce_type    text,          -- 'hard' bounces block future sends (FR-DEC-013)

  scheduled_for  timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CHECK (applicant_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE INDEX idx_notifications_pending ON notifications (scheduled_for)
  WHERE state IN ('pending', 'queued');
CREATE INDEX idx_notifications_applicant ON notifications (applicant_id, created_at DESC);
-- FR-NOT-003 / FR-DEC-013: hard bounces surface as actionable items on the ops dashboard.
CREATE INDEX idx_notifications_bounced ON notifications (cycle_id) WHERE state = 'bounced';

COMMENT ON TABLE notifications IS
  'Asynchronous outbound queue. FR-NOT-001: never dispatched synchronously in a user-facing request.';

COMMIT;
