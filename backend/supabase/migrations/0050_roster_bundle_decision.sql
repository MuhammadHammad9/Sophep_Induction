-- 0050 — The roster bundle conflict, decided; and the offline search gap it was hiding
--
-- ── THE CONFLICT ────────────────────────────────────────────────────────────────────────
--
--   TRD FR-CHK-018: the offline roster bundle "shall contain token hashes and the cycle
--                   public key only".
--   spec.json offline.roster_bundle.contents: applicant id, display_id, name, sha256(token),
--                   department preferences, the PUBLIC key, stage configuration.
--
-- Precedence alone settles this (the JSON wins), but precedence is the weakest reason and it
-- is not the one relied on here. The TRD contradicts ITSELF:
--
--   FR-CHK-009  "shall provide manual check-in by search on any 4 consecutive digits of the
--                identifier, the final 4 digits of the phone number, or partial name"
--   FR-CHK-012  "check-in shall function with no network connectivity for at least 8
--                continuous hours"
--
-- Both are mandatory. Together they require searching by NAME and by PHONE with no network,
-- which a set of opaque hashes cannot do. A hashes-only bundle means that the moment the WiFi
-- drops, the only way in is a working camera and an undamaged QR code — and FR-CHK-009, a
-- *shall* verified by demonstration, becomes unimplementable exactly when it matters most.
--
-- DECISION: build to spec.json. FR-CHK-018 is a defect in the TRD, to be corrected at
-- baselining. Recorded in ROADMAP.md so the committee sees it rather than inheriting it.
--
-- ── WHAT FR-CHK-018 WAS PROTECTING, AND HOW THAT IS KEPT ────────────────────────────────
--
-- The concern behind it is real and is RSK-006: a volunteer's personal phone, holding the
-- whole cohort, left on a chair. Choosing a document does not answer that; it has to be
-- answered separately, and it is, in three ways:
--
--   1. MINIMUM SUFFICIENT DATA. This migration carries exactly what FR-CHK-009's three search
--      modes need and nothing beyond it. Note `phone_last4` rather than the phone number: the
--      requirement is "the final 4 digits", so the final 4 digits are all that is shipped. A
--      lost device yields no reachable contact detail for anybody.
--   2. NOTHING EVALUATIVE, EVER. No scores, no decisions, no evaluations, no key material —
--      the half of FR-CHK-018 that both documents agree on, enforced by this column list
--      rather than by convention.
--   3. IT EXPIRES. The device holds it for 16 hours and wipes on sign-out (indexeddb.ts).
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────
--
-- Until now the bundle carried no phone digits at all, so offline manual search silently
-- supported two of FR-CHK-009's three modes. A volunteer whose applicant has a damaged QR code
-- and an unfamiliar spelling of their name has exactly one route left — the phone number — and
-- offline it did not work. Nothing reported this; the search simply returned nothing, which is
-- indistinguishable from "not registered".
--
-- Refs: FR-CHK-009, FR-CHK-012, FR-CHK-018, RSK-006, spec.json offline.roster_bundle

BEGIN;

-- DROP first, and it is not optional.
--
-- This adds `phone_last4` to the returned columns, and Postgres refuses CREATE OR REPLACE when
-- a function's OUT parameters change:
--
--     ERROR: cannot change return type of existing function
--
-- Without this line the migration applies cleanly to an empty database and FAILS on every
-- database that has already run 0035/0038 — i.e. on the first real deployment, and never in
-- local testing. Caught by tests/schema, which applies the whole set in order.
DROP FUNCTION IF EXISTS fn_roster_bundle_v2(uuid);

CREATE OR REPLACE FUNCTION fn_roster_bundle_v2(p_cycle_id uuid)
RETURNS TABLE (
  applicant_id   uuid,
  display_id     text,
  full_name      text,
  phone_last4    text,
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
         -- FR-CHK-009 asks for the final four digits, so the final four digits are what leaves
         -- the database. Derived from `phone_norm` so it matches what the ONLINE search compares
         -- against (`phone_norm LIKE '%' || digits`) — two search paths disagreeing about which
         -- digits count is a bug nobody would find until a volunteer was standing at the desk.
         right(a.phone_norm, 4),
         -- rtrim the '=' padding BEFORE swapping the alphabet: this is base64url as every client
         -- runtime produces it. Padded output fails every comparison silently, and only offline.
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
     -- Someone who withdrew or was screened out must not be checkable-in offline. Their token
     -- is still technically valid; their presence in the hall is not.
     AND a.state NOT IN ('withdrawn', 'screened_out')
   ORDER BY a.display_id;
END $$;

-- DROP discards the function's privileges along with the function. Migration 0044's event
-- trigger revokes PUBLIC execute on anything newly created, which is the half that protects us;
-- nothing re-grants rms_app, so without this line the application loses the ability to build a
-- roster bundle at all — and only on a database that had the old function to drop.
GRANT EXECUTE ON FUNCTION fn_roster_bundle_v2(uuid) TO rms_app;

COMMENT ON FUNCTION fn_roster_bundle_v2(uuid) IS
  'Offline bundle per spec.json offline.roster_bundle, carrying exactly what FR-CHK-009 needs '
  'to search offline: identifier, name, final 4 phone digits, token hash, preferences. NEVER '
  'evaluations, scores, decisions or key material. FR-CHK-018 conflicts with FR-CHK-009 and '
  'FR-CHK-012 and is a TRD defect — see ROADMAP.md.';

COMMIT;
