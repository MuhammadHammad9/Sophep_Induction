-- 0046 — A rate limit that is actually global
--
-- `middleware.ts` counts requests in a `Map`. On Vercel every serverless instance has its own
-- memory, so the configured budget is per-instance and an attacker under load gets N× it. The
-- file says so honestly in its own header and defers the fix to Phase 5.
--
-- That deferral was defensible for the token-lookup limit — a token is 128 bits, so brute force
-- is hopeless regardless and the limiter is really there to protect the database from a
-- scraper. It is NOT defensible for the two limits that guard something guessable:
--
--   * The MFA challenge. A TOTP code is six digits — 10^6, and RFC 6238 accepts a ±1 step
--     drift window, so roughly 3 in 10^6 codes are live at any moment. Five attempts per
--     15 minutes makes that hopeless; five attempts per instance per 15 minutes, across an
--     autoscaling fleet, does not. The rate limit IS the control here: it is what makes six
--     digits an adequate secret rather than a weak one.
--   * Application submission, 3/hour/IP (NFR-SEC-005). Bypassing it is how the applicant table
--     fills with fabricated records during registration.
--
-- A single shared counter in Postgres is the smallest thing that is genuinely global. Redis or
-- Upstash would be faster and would add a third-party service to a request path — CON-004 and
-- R-030 forbid exactly that for check-in, queue claim and evaluation, and adding one for
-- authentication would be the same mistake in a quieter place. The database is already in
-- every one of these paths.
--
-- COST. One UPSERT on a narrow table per limited request. The hot paths (scan, claim, status
-- poll) deliberately do NOT use this — they keep the in-memory limiter, which is a runaway
-- guard rather than a security control, and 4 scans/second per desk should not pay a round
-- trip to be counted.
--
-- Refs: NFR-SEC-005, NFR-SEC-001, CON-004, rules.md R-030, audit S-4

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limits (
  -- '<bucket>:<identity>' — e.g. 'mfa:203.0.113.7' or 'apply:203.0.113.7'. Composite rather
  -- than two columns because every lookup is by the pair and never by one of them.
  key         text PRIMARY KEY,
  count       int  NOT NULL DEFAULT 0,
  window_ends timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Cycle-scoped it is not, and cannot be: the whole point is to limit callers who have not
-- authenticated and therefore have no cycle. This is one of the few tables where R-010 does not
-- apply, for the same reason `users` and `societies` are exempt — it is infrastructure, not
-- cycle data.
COMMENT ON TABLE rate_limits IS
  'Global request counters. Deliberately not cycle-scoped: it limits callers who have no cycle '
  'yet (R-010 exemption, same class as users/societies). Rows expire by window_ends and are '
  'swept by fn_sweep_rate_limits (NFR-SEC-005, audit S-4).';

CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits (window_ends);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits FORCE ROW LEVEL SECURITY;

-- No policy, deliberately — the same shape as `idempotency_keys`. There is no legitimate
-- reader: the only access is the SECURITY DEFINER function below, and a table of IP addresses
-- and request counts is not something any endpoint should be able to enumerate.
REVOKE ALL ON rate_limits FROM rms_app;
REVOKE ALL ON rate_limits FROM PUBLIC;

/**
 * Consume one unit against a bucket. Returns whether the caller may proceed.
 *
 * The whole decision is ONE statement, and that matters more than it looks: two concurrent
 * requests doing read-then-write would both read the same count and both be allowed, which is
 * precisely the race an attacker parallelises. `INSERT … ON CONFLICT DO UPDATE` takes a row
 * lock, so the increment is atomic and concurrency cannot buy extra attempts.
 *
 * The window is fixed rather than sliding. A sliding window needs the timestamps of individual
 * attempts, which means storing a row per request; for a limiter whose job is to make brute
 * force impractical, the extra precision is not worth the write volume.
 */
CREATE OR REPLACE FUNCTION fn_rate_limit_consume(
  p_key        text,
  p_max        int,
  p_window_sec int
) RETURNS TABLE (allowed boolean, retry_after_seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count int;
  v_ends  timestamptz;
BEGIN
  INSERT INTO rate_limits (key, count, window_ends)
  VALUES (p_key, 1, now() + make_interval(secs => p_window_sec))
  ON CONFLICT (key) DO UPDATE
     SET count = CASE
                   -- Expired window: start a fresh one rather than carrying the old count.
                   WHEN rate_limits.window_ends <= now() THEN 1
                   ELSE rate_limits.count + 1
                 END,
         window_ends = CASE
                   WHEN rate_limits.window_ends <= now()
                     THEN now() + make_interval(secs => p_window_sec)
                   ELSE rate_limits.window_ends
                 END
  RETURNING count, window_ends INTO v_count, v_ends;

  allowed := v_count <= p_max;
  retry_after_seconds := GREATEST(0, ceil(extract(epoch FROM (v_ends - now())))::int);
  RETURN NEXT;
END $$;

COMMENT ON FUNCTION fn_rate_limit_consume IS
  'Atomic global counter. One statement so concurrent callers cannot both read the same count '
  'and both be allowed — that race is what an attacker parallelises (NFR-SEC-005).';

GRANT EXECUTE ON FUNCTION fn_rate_limit_consume(text, int, int) TO rms_app;

/**
 * Delete expired windows.
 *
 * Without this the table grows by one row per distinct IP per bucket, forever. Called by the
 * scheduled job alongside the other maintenance sweeps; it is safe to run at any time because
 * an expired row carries no information — the function treats a missing row and an expired one
 * identically.
 */
CREATE OR REPLACE FUNCTION fn_sweep_rate_limits()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM rate_limits WHERE window_ends < now() - interval '1 hour';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

GRANT EXECUTE ON FUNCTION fn_sweep_rate_limits() TO rms_app;

COMMIT;
