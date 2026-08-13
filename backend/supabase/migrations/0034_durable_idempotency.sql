-- 0034 — Durable idempotency, and honest conflict resolution
--
-- THE PROBLEM THIS FIXES IS THE CENTRAL PHASE 5 RISK.
--
-- The `idempotency_keys` table has existed since migration 0005 and was never used. Replay
-- protection was an in-memory Map in the application. On Vercel every serverless instance has
-- its own memory, and it is discarded on restart — so:
--
--   * a device that has been offline for eight hours replays ~500 operations
--   * those requests land on SEVERAL different instances
--   * each instance's map is empty, so none of them recognises a replay
--   * duplicates are created
--
-- And it would pass every local test, because one dev server is one instance with one map.
-- FR-CHK-014 requires "100% reconciliation with ZERO duplicate records" — a guarantee an
-- in-memory map cannot make. The claim has to live where the data does.
--
-- FR-CHK-015 is the other half: where an offline operation conflicts with one already
-- recorded, the EARLIEST server-received record wins and the conflict is WRITTEN DOWN.
-- "Silent discard is prohibited" — because the discarded one may be the correct one, and
-- nobody can investigate what was never recorded.
--
-- Refs: FR-CHK-008, FR-CHK-014, FR-CHK-015, FR-CHK-016, FR-OPS-004

BEGIN;

-- The request hash lets us tell a genuine replay from a key being reused for something else.
-- Same key + same hash → replay the stored response. Same key + DIFFERENT hash → 409, because
-- the caller has made a mistake we must not paper over (FR-OPS-004).
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS applicant_id uuid REFERENCES applicants(id),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_idempotency_inflight ON idempotency_keys (created_at)
  WHERE in_flight;

/**
 * Claim a key before doing the work.
 *
 * Returns:
 *   'proceed'  — first time; the caller does the work, then calls fn_complete_idempotent
 *   'replay'   — same key, same request; `response` holds what we answered last time
 *   'conflict' — same key, DIFFERENT request
 *   'in_flight'— a concurrent request holds this key right now
 *
 * The INSERT ... ON CONFLICT is what makes this atomic: two simultaneous replays of the same
 * key cannot both see "no row" and both proceed. That race is precisely what happens when a
 * volunteer double-taps on a flaky connection.
 */
