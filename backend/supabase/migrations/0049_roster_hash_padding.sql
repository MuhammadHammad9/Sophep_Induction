-- 0045 — The roster hash was base64url-ish, not base64url
--
-- Migration 0035 introduced `fn_roster_bundle_v2` emitting
--
--     translate(encode(token_hash, 'base64'), '+/', '-_')
--
-- which converts the two differing alphabet characters but leaves the PADDING. A sha256 digest
-- is 32 bytes, so its base64 form is 44 characters ending in a single '='. Every device
-- computes the hash with the Web Crypto / Node base64url encoding, which has no padding — 43
-- characters. So every comparison failed, on every single scan.
--
-- The consequence is the specific one migration 0035's own comment warned about and then did
-- not prevent: layer 2 never matches, every scan falls through to layer 3 or to the network,
-- and offline check-in silently does not work. It would have been discovered by switching the
-- WiFi off at the venue — which is item 1 of the event-day checklist, and far too late.
--
-- Found by the test asserting that a real token's `tokenHashB64` appears in the bundle. That
-- test is the one that matters here: a shape assertion on the column list passes happily while
-- every value in it is unusable.
--
-- Refs: FR-CHK-012, FR-CHK-018, E1

BEGIN;

CREATE OR REPLACE FUNCTION fn_roster_bundle_v2(p_cycle_id uuid)
RETURNS TABLE (
  applicant_id   uuid,
  display_id     text,
  full_name      text,
  token_hash_b64 text,
  preferences    text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM fn_require_capability(p_cycle_id, 'checkin.perform');

  RETURN QUERY
  SELECT a.id,
         a.display_id,
         a.full_name,
         -- rtrim the '=' padding, THEN swap the alphabet. This is base64url as every client
         -- runtime produces it; anything else fails silently and only when offline.
         translate(rtrim(encode(t.token_hash, 'base64'), '='), '+/', '-_'),
         COALESCE(
           (SELECT array_agg(d.code ORDER BY p.rank)
              FROM applicant_preferences p
              JOIN departments d ON d.id = p.department_id
             WHERE p.applicant_id = a.id),
           ARRAY[]::text[]
         )
    FROM access_tokens t
    JOIN applicants a ON a.id = t.applicant_id
   WHERE a.cycle_id = p_cycle_id
     AND t.revoked_at IS NULL
     AND t.expires_at > now()
     AND a.state NOT IN ('withdrawn', 'screened_out')
   ORDER BY a.display_id;
END $$;

COMMIT;
