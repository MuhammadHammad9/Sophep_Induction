-- 0035 — The offline roster bundle, as the JSON spec actually defines it
--
-- ⚠ SPEC CONFLICT, RAISED NOT SILENTLY RESOLVED (CLAUDE.md, notes_for_implementers).
--
--   TRD FR-CHK-018:  "shall contain token hashes and the cycle public key ONLY"
--   spec.json §offline.roster_bundle.contents:
--       applicant id · display_id · name · sha256(token) · department preferences
--       · cycle Ed25519 PUBLIC key · stage configuration
--
-- The JSON wins on precedence, and it is also the only self-consistent reading: the same JSON
-- object requires `manual_search` to "work against the cached roster", and a set of opaque
-- hashes cannot be searched by name or by identifier. A hashes-only bundle would mean that the
-- moment the network drops, the ONLY way in is a working camera and an undamaged QR code —
-- which deletes the entire manual fallback exactly when it is needed.
--
-- What both documents agree on is the part that matters for a device left on a chair: NO
-- evaluations, NO scores, NO decisions, NO private key material. That is enforced here by the
-- column list, not by a convention.
--
-- Migration 0018's narrower `fn_roster_bundle` is left in place; this is a new function, since
-- editing an applied migration is forbidden (R-053).
--
-- Refs: FR-CHK-018, FR-CHK-012, NFR-PERF-009, spec.json offline.roster_bundle, E1

BEGIN;

/**
 * The bundle a check-in device caches each morning.
 *
 * Note what is NOT selected: `state`, any score, any decision. A device carries enough to
 * recognise a person standing in front of a volunteer and nothing that would harm them if the
 * device were lost (RSK-006).
 *
 * `department preferences` are returned as department CODES rather than ids — the volunteer
 * reads them, nothing joins on them, and codes are a third of the size. NFR-PERF-009 caps the
 * bundle at 100 KB for 500 applicants, and per-row bytes are the whole budget.
 */
CREATE OR REPLACE FUNCTION fn_roster_bundle_v2(p_cycle_id uuid)
RETURNS TABLE (
  applicant_id   uuid,
  display_id     text,
  full_name      text,
  token_hash_b64 text,
  preferences    text[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id,
         a.display_id,
         a.full_name,
         -- base64url, matching what the device computes from a scanned token. Plain base64
         -- would differ in two characters and every single comparison would fail — silently,
         -- offline, with no way to debug it at the desk.
         translate(encode(t.token_hash, 'base64'), '+/', '-_'),
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
     -- Someone who withdrew or was screened out must not be checkable-in offline. Their token
     -- is still technically valid; their presence in the hall is not.
     AND a.state NOT IN ('withdrawn', 'screened_out')
   ORDER BY a.display_id
$$;

COMMENT ON FUNCTION fn_roster_bundle_v2 IS
  'Offline bundle per spec.json offline.roster_bundle. Identity + token hash + preferences. '
  'NEVER evaluations, scores, decisions or key material (FR-CHK-018, RSK-006).';

GRANT EXECUTE ON FUNCTION fn_roster_bundle_v2(uuid) TO rms_app;


/**
 * The cycle's Ed25519 PUBLIC key, and only ever the public half.
 *
 * This is a separate function from the roster deliberately. The private key lives in the same
 * row; a single function returning "the cycle's key material" is one careless `SELECT *` away
 * from shipping the signing key to every volunteer's phone — which is errata E1, the exact
 * defect v2 exists to correct (R-021).
 */
CREATE OR REPLACE FUNCTION fn_cycle_public_key(p_cycle_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.qr_public_key_jwk ->> 'x'
    FROM cycles c
   WHERE c.id = p_cycle_id
$$;

COMMENT ON FUNCTION fn_cycle_public_key IS
  'PUBLIC key only, base64url. The private half must never leave the server (E1, R-021).';

GRANT EXECUTE ON FUNCTION fn_cycle_public_key(uuid) TO rms_app;

COMMIT;