CREATE OR REPLACE FUNCTION fn_claim_idempotency(
  p_key          text,
  p_endpoint     text,
  p_request_hash bytea,
  p_cycle_id     uuid DEFAULT NULL
) RETURNS TABLE (verdict text, response jsonb, status_code smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row idempotency_keys;
BEGIN
  INSERT INTO idempotency_keys (key, cycle_id, endpoint, request_hash, in_flight)
  VALUES (p_key, p_cycle_id, p_endpoint, p_request_hash, true)
  ON CONFLICT (key) DO NOTHING;

  IF FOUND THEN
    verdict := 'proceed';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT * INTO v_row FROM idempotency_keys WHERE key = p_key;

  -- A key expires after 24 hours (FR-OPS-004). Past that it may be reused, which matters
  -- because a device could legitimately be offline across a day boundary.
  IF v_row.expires_at <= now() THEN
    UPDATE idempotency_keys
       SET endpoint = p_endpoint, request_hash = p_request_hash, in_flight = true,
           response_body = NULL, status_code = NULL, completed_at = NULL,
           created_at = now(), expires_at = now() + interval '24 hours'
     WHERE key = p_key;

    verdict := 'proceed';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.request_hash <> p_request_hash THEN
    -- The same key sent with different content. Refusing is the point: silently treating it
    -- as a replay would DISCARD a real operation the caller believes succeeded.
    verdict := 'conflict';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_row.in_flight THEN
    verdict := 'in_flight';
    RETURN NEXT;
    RETURN;
  END IF;

  verdict     := 'replay';
  response    := v_row.response_body;
  status_code := v_row.status_code;
  RETURN NEXT;
END $$;

GRANT EXECUTE ON FUNCTION fn_claim_idempotency(text, text, bytea, uuid) TO rms_app;


/** Store the response so a later replay returns exactly what the caller saw the first time. */
CREATE OR REPLACE FUNCTION fn_complete_idempotent(
  p_key         text,
  p_response    jsonb,
  p_status_code smallint
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE idempotency_keys
     SET response_body = p_response,
         status_code   = p_status_code,
         in_flight     = false,
         completed_at  = now()
   WHERE key = p_key
$$;

GRANT EXECUTE ON FUNCTION fn_complete_idempotent(text, jsonb, smallint) TO rms_app;


/**
 * Release a key whose work failed.
 *
 * Without this a failed attempt would leave the key in_flight forever, and the device's retry
 * — the whole point of an offline queue — would be refused as a concurrent request. The
 * failure would look like a stuck applicant nobody could check in.
 */
CREATE OR REPLACE FUNCTION fn_release_idempotency(p_key text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM idempotency_keys WHERE key = p_key AND in_flight
$$;

GRANT EXECUTE ON FUNCTION fn_release_idempotency(text) TO rms_app;


-- ── Conflict record (FR-CHK-015) ────────────────────────────────────────────────────────
--
-- "Where an offline operation conflicts with one already recorded, the system shall retain the
-- earliest SERVER-RECEIVED record and shall write an audit event for the conflict. Silent
-- discard is prohibited."
--
-- Note SERVER-received, not client-timestamped. FR-CHK-016 makes server time authoritative for
-- business logic precisely because a device clock can be wrong by hours, and a skewed phone
-- must not be able to overwrite a correct record by claiming an earlier time.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id        uuid NOT NULL REFERENCES cycles(id),
  applicant_id    uuid REFERENCES applicants(id),
  kind            text NOT NULL,

  -- What was kept, and what was set aside. BOTH are recorded: the discarded one may turn out
  -- to be the correct one, and nobody can investigate what was never written down.
  retained_id     uuid,
  retained_at     timestamptz,
  discarded_payload jsonb NOT NULL,
  discarded_client_ts timestamptz,

  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts (cycle_id)
  WHERE resolved_at IS NULL;

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_conflict_staff_select ON sync_conflicts FOR SELECT
  USING (fn_has_capability(cycle_id, 'applicant.view'));

CREATE OR REPLACE FUNCTION fn_record_sync_conflict(
  p_cycle_id     uuid,
  p_applicant_id uuid,
  p_kind         text,
  p_retained_id  uuid,
  p_retained_at  timestamptz,
  p_discarded    jsonb,
  p_client_ts    timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO sync_conflicts (
    cycle_id, applicant_id, kind, retained_id, retained_at,
    discarded_payload, discarded_client_ts
  ) VALUES (
    p_cycle_id, p_applicant_id, p_kind, p_retained_id, p_retained_at,
    p_discarded, p_client_ts
  )
  RETURNING id INTO v_id;

  PERFORM fn_audit(
    p_cycle_id, 'sync.conflict', 'sync_conflict', v_id,
    p_discarded,
    jsonb_build_object('retained_id', p_retained_id, 'retained_at', p_retained_at),
    'offline replay conflicted with an existing record; earliest server-received retained'
  );

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION fn_record_sync_conflict(uuid, uuid, text, uuid, timestamptz, jsonb, timestamptz) TO rms_app;


-- Surface unresolved conflicts on the ops dashboard. A conflict nobody looks at is the same as
-- a silent discard, which is the thing FR-CHK-015 forbids.
CREATE OR REPLACE FUNCTION fn_open_sync_conflicts(p_cycle_id uuid)
RETURNS TABLE (conflict_id uuid, display_id text, kind text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, a.display_id, c.kind, c.created_at
    FROM sync_conflicts c
    LEFT JOIN applicants a ON a.id = c.applicant_id
   WHERE c.cycle_id = p_cycle_id AND c.resolved_at IS NULL
   ORDER BY c.created_at
$$;

GRANT EXECUTE ON FUNCTION fn_open_sync_conflicts(uuid) TO rms_app;

COMMIT;
