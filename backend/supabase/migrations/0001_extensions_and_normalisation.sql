-- 0001 — Extensions and normalisation functions
--
-- Fixes errata E6. In v1, email_norm was declared as:
--     email_norm citext GENERATED ALWAYS AS (lower(email)) STORED
-- which did nothing at all — `email` was already citext, so case-insensitive by definition —
-- and never implemented the Gmail dot/plus-tag stripping the prose promised. The result was
-- that a.b+induction@gmail.com and ab@gmail.com were treated as different people, which v1
-- explicitly said would not happen.
--
-- These are real IMMUTABLE functions so they can back a generated column and a unique index.
-- Refs: FR-REG-004, FR-REG-005, E6

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive text
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- trigram name similarity (FR-REG-010)
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid, digest


-- Normalise an email address for duplicate detection.
--
-- Gmail (and googlemail) ignore dots in the local part and treat +suffixes as tags, so
-- A.B+induction@Gmail.com and ab@gmail.com are the same mailbox. Every other provider is
-- lowercased and trimmed only — stripping dots for, say, Outlook would merge two genuinely
-- different people, which is far worse than missing a duplicate.
--
-- FR-REG-004
CREATE OR REPLACE FUNCTION norm_email(addr text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN split_part(lower(btrim(addr)), '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(lower(btrim(addr)), '@', 1), '+', 1), '.', '')
           || '@gmail.com'
    ELSE split_part(lower(btrim(addr)), '@', 1) || '@' || split_part(lower(btrim(addr)), '@', 2)
  END
$$;

COMMENT ON FUNCTION norm_email(text) IS
  'Duplicate-detection normalisation. Gmail dots and +tags stripped; others lowercased only. FR-REG-004, E6';


-- Normalise a phone number to its final 9 digits.
--
-- Pakistani mobile numbers appear as 0300-1234567, +92 300 1234567, and 923001234567 — all the
-- same person. The last 9 digits are stable across every one of those spellings.
--
-- FR-REG-005
CREATE OR REPLACE FUNCTION norm_phone(p text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT right(regexp_replace(p, '[^0-9]', '', 'g'), 9)
$$;

COMMENT ON FUNCTION norm_phone(text) IS
  'Duplicate-detection normalisation to the last 9 digits. FR-REG-005';


-- Normalise a roll number: uppercase, strip whitespace and hyphens.
CREATE OR REPLACE FUNCTION norm_roll(r text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT upper(regexp_replace(r, '[\s\-]', '', 'g'))
$$;

COMMIT;
