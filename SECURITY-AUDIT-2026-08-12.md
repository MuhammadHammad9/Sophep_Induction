# SOPHEP RMS — Adversarial Security & Scalability Audit

**Date:** 2026-08-12 · **Branch:** `main` @ `4f89c54` · **Method:** white-box source review of the
full attack surface (frontend routes, API handlers, service layer, 34 SQL migrations, RLS
policies, PWA/offline layer), plus execution of `npm run verify`, the test suites, and
`npm audit`.

**Scope tested:** server-side authn/authz, database privilege model, RLS boundary, SQL-level
IDOR, token lifecycle, idempotency/replay, client-side XSS/CSP, offline sync integrity,
dependency supply chain, and load behaviour at the stated scale (1,000 applicants / 30
interviewers / 20 panels).

---

## 0a. Remediation status — updated 2026-08-12

Everything below was written as a findings report. This section records what has since been
**fixed**, what is **partially** fixed, and what is **not**, so the document stays the single
source of truth rather than drifting into a historical artefact.

Migrations `0036`–`0047` are new. `0035_roster_bundle` and `0039_reconcile_capability` came from
concurrent work in the IDE, which is why this set is numbered around them.

**All 49 migrations apply to a real PostgreSQL 18.4 server, and every suite passes: 47 schema
assertions, 94 RLS, 36 concurrency, 54 golden** — see the verification section below, including the two defects that executing
found in the remediation itself.

| ID | Finding | Status | Where |
|---|---|---|---|
| C-1 | `/api/fast-track` unauthenticated | **Fixed** | `route.ts` + `page.tsx`: `requireStaff` + both capabilities, `source` typo corrected, idempotency key, own rate-limit bucket |
| C-2 | Every function EXECUTE-able by `PUBLIC` | **Fixed & proven** | `0036` revokes from PUBLIC/anon/authenticated + schema `USAGE`; `0044` adds an event trigger making it self-enforcing; `0038`/`0041` add the missing capability checks |
| C-3 | `users` and 4 others without RLS | **Fixed & proven** | `0037`: RLS + policies on all five, `totp_secret_enc` genuinely unreadable (the first attempt was a no-op — see below), `idempotency_keys` unreadable by design |
| C-4 | `fn_respond_to_offer` IDOR | **Fixed** | `0038`: applicant ownership, or staff acting on behalf — recorded distinctly in the audit row |
| C-5 | Raw tokens persisted in `notifications` | **Fixed & proven** | `0042` + `0047`: `{{statusUrl}}` placeholder, ciphertext in an unreadable `notification_secrets` side table; DB *refuses* any body matching `/q/<22 chars>` |
| C-6 | Build broken, idempotency half-migrated | **Fixed** | Routes wired to the 3-arg durable form; `npm run verify` typechecks and lints clean |
| C-7 | No CSRF protection | **Fixed** | `middleware.ts`: `Origin` allowlist on every non-GET `/api/*` |
| H-1 | `audit_insert WITH CHECK (true)` | **Fixed** | `0040`: INSERT revoked from `rms_app`; actor-bound policy; `fn_audit` is structurally the only writer |
| H-2 | `fn_anonymise_old_data` edits the audit log | **Fixed** | `0040`: capability-or-owner gate, forward-only redaction, audits itself, now scrubs `notifications` |
| H-3 | Offline sync treats 409 as success | **Fixed** (concurrent work) | `sync.ts`: distinct `conflict` status, ordering preserved on transient failure |
| H-4 | Ops stranded in `syncing` | **Fixed** (concurrent work) | `sync.ts` / `useOfflineSync.ts` |
| H-5 | Missing capability checks on 4 routes | **Fixed** | skip, start, snapshot, parked: capability + UUID validation + IR-002 error bodies |
| H-6 | No sign-in route; MFA unwired | **Fixed & proven** | `/staff/sign-in` + `/auth/callback`; `0045` + `/staff/mfa` + `/api/mfa/*` complete the second factor, gated on ops and fast-track. 6 assertions |
| H-7 | No `FORCE ROW LEVEL SECURITY` | **Fixed** | `0037`, guarded so it cannot brick a non-BYPASSRLS owner |
| H-8 | `idempotency_keys` readable | **Fixed** | `0037` |
| H-9 | Realtime channels unauthorised | **Fixed & proven** | Replaced with `/api/live`, an authenticated SSE endpoint under `requireStaff` + `withContext` — one authorisation model, capability re-checked per tick. Verified 401 unauthenticated |
| H-10 | DB test suite never runs | **Fixed & proven** | `verify.yml` sets `RMS_ALLOW_DESTRUCTIVE_TESTS` and applies migrations first. New `npm run test:schema` proves the perimeter on **any** machine with no DB infrastructure. All four suites now execute: 47 + 94 + 36 + 54 |
| M-1 | No CSP | **Fixed & proven** | `middleware.ts`. First two attempts broke hydration app-wide — see below. Final policy verified in a browser: zero violations, React hydrates |
| M-2 | Matcher misses most of the app | **Fixed** | Matcher inverted to cover everything but static assets |
| M-3 | `x-real-ip` trusted blindly | **Fixed** | Trusted only behind `TRUST_X_REAL_IP` / `VERCEL` |
| M-4 | XFF parsed inconsistently | **Fixed** | Last element everywhere |
| M-5 | Account linking by email | **Fixed** | `0037` + `session.ts`: verified auth uid only |
| M-6 | Arbitrary cycle ordering | **Fixed** | `0037`: chronological season ordering |
| M-7 | JWT claim trusted first | **Fixed** | `0040`: branch removed from both accessors |
| M-8 | `fn_submit_evaluation` gaps | **Fixed** | `0041`: caller identity, `left_at`, recusal on submit |
| M-9 | Hard bounce not cycle-scoped | **Fixed** | `0040` |
| M-10 | `/display` DoS amplifier | **Fixed** | Own rate-limit bucket, 30/min |
| M-11 | Roster PII never expires on devices | **Fixed** | `indexeddb.ts`: 16h TTL, purge before every read, `clearRoster()` for sign-out |
| M-12 | `navigator.onLine` sole signal | **Fixed** (concurrent work) | `useOfflineSync.ts` probes by trying |
| M-13 | Search ignores its own schema | **Fixed** | Route now uses `applicantSearchSchema` |
| M-14 | Token parsing inconsistent | **Fixed** | `/q/[token]` uses `parseQrPayload` |
| S-1 | Pool ceiling + 7 round-trips per request | **Fixed** | `db.ts`: one `set_config` statement, pool 10 → 40 (configurable) |
| S-2 | `COUNT(*)` per status poll | **Fixed** | `0043`: `idx_queue_applicant_recent` and three more |
| S-4 | Rate limiter is per-instance | **Fixed & proven** | `0046`: one atomic UPSERT in Postgres. Wired into MFA verify and `/api/apply` — the two limits that guard something *guessable*. 6 assertions incl. a 20-way concurrency test |
| S-9 | Service-role key importable into a request path | **Fixed** | Both jobs rewritten onto `asPrivileged` |

### Verification — everything is executed against a real PostgreSQL server

The first remediation pass was type-checked and SQL-parsed but never run. That was not good
enough: the original C-2 finding existed precisely because a defect whose only symptom is
"everything works, for everybody" cannot be caught by reading.

Every suite now runs, and all of them pass.

| Suite | Engine | Result |
|---|---|---|
| `npm run verify` (typecheck, lint, unit + schema) | — | **174 passed, 0 failed**, 0 lint errors |
| `npm run test:schema` — privilege perimeter | PGlite (PostgreSQL 18, WASM, no infrastructure) | **48 passed** |
| `npm run test:rls` — policy boundary | **real PostgreSQL 18.4 server** | **94 passed** |
| `npm run test:concurrency` — 20 actors | **real PostgreSQL 18.4 server** | **38 passed** |
| `npm run test:golden` — determinism | **real PostgreSQL 18.4 server** | **54 passed** |
| `npm run test:e2e` — CSP, hydration, auth gates, PWA, signed-in flow | **real Chromium** | **16 passed** |

All **51 migrations** apply cleanly to both engines from an empty database, and to a
database that already ran earlier ones.

The concurrency and RLS suites had **never executed anywhere** before this work — CI provisioned
Postgres but never set `RMS_ALLOW_DESTRUCTIVE_TESTS`, so 157 tests failed on the safety guard
there exactly as they did locally. They now run, which means `FR-QUE-002`'s twenty simultaneous
claims, the `R-020` duplicate-ID race, `E9`'s pooled-connection behaviour and `E8`'s allocation
determinism are demonstrated rather than asserted.

### The app was run end to end, and it found three more defects

A production build was served against a throwaway PostgreSQL, seeded with a real cycle, and
attacked with curl. Every gate held:

| Probe | Result |
|---|---|
| `POST /api/fast-track` anonymously (**C-1**) | **401** |
| `POST /api/checkins` with `Origin: evil.example.com` (**C-7**) | **403** |
| Same request with a legitimate `Origin` | 401 — refused for auth, not origin |
| All seven staff routes with no session (**H-5**) | **401** each |
| `/api/apply` x5 from one IP (**S-4**, 3/hour) | 201, 201, 201, **429, 429** |
| CSP / X-Frame-Options / HSTS / Referrer-Policy on a live response (**M-1, M-2**) | all present |
| `/q/<garbage>` and `/api/q/<garbage>/status` (**M-14**) | **404**, no stack trace |
| `/fast-track` unauthenticated | **307 → `/staff/sign-in?next=/fast-track`**, which now exists (**H-6**) |
| Full registration, then decrypt-and-substitute (**C-5**) | body stores `{{statusUrl}}`; emailed token resolves to `SPH-SP26-0002`; **zero** raw tokens in any body |

Three defects surfaced that no test had caught:

4. **The CI encryption key was invalid.** `APP_ENCRYPTION_KEY` in `verify.yml` decoded to 34
   bytes, and `encryptionKeyFromEnv` correctly demands exactly 32 — so every encrypting path
   (QR signing, notification secrets, TOTP) would have failed in CI with a confusing error.
   Registration returned a 500 until it was replaced with a verified 32-byte value.

5. **`enqueue` computed the ciphertext and then threw it away.** A scripted edit to the SQL call
   had silently not applied, so `fn_enqueue_notification` was invoked without its secret
   parameter. Nothing failed: the row was created, the body held the placeholder, and every
   existing C-5 assertion still passed — because *"no raw token is stored"* is trivially
   satisfied by storing nothing at all. The applicant would have received an email containing
   the literal text `{{statusUrl}}` and no way to reach their status page. The regression test
   now asserts the other half: the substitution value must actually be there.

6. **Migration `0050` could not apply to any existing database.** It adds a column to
   `fn_roster_bundle_v2`'s `RETURNS TABLE`, and Postgres refuses `CREATE OR REPLACE` when a
   function's OUT parameters change. It applied cleanly to an empty database and would have
   failed on the first real deployment. Fixed with a `DROP FUNCTION` first.

Defect 5 is the one worth remembering: it is a *security fix that silently did nothing*, and
the tests written to prove the security property were structurally incapable of noticing.

### The systemic gap is now closed, and the guard is proven to work

The CSP defect below was not bad luck. It was the predictable consequence of a suite where
**nothing loaded a page in a browser**: a header test reads the header, a route test reads the
JSON, and neither notices that the page arrived and then did nothing.

`frontend/tests/e2e/security-smoke.spec.ts` closes that. It runs in real Chromium and asserts
what only a browser can see — that the page HYDRATES (`__next_f`, the RSC flight stream
populated by exactly the inline scripts a strict `script-src` blocks), that the browser itself
reports **zero** CSP violations, that the headers are present on a real navigation, and that the
auth gates redirect rather than render.

**It is verified to catch the bug**, not merely written: reintroducing the exact broken CSP
turns it red on all three pages —

```
Error: / reported CSP violations
Error: /apply reported CSP violations
Error: /staff/sign-in reported CSP violations
3 failed, 5 passed
```

— and the restored policy passes 10/10. Wired into `verify.yml` so it runs on every push.

`walk-in.spec.ts` was also rewritten. It previously **asserted the C-1 security hole as the
expected behaviour**: it navigated to `/fast-track`, filled the form and submitted, with no
authentication anywhere, because at the time there was none. A passing test for that flow is
worse than no test — it is a standing statement that the unauthenticated path is correct, and
the next person to fix the failing test would have reopened the hole to make it green. The
unauthenticated case is now asserted as a refusal (page redirect **and** a 401 from the API);
the signed-in flow is `fixme` pending a staff auth fixture rather than deleted, so the FR-CHK-010
coverage is not quietly lost.

### The signed-in flow is covered, without weakening the boundary

Every other browser test asserts a REFUSAL — which is the important half, and also the half a
completely broken app would pass: a server returning 401 to everything satisfies all of them.
Nothing demonstrated that a legitimate staff member can get in, and for most of this project's
life they could not (H-6, the bootstrap deadlock).

`requireStaff` calls `supabase.auth.getUser()`, which verifies a JWT against Supabase's auth
server, so a signed-in test needs one. The tempting shortcut is a `TEST_MODE` flag that skips
auth — a supported way to skip the exact boundary this audit exists to defend, one environment
variable from production. Instead the **external dependency is doubled** and the application is
untouched, which is what `services/notifications.ts` already does for email. Everything
downstream is real: real cookie parsing by `@supabase/ssr`, real `fn_resolve_staff_session`,
real capability lookup, real RLS.

The full FR-CHK-010 walk-in now runs through the actual UI, and the database shows the result:

```
SPH-SP26-0001 | E2E Walkin … | source walkin_digital | state queued
queue entries: 1
check-ins: register_and_checkin 1
audit: applicant.registered, token.issued, applicant.checked_in, queue.enqueued
```

`source walkin_digital` is the C-1 typo fix working — before it, every request was rejected as
`walk_in_digital`. Four audit rows in the same transaction is R-011 holding on a real write.

### That test immediately found another defect

The fast-track page queried `stages.state = 'active'` and `ORDER BY s.start_time`. **Neither
column exists** — `stages` carries `starts_at`, `ends_at` and `closed_at`, and "open" is derived
from them. The page therefore returned a 500 to every authenticated staff member.

It could not have been caught by typecheck (the SQL is a template string), and no test caught it
because nothing had ever loaded that page while signed in. The predecessor had the same bug, so
it had been broken the whole time behind an auth gate nobody could pass. Now: open means started
and not closed, with `ends_at` treated as a plan rather than a deadline — a stage running late
is still open until somebody closes it, which is what the floor needs.

### Offline capability is now verified too

Service worker registration had never been demonstrated. It failed in the embedded preview
browser, which disables service workers — so the failure said nothing about the app. Under real
Chromium it **registers and takes control at the origin root**, which is what FR-CHK-012's eight
hours of offline check-in depends on.

A second test asserts the worker never caches `/api/*`. That is the rule that keeps offline
honest: mutations replay through IndexedDB with idempotency keys, never through a cache that
would hand back an hour-old queue position as though it were current (NFR-AVAIL-005,
design principle 2).

### One more defect, found by the browser suite tripping over it

Rate-limiting `/staff/sign-in` was wrong twice over. It limited **GET page views**, so a
volunteer who reloaded the sign-in page five times could not see the form for fifteen minutes —
on the morning of the event, at a desk, that is the system unusable for the people it is hardest
for (NFR-USE-001). And it protected nothing: `supabase.auth.signInWithOtp` runs **client-side**
and never passes through the middleware. Pure cost, no benefit. The limit now applies to
`/auth/callback`, which exchanges a one-time code and is worth limiting; the credential check
that actually guards a guessable secret is `/api/mfa/verify`, on the durable per-user counter.

The browser suite hit that limit on its own sign-in page and went red — the same way a volunteer
would have.

### The browser found the worst defect of all — in my own CSP

Loading a page in a real browser (not curl) revealed that **the Content-Security-Policy added
for M-1 broke the entire application**.

Next.js emits inline `<script>` tags carrying hydration data on every server-rendered page. A
`script-src 'self'` blocks them, React fails to hydrate (minified error #412), and every client
component stops working: the scanner, the forms, the offline replay queue. `curl` showed a
textbook-perfect security header over a completely dead app, and every test still passed —
because nothing in the suite loads a page in a browser.

This is the failure `next.config.ts` had warned about in its own comment ("a wrong CSP that
blocks the websocket would take out the whole live layer"), and I shipped a broader version of
it while fixing something else.

Two attempts were needed:

- `script-src 'self' 'nonce-<n>' 'strict-dynamic'` — the documented Next.js pattern, nonce set
  on both request and response headers. **This version of Next does not stamp its inline
  scripts with the nonce**, so the browser still blocked them. Verified in a browser, not
  assumed.
- `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — works. Hydration confirmed
  (`__next_f` present, React owns the DOM, zero CSP violations in a clean tab).

**This is a real weakening and it is recorded as such**, not glossed: `'unsafe-inline'` is the
directive that would otherwise stop an injected `<script>` from running. What remains is still
substantial — `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
`form-action 'self'`, and a `connect-src` that pins where data may be sent — and it is a large
improvement on the **no CSP at all** this app shipped with. The correct fix is nonce
propagation once Next supports it; the middleware comment says so, and says not to tighten it
without loading a page in a browser first.

### H-9 is now implemented, not deferred

`/api/live` is an authenticated SSE endpoint. Each subscription is an ordinary HTTP request, so
`requireStaff` and `withContext` apply and the **same** policies decide what a subscriber sees —
one authorisation model instead of two that must agree forever. Capability is re-checked on
every tick, so a revocation mid-event closes the stream rather than silently emptying it. Frames
carry the server's own read instant, so `lastUpdated` can never be optimistic (NFR-AVAIL-004),
and a heartbeat distinguishes "nothing changed" from "the stream died".

Verified live: unauthenticated → **401** with a proper SSE error frame; malformed scope
rejected; auth checked before scope parsing.

`lib/realtime/degradation.ts` now drives the ladder from that stream and only reports level 1
once a frame has actually arrived — an open socket that has delivered nothing is not "live".

### Three defects that only execution could find

Each was invisible to parsing, typechecking and review. They are the argument for this section.

1. **A column-level `REVOKE` is a silent no-op under a table-level `GRANT`.**
   `REVOKE SELECT (totp_secret_enc) ON users FROM rms_app` removed nothing — 0036 grants
   `SELECT ON ALL TABLES` and column privileges in Postgres are *additive*. The TOTP secret was
   still readable after the migration meant to protect it. Fixed in `0037` by dropping the
   table grant and re-granting column by column.

2. **`ALTER DEFAULT PRIVILEGES` did not cover functions created by *later* migrations.**
   Four functions were still executable by `PUBLIC` after 0036's revoke, because each is created
   by a migration that runs after it — the original C-2 defect, one layer up. Fixed in `0044`
   with an **event trigger**: EXECUTE is revoked the moment any function is created, in the same
   transaction as the `CREATE`. A test creates a function *after* 0044 and asserts it was caught.

3. **The fix for (1), applied to `notifications`, broke `SELECT *` on the whole table.**
   Only the real-server RLS suite caught this: `fail-closed.test.ts` does `SELECT * FROM
   notifications` and got `permission denied` instead of zero rows. Fail-closed still held — a
   privilege error is more closed than zero rows — but it was a broad, surprising side effect on
   an ordinary table. Editing the invariant test to accept the new error would have been
   accommodating the change rather than fixing it, so `0047` moves the secret to a
   `notification_secrets` side table using the pattern already proven twice here: RLS enabled,
   **no policy**, SELECT revoked. `notifications` is a normal table again.

### What is still not proven

- **Nothing has been applied to your live Supabase project**, and that is the only item left.
  It is not a gap in the work; it is a deliberate stop. These migrations are irreversible in
  places — `DROP FUNCTION`, `DROP COLUMN secret_params_enc`, a data move, privilege revocations
  — and they run against real applicant PII. That needs an explicit go-ahead, not an inference.

  The rollout is now a prepared, one-command step rather than a leap. See below.
- **Nothing has been applied to your live Supabase project.** `DATABASE_URL` in `.env` points at
  production and the RLS suite drops the schema, so every run above used a throwaway database.
  Applying these 14 new migrations to production is a deliberate act, and it is yours to take.
- **H-9 remains a design decision, not a defect.** The Realtime path is disabled and falls
  through to honest polling, which removes the hazard. Turning live updates on for real needs a
  choice between Supabase Realtime Authorization and an authenticated SSE endpoint.

---

## 0b. Rollout — how to apply this to the live database

Nothing here has been run against your Supabase project. When you decide to, this is the order,
and the first two steps write nothing.

**1. Look before you leap.** `npm run db:preflight` is strictly read-only — no DDL, no DML, not
even a ledger row. Safe to run against production at any time, including during an event. It
reports which migrations would run, whether any *applied* migration has been edited since
(R-053, the thing that silently breaks a replay), and the security posture as it stands, so you
can see the "before" picture:

```bash
npm run db:preflight
```

On an unmigrated target the security lines come back as `[WARN]` — those are this audit's own
findings, and they are what applying the migrations fixes. Verified end to end on a throwaway
database: every `[WARN]` becomes `[ok]` afterwards.

**2. Take a backup.** Supabase dashboard → Database → Backups. Non-negotiable: migration 0047
drops a column after moving its contents, and 0051 rewrites existing rows.

**3. Apply.** `npm run db:migrate`. The ledger makes it resumable — a failure part-way leaves
the completed migrations recorded, and re-running continues from there.

**4. Re-run the preflight.** Every `[WARN]` should now read `[ok]`. That is the confirmation
the perimeter actually closed on *your* data, not on a test fixture.

**5. Re-deploy the frontend.** The application code and the schema are a matched pair — the
routes call functions whose signatures changed (`fn_enqueue_notification` gained a parameter and
its 6-argument form is dropped). Migrating without deploying breaks registration; deploying
without migrating breaks it the other way.

### One thing to decide before step 3

Migration **0051** redacts raw access tokens from notification bodies that already exist. It
cannot recover the original tokens — only their sha256 is stored, by design — so:

- Notifications already **sent** are redacted in place. Harmless: the applicant has the real
  link in their inbox.
- Notifications still **pending** are redacted *and marked `failed`*, because sending them after
  redaction would deliver a literal `{{statusUrl}}` and no way to reach the status page.

If you have pending confirmations you care about, note who they are first — they will need
re-enqueueing with freshly issued tokens, which rotates a live credential and is deliberately
left as an operator action rather than something a migration does silently.

Demonstrated on a seeded copy of the pre-fix state: 2 token-bearing bodies → 0, the sent one
redacted, the pending one failed with a reason, and one audit row recording the counts.

---

## 0. Executive summary

The **design** is unusually strong: the five invariants in `rules.md §2` are genuinely
implemented, and the §3 forbidden patterns are all clean — I specifically tried to break
`R-013` (`FOR UPDATE SKIP LOCKED` + `NOT EXISTS` — correct), `R-020` (no `MAX(seq)+1` — correct),
`R-021` (Ed25519, no HMAC anywhere in the QR path — correct), `R-023`/`R-024` (one scale
throughout, capacity-relative bands — correct), and `R-025`/`R-026` (deterministic ordering,
honest upward revisions — correct). Dependencies are clean (0 vulnerabilities).

The **deployment posture is not**. The gap is concentrated in three places, and each one is
independently sufficient for a full compromise:

1. **The database grants EXECUTE on every function to `PUBLIC`.** Every `SECURITY DEFINER`
   function — 75 of them, which by definition bypass RLS — is reachable from Supabase's
   PostgREST RPC endpoint using the anon key that ships in the client bundle.
2. **Two tables have no RLS at all**, one of which is `users` (holds `totp_secret_enc`).
3. **One API route and its page have no authentication whatsoever**, and it writes to the live
   event queue.

Additionally, **the repository does not currently build** (`npm run verify` fails at typecheck),
and **13 of 21 test files — every RLS, concurrency, and golden test — do not execute**, so the
invariants above are correct *by reading* but unverified *by running* in this environment.

| Severity | Count |
|---|---|
| Critical | 7 |
| High | 10 |
| Medium | 14 |
| Low / scalability | 9 |

---

## 1. CRITICAL

### C-1 — `/api/fast-track` is completely unauthenticated and writes to the live queue

**File:** [route.ts](frontend/app/api/fast-track/route.ts), [page.tsx](frontend/app/(staff)/fast-track/page.tsx)

Every other staff route begins with `requireStaff()` / `hasCapability()`. This one has neither.
It accepts a JSON body from anyone on the internet, calls `register()` **and** `checkIn()` inside
one transaction under `withContext({ clientIp })` — an empty security context — and returns the
new applicant's queue position.

The page is equally open. It runs `withContext({})` to look up the open cycle and the currently
active stage, then hands both IDs to an unauthenticated client form. So the attacker does not
even need to guess UUIDs; the app supplies them.

**Attack:**
```bash
curl -s https://<host>/fast-track | grep -o 'stageId[^,]*'   # IDs handed over
for i in $(seq 1 5000); do
  curl -sX POST https://<host>/api/fast-track \
    -H 'Content-Type: application/json' \
    -d "{\"cycleId\":\"$C\",\"stageId\":\"$S\",\"fullName\":\"Ghost $i\",\
         \"email\":\"g$i@x.com\",\"phone\":\"03001234567\"}"
done
```
**Impact:** anonymous mass-injection of fabricated applicants directly into the interview queue
during the event, consuming panel time and destroying queue integrity. It also **bypasses the
3-applications-per-hour rate limit**, because `middleware.ts` matches `/api/apply` by exact
string and `/api/fast-track` falls through to the generic 600/min staff bucket.

**Also:** the route sends `source: 'walk_in_digital'`, but `registrationChannels` in
[schemas.ts](backend/src/domain/schemas.ts) is `['online', 'walkin_digital', 'walkin_paper']`.
The underscore placement differs, so Zod rejects every request with a 400. **The endpoint is
currently broken, which is the only thing containing it.** Fixing the typo without adding auth
would open the hole for real.

**Fix:** `requireStaff()` + `hasCapability(staff, 'applicant.register')` + `checkin.perform`,
and route it through `withContext(staff.context, …)`. Add `/api/fast-track` to the `apply`
rate-limit rule.

---

### C-2 — Every `SECURITY DEFINER` function is executable by `PUBLIC` → total RLS bypass via PostgREST

**Files:** all 34 migrations; see [0010_app_role.sql](backend/supabase/migrations/0010_app_role.sql)

Postgres grants `EXECUTE` to `PUBLIC` on `CREATE FUNCTION` by default. I searched all 34
migrations: there is **not one `REVOKE EXECUTE … FROM PUBLIC`**. The `GRANT … TO rms_app` lines
scattered through the migrations are therefore redundant — `rms_app` already had it via `PUBLIC`,
and so does everyone else.

Supabase exposes the `public` schema over PostgREST to the `anon` and `authenticated` roles by
default, and no migration revokes that. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is, by design, in the
browser bundle. So an attacker with nothing but a page-view can call any of these directly,
**and `SECURITY DEFINER` means they execute as the owner with RLS bypassed**:

```bash
curl -s "$SUPABASE_URL/rest/v1/rpc/fn_export_selected" \
  -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"p_cycle_id":"<uuid from /display URL>"}'
```

| Function | No internal authz check | Consequence |
|---|---|---|
| `fn_export_selected` | ✗ none | Full name + final score of **every selected applicant**. Violates `R-028`, `R-029`, `NFR-PRIV`. |
| `fn_roster_bundle` | ✗ none | Every live token hash in the cycle — full applicant enumeration. |
| `fn_run_allocation` | ✗ none | Anyone can trigger allocation and write `decisions`. |
| `fn_issue_offer` | ✗ none | Issue an offer to any applicant for any department. |
| `fn_respond_to_offer` | ✗ none | See **C-4**. |
| `fn_override_decision` | authenticated only, **no capability** | Any signed-in volunteer can overturn any admission decision. |
| `fn_bulk_reconcile` | ✗ none | Mass check-in of arbitrary applicant IDs. |
| `fn_submit_evaluation` | panel membership only, **caller identity not verified** | Submit an evaluation *as* any panel member. |
| `fn_anonymise_old_data` | ✗ none | Destructive. See **H-2**. |
| `fn_record_totp_use` | ✗ none | Set any user's TOTP watermark to `9e18` → permanent MFA lockout. |
| `fn_claim_idempotency` | ✗ none | Pre-claim keys to poison offline replay. |

The cycle UUID needed for most of these is not a secret: it is in the public
`/display/[cycleId]` URL painted on a TV in the hall.

**Fix (do this first, it is one migration):**
```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rms_app;
```
Then add the missing capability checks per the table above. The `GRANT … TO rms_app` lines
already in the migrations become meaningful rather than decorative.

---

### C-3 — `users` has no RLS: staff directory and TOTP secrets are readable

**File:** [0003_core_tables.sql](backend/supabase/migrations/0003_core_tables.sql)

Five tables never get `ENABLE ROW LEVEL SECURITY`: `users`, `societies`, `role_capabilities`,
`application_transitions`, `idempotency_keys`. Every other table does.

`users` holds `email`, `full_name`, `auth_user_id`, `totp_enabled`, and **`totp_secret_enc`**.
With no RLS and PostgREST exposure (C-2):

```bash
curl "$SUPABASE_URL/rest/v1/users?select=*" -H "apikey: $ANON_KEY"
```

returns the complete staff roster. `totp_secret_enc` is AES-256-GCM at the application layer, so
it is not immediately usable — but it is offline attack material, and combined with `C-2`'s
`fn_record_totp_use` it makes the MFA design moot. The email list alone is a targeted-phishing
kit against exactly the accounts that hold `results.lock`.

`idempotency_keys` is worse than it looks — see **C-5**.

**Note:** `rules.md R-010` exempts `societies` and `users` from *cycle scoping*. It does not
exempt them from RLS. `role_capabilities` and `application_transitions` additionally lack
`cycle_id`, which is a literal `R-010` deviation (defensible as config tables, but undocumented).

**Fix:** enable RLS on all five. `users` needs `USING (id = fn_current_user_id() OR
fn_has_capability(<cycle>, 'users.manage'))`. Move `totp_secret_enc` to a separate table that no
role can `SELECT` — only the `SECURITY DEFINER` verify function should read it.

---

### C-4 — `fn_respond_to_offer` has no ownership check (IDOR on admission offers)

**File:** [0031_lock_offers_cascade.sql:~420](backend/supabase/migrations/0031_lock_offers_cascade.sql)

```sql
CREATE OR REPLACE FUNCTION fn_respond_to_offer(p_offer_id uuid, p_accept boolean)
...
  SELECT * INTO v_offer FROM offers WHERE id = p_offer_id FOR UPDATE;
```

It validates that the offer exists, is `pending`, and is not expired. It **never checks that the
caller is the applicant the offer belongs to** — no `fn_current_applicant_id()`, no
`fn_current_user_id()`, no capability. Combined with C-2 it is callable anonymously.

**Attack:** `POST /rest/v1/rpc/fn_respond_to_offer {"p_offer_id":"…","p_accept":false}` declines
someone else's place. The function then calls `fn_cascade_department()`, which **immediately
reassigns the seat to the next person on the waitlist**. The victim's applicant state is set to
`declined`. Because results are locked by that point, `fn_override_decision` refuses to fix it
("results are locked — use the correction path"). The damage is durable and looks, in the audit
log, like the applicant did it themselves.

`offers.id` is a UUIDv4 so it is not guessable — but the `offers` table has
`offer_self_select` RLS and any staff member with `evaluation.view_all` or the privileged offer
policy can read every offer ID, and C-2 exposes several functions that return them.

**Fix:** require `v_offer.applicant_id = fn_current_applicant_id()`, or a capability for the
staff-acting-on-behalf path, and audit which of the two it was.

---

### C-5 — Raw access tokens are persisted in the database and readable by any volunteer

**Files:** [notifications.ts:56,67](backend/src/services/notifications.ts),
[0014_notification_enqueue.sql](backend/supabase/migrations/0014_notification_enqueue.sql)

`rules.md R-022` is unambiguous: *"Never persist a raw token. Store `sha256(token)` only — not in
the database, not in logs, not in backups."* Its stated reason: *"a database leak must yield no
working QR codes and no working status links."*

`/api/apply` builds `statusUrl = buildQrPayload(baseUrl, registered.token.raw)` — a URL whose
last path segment **is the raw token** — and passes it into `enqueue()`. The template renders it
into `text` and `html`, and `fn_enqueue_notification` writes both into
`notifications.body_text` / `body_html`, permanently.

The route comment says *"The raw token appears in statusUrl here, in this response, once. It is
never persisted"*. That is not what the code does.

**Impact:**
- Every applicant's working QR credential sits in plaintext in the DB, in every backup, forever.
- `notification_staff_select` grants read to anyone holding `applicant.view` — i.e. **every
  volunteer**. A volunteer can extract any applicant's token and check them in, view their
  status page, or use the one-time grace extension as them.
- Retention: `fn_anonymise_old_data` scrubs `applicants` and `audit_events` but **never touches
  `notifications`**, so tokens survive the anonymisation job too.

**Fix:** store a template variable reference, not the rendered URL — render the link at send time
from a token the mailer holds transiently, or accept an emailed magic-link that is itself
single-use and separately hashed. At minimum, exclude `body_html`/`body_text` from
`notification_staff_select` and add `notifications` to the anonymisation job.

---

### C-6 — Idempotency is half-migrated: the build is broken and neither implementation works

**Files:** [db.ts:138-156](backend/src/services/db.ts),
[idempotency.ts](backend/src/services/idempotency.ts), uncommitted `index.ts` diff

`git status` shows an in-flight migration to durable idempotency: a new
`backend/src/services/idempotency.ts`, a new `0034_durable_idempotency.sql`, a new
`offline-replay.test.ts` — and an uncommitted `index.ts` change that swaps the export:

```diff
-export { …, withIdempotency } from './services/db'
+export * from './services/idempotency'
```

**The route handlers were never updated.** They still call the 2-argument form. Result:

```
app/api/apply/route.ts(45,26):    error TS2554: Expected 3 arguments, but got 2.
app/api/checkins/route.ts(75,26): error TS2554: Expected 3 arguments, but got 2.
app/api/checkins/route.ts(110,55): error TS2339: Property 'outcome' does not exist on
                                    type 'IdempotentResult<unknown>'.
backend/tests/concurrency/offline-replay.test.ts(138,14): error TS2339
```

`npm run verify` fails at the first step. **The frontend will not build and cannot deploy.**

The old in-memory implementation it replaces was itself unsound, and is worth recording because
reverting to it is not an option:

- A `Map` in serverless memory. Vercel gives each instance its own; a device replaying 200
  offline check-ins spreads them across instances that each see an empty map. **`FR-CHK-014`'s
  "zero duplicate records" cannot hold.**
- **It never hashes the request.** `R-051` requires *same key + different hash → 409*. This
  returns the stored response for a completely different body — silently discarding the second
  operation.
- **The cache is global across all users and unauthenticated.** For `/api/apply` the cached value
  is `{ displayId, statusUrl }` — and `statusUrl` contains a raw token (C-5). An attacker who
  submits `Idempotency-Key: 1` (or any low-entropy value another client might pick) **receives
  that applicant's token in the response body.**

`services/idempotency.ts` + `0034` are a correct design — durable, request-hashed, in-flight
aware, with a 24-hour expiry. They just need to be finished and wired.

**Fix:** update both route handlers to the 3-argument call inside `withContext`, apply `0034`,
delete the `Map`, fix the test's `count` typing, and re-run `npm run verify` to green.

---

### C-7 — No CSRF protection on cookie-authenticated mutating routes

**Files:** [session.ts](frontend/lib/auth/session.ts), all `POST` handlers

Staff auth is Supabase SSR **cookies** (`createServerClient` + `cookies()`). Every mutating route
is a `POST` that reads `req.json()` and authenticates purely from that ambient cookie. There is
no CSRF token, no `Origin`/`Referer` check, and no custom-header requirement enforced server-side.

Supabase's auth cookies default to `SameSite=Lax`, which blocks cross-site *form* POSTs — so this
is mitigated rather than open, and it is why I have rated it Critical-boundary rather than
trivially exploitable. But `Lax` is a browser default the app does not assert, it does not cover
same-site subdomain attackers, and the whole staff surface (`call-next`, `skip`, `start`,
`checkins`, `evaluations`) is state-changing during a live event where a volunteer clicking a
link on a phone is entirely normal.

**Fix:** assert `Origin` against an allowlist in `middleware.ts` for all non-GET `/api/*`
requests, and return `403` on mismatch. Cheap, central, and does not depend on cookie defaults.

---

## 2. HIGH

### H-1 — `audit_insert ON audit_events FOR INSERT WITH CHECK (true)` — audit forgery

**File:** [0008_rls.sql:268](backend/supabase/migrations/0008_rls.sql)

`R-011` makes the audit log append-only because *"its only value is that it cannot be edited and
cannot be missing."* It can, however, be **fabricated**: any context — including an applicant
token session, and via C-2 an anonymous caller — can insert arbitrary `audit_events` rows with
any `actor_id`, `action`, `entity_id`, `before` and `after`.

In a disputed result, the log is the evidence. An attacker can flood it with plausible rows
attributing decisions to a real coordinator, and because `UPDATE`/`DELETE` are correctly revoked,
**the forged rows cannot be removed.** The immutability that makes the log trustworthy is what
makes the poisoning permanent.

**Fix:** `WITH CHECK (actor_id IS NOT DISTINCT FROM fn_current_user_id())`, and preferably revoke
direct `INSERT` from `rms_app` entirely so `fn_audit` (which is `SECURITY DEFINER`) is the only
write path — mirroring the pattern already used correctly for `notifications`.

### H-2 — `fn_anonymise_old_data` mutates `audit_events`, writes no audit row, and is unauthenticated

**File:** [0032_consistency_and_anonymisation.sql](backend/supabase/migrations/0032_consistency_and_anonymisation.sql)

```sql
UPDATE audit_events SET before = '{}'::jsonb, after = '{}'::jsonb
 WHERE cycle_id = v_c AND entity_type = 'applicant' AND …
```

Three distinct violations in one function:
1. **It `UPDATE`s `audit_events`.** `R-011` revokes `UPDATE` at the role level — but this is
   `SECURITY DEFINER`, so it runs as owner and the revoke does not apply. The append-only
   invariant is bypassed by the one function that most needed to respect it.
2. **It writes no `fn_audit` row.** A destructive, irreversible PII operation leaves no trace
   that it ran, on whose authority, or over which cycles.
3. **No capability check, and `PUBLIC` can execute it** (C-2). Its only guard is
   `archived_at < now() - interval '2 years'`, which is data an admin can change.

It also misses `notifications` (C-5), so it does not actually complete the retention promise.

**Fix:** add `fn_has_capability(…, 'cycle.archive')`, emit an audit row per cycle processed,
scrub `notifications`, and replace the `audit_events` `UPDATE` with a forward-only redaction
record.

### H-3 — Offline sync treats HTTP 409 as success and deletes the operation (silent data loss)

**File:** [sync.ts:35-40](frontend/lib/offline/sync.ts)

```js
if (res.ok || res.status === 409) {
  // 409 means Idempotency_Key_Reused, which we treat as success for replay purposes
  await removePendingOperation(op.id)
```

The comment inverts the meaning. `IDEMPOTENCY_KEY_REUSED` is returned when the key is the same
but **the request hash differs** — meaning the server did *not* perform this operation.
`idempotency.ts` says so explicitly: *"Refusing is deliberate: quietly treating this as a replay
would DISCARD an operation the caller believes succeeded."* The client then discards it.

409 is also returned by `/api/interviews/:id/evaluations` for genuine domain conflicts, and
`RmsError('RATE_LIMITED', 'That request is already being processed')` fires on `in_flight`.
All three are dropped on the floor.

**Impact:** a check-in performed offline vanishes with no error surfaced to anyone. The applicant
is in the hall believing they are checked in; the system has no record.

**Fix:** only `res.ok` and an explicit `replayed: true` response should remove the operation.
A 409 must move the op to `failed` **and** surface it in the ops console for a human.

### H-4 — Operations stranded in `'syncing'` are never retried

**File:** [sync.ts:20-22](frontend/lib/offline/sync.ts)

`syncPendingOperations` marks each op `'syncing'` *before* the `fetch`, and the next run filters
`op.status !== 'syncing'`. If the tab is closed, the phone sleeps, or the browser kills the page
between those two points — routine on a volunteer's phone in a noisy hall — the operation is
**permanently excluded from every future sync pass.** The `catch` resets to `'pending'` only for
in-process failures, not for process death.

There is also no lock: the `online` event can fire repeatedly, and two open tabs will replay
concurrently. With C-6's per-instance `Map`, that produces duplicates.

**Fix:** persist a `syncingSince` timestamp and reclaim anything older than ~60s; take a
`navigator.locks` mutex around the whole pass.

### H-5 — Missing capability checks on four staff API routes

| Route | Has | Missing |
|---|---|---|
| [`POST /api/queue/:entryId/skip`](frontend/app/api/queue/[entryId]/skip/route.ts) | `requireStaff` | `queue.skip` — **any** staff member can skip anyone |
| [`POST /api/queue/:entryId/start`](frontend/app/api/queue/[entryId]/start/route.ts) | `requireStaff` | `interview.start` |
| [`GET /api/panels/:id/snapshot`](frontend/app/api/panels/[id]/snapshot/route.ts) | `requireStaff` | any — no panel-membership check |
| [`GET /api/stages/:stageId/parked`](frontend/app/api/stages/[stageId]/parked/route.ts) | `requireStaff` | any |

RLS is the real boundary and largely holds, but `R-032` requires enforcement *at the API layer
too*, and these produce confusing empty results instead of an explained 403 (`R-058`).

`/api/stages/:stageId/parked` additionally returns `{ error: 'Unauthorized' }` and
`{ error: 'Failed to fetch' }` — plain strings, not the `{ code, message, detail, retryable }`
shape `R-057`/`IR-002` mandates. And `stageId` is interpolated as `${stageId}::uuid` with no
validation, so a non-UUID yields an unhandled `22P02` and a 500.

### H-6 — No staff sign-in route exists; MFA is implemented but never wired

Every staff page does `redirect('/staff/sign-in')`. `find app -ipath "*sign*"` returns **nothing**.
The route does not exist — unauthenticated staff are redirected to a 404.

Separately, `domain/totp.ts` implements TOTP correctly (constant-time compare, replay watermark,
`requiresMfa`) and is unit-tested — but `grep -rn "requiresMfa|verifyTotp|totp" frontend/` returns
**zero matches**. No route, page, or middleware ever calls it. `NFR-SEC-001`'s MFA requirement for
privileged roles is unmet in practice, and `fn_record_totp_use` is only reachable by an attacker
(C-2), never by the app.

### H-7 — No `FORCE ROW LEVEL SECURITY` on any table, contradicting the migration that claims it

[0010_app_role.sql](backend/supabase/migrations/0010_app_role.sql) opens with: *"Migration 0008
enables and FORCEs row-level security."* I checked all 34 migrations: **`FORCE ROW LEVEL
SECURITY` appears zero times.** Only `ENABLE` is used.

The practical boundary still holds for the app path, because `withContext` does `SET LOCAL ROLE
rms_app` and `rms_app` is `NOBYPASSRLS` — that part is genuinely well built. But the table
**owner** is exempt from its own policies without `FORCE`, so migrations, seeds, `scripts/*.mjs`,
and any tooling connecting as the owner silently see everything. More dangerous is that the
comment asserts a property the schema does not have, so a future reviewer will trust it.

### H-8 — `idempotency_keys` has no RLS and is designed to store response bodies

`fn_complete_idempotent` stores the full JSON response in `idempotency_keys.response_body`. For
`/api/apply` that response is `{ displayId, statusUrl }` — containing a raw token (C-5). The table
has **no RLS** (C-3) and, via PostgREST, `GET /rest/v1/idempotency_keys?select=*` dumps the last
24 hours of every applicant's token.

This is currently latent because the durable path is not wired (C-6). **Fixing C-6 activates this
hole**, so the two must be fixed together.

### H-9 — Realtime channels have no authorization; the cycle ID is public

**File:** [channels.ts](frontend/lib/realtime/channels.ts), [degradation.ts:40,69](frontend/lib/realtime/degradation.ts)

The channel comments assert *"Filter: RLS, staff roles"* and *"Filter: RLS, panel membership"*.
Supabase **Broadcast** channels have no RLS — any client with the anon key can subscribe to any
topic string it knows. `degradation.ts` calls `supabase.channel(channelName)` with the browser
anon client and no authorization step.

The cycle UUID is printed in the public `/display/[cycleId]` URL, so `cycle:{id}:queue` and
`cycle:{id}:ops` are directly derivable. `R-028` is satisfied only for the display channel, and
only because `fn_display_board` genuinely excludes names at the publisher — that part is correct.
The ops and queue channels are not so constrained.

`applicant:{token_hash}` uses the token hash as the topic name, which is unguessable but means the
hash travels in websocket frames and appears in any proxy or browser-devtools log.

**Fix:** use Realtime Authorization (`realtime.messages` RLS policies, Supabase ≥ 2024-10), or
move staff live updates behind an authenticated SSE endpoint.

### H-10 — Every database-backed test is skipped; the invariants are unverified

```
Test Files  13 failed | 8 passed (21)
     Tests  148 passed | 157 skipped (305)
```

All 13 failures are `Refusing to drop the schema … set RMS_ALLOW_DESTRUCTIVE_TESTS=1`. That guard
is a *good* safety feature — but the consequence is that **`tests/rls/*` (fail-closed, capability
integrity, state ownership), `tests/concurrency/*` (20-actor claim, registration, offline replay),
and `tests/golden/*` (allocation determinism, scoring, lock-and-offers) never ran.**

Per `R-055`, the five invariants are currently *asserted by code reading*, not *demonstrated*. CI
([verify.yml](.github/workflows/verify.yml)) should provision a disposable Postgres and set the
flag, otherwise the suite that protects the whole design is decorative.

---

## 3. MEDIUM

**M-1 — No Content-Security-Policy anywhere.**
[next.config.ts](frontend/next.config.ts) says *"CSP is deliberately absent here and set
per-response in middleware once Supabase Realtime origins are known."*
[middleware.ts](frontend/middleware.ts) sets `X-Content-Type-Options`, `X-Frame-Options`, and
`Referrer-Policy` — **and no CSP.** `NFR-SEC-008` is unmet. The one `dangerouslySetInnerHTML` in
[layout.tsx:29](frontend/app/layout.tsx) is a static theme script (safe), and I found no other
`innerHTML`/`eval` — but CSP is the defence-in-depth for the injection you did not find.

**M-2 — Middleware matcher misses most of the app.**
`matcher: ['/api/:path*', '/q/:path*']`. So `/display/*`, `/fast-track`, `/apply`, and every
staff page get **no rate limiting**. (Security headers survive via `next.config.ts` `headers()`,
which does cover `/:path*`.)

**M-3 — `x-real-ip` is trusted unconditionally.**
`clientIp()` returns `x-real-ip` if present, before ever looking at `x-forwarded-for`. The
`x-forwarded-for` handling is *correct and well-reasoned* (takes the last element, which a client
cannot forge) — but any request path that reaches the app without a proxy overwriting `x-real-ip`
lets an attacker rotate identity per request and defeat every limit.

**M-4 — XFF parsing is inconsistent between layers.**
`middleware.ts` takes `.pop()` (last, trusted). `apply/route.ts` and `fast-track/route.ts` take
`.split(',')[0]` (**first, attacker-controlled**) and write it to `app.client_ip`, which lands in
`audit_events.client_ip`. Audit rows therefore record an IP the attacker chose.

**M-5 — Account linking by unverified email.**
[session.ts:92](frontend/lib/auth/session.ts):
`WHERE (u.auth_user_id = ${user.id}::uuid OR u.email = ${email})`. If Supabase Auth is configured
without mandatory email confirmation (or if any provider returns an unverified email), an attacker
who signs up as `coordinator@…` inherits that user's memberships and capabilities. The `auth_user_id`
branch is the safe one; the `email` fallback is the escalation path.

**M-6 — Cycle selection is arbitrary and not user-selectable.**
`ORDER BY c.year DESC, c.season` then `rows[0]`. `season` is text, so `'FA' < 'SP' < 'SU'`
alphabetically — not chronologically. A user with memberships in two live cycles is silently bound
to whichever sorts first, with no way to switch.

**M-7 — `fn_current_user_id` trusts an unvalidated JWT claim first.**
It reads `request.jwt.claims ->> 'user_id'` **before** falling back to `app.user_id`. No standard
Supabase JWT carries `user_id`, so this is currently inert — but if a custom Auth Hook or JWT
template is ever added that flattens `user_metadata` (which users *can* self-edit via
`auth.updateUser`), this becomes direct impersonation. The comment in `fn_has_capability`
documents exactly this class of mistake being removed elsewhere; the same reasoning applies here.

**M-8 — `fn_submit_evaluation` ignores `panel_members.left_at`.**
`fn_claim_next` correctly requires `pm.left_at IS NULL`. `fn_submit_evaluation` does not — a
removed panel member can still submit an evaluation. It also performs **no recusal check**, so an
interviewer who recused themselves (and was therefore excluded from the claim) can still score
that applicant if handed the interview ID.

**M-9 — Hard-bounce suppression is not cycle-scoped.**
`fn_enqueue_notification` raises `SUPPRESSED_HARD_BOUNCE` on
`WHERE to_email = v_email AND state = 'bounced'` with no `cycle_id` filter. One hard bounce in a
2024 cycle permanently blocks that address in 2026 — and since registration is open, an attacker
can pre-poison an address they expect a rival to use.

**M-10 — `/display/[cycleId]` is an unauthenticated, uncacheable DoS amplifier.**
`force-dynamic` + `revalidate = 0`, two `SECURITY DEFINER` calls per render, `AutoRefresh` every
10 s, **not covered by the rate-limit matcher** (M-2), and `cycleId` is unvalidated before
`::uuid` casting. Each anonymous request costs two DB round-trips against a pool of `max: 10`.

**M-11 — Cycle-wide PII cached indefinitely on personal phones.**
[indexeddb.ts](frontend/lib/offline/indexeddb.ts) stores `fullName`, `displayId`, and `tokenHash`
for **every applicant** in the cycle. `FR-CHK-018` permits this, and the design correctly stores
*only* the public key alongside it. But there is **no TTL, no wipe on stage close, and no wipe on
sign-out** — a volunteer's personal phone retains the full applicant roster forever after the
event.

**M-12 — `navigator.onLine` is the sole connectivity signal.**
[useOfflineSync.ts](frontend/lib/offline/useOfflineSync.ts) drives all offline behaviour from
`navigator.onLine`, which reports `true` on a captive portal with no internet — precisely the
"unreliable campus WiFi" case `CLAUDE.md` names as the design driver. Sync will report success
while every request 302s to a portal page.

**M-13 — `/api/applicants/search` ignores its own schema.**
The route hand-rolls `q.length < 2` and never uses `applicantSearchSchema` (which caps `q` at 120
and `limit` at 50). An unbounded `q` reaches the trigram/ILIKE search.

**M-14 — Inconsistent token parsing between the page and the API.**
`/api/q/[token]/status` uses `parseQrPayload` (validates the strict 22-char base64url shape).
`/q/[token]/page.tsx` uses `rawToken.split('.')[0]` with no format check, sending arbitrary
attacker-controlled strings to `hashToken`. Harmless today (it hashes to a non-matching value)
but the two paths should not disagree about what a token is.

---

## 4. LOW / SCALABILITY

**S-1 — Connection pool `max: 10`.** ([db.ts:39](backend/src/services/db.ts)) At the stated scale
— 20 panels polling snapshots, 30 interviewers, ~200 applicants polling `/api/q/:token/status`
every 5 s, plus the display board every 10 s — 10 connections with a 15 s `statement_timeout` is
the binding constraint. Every request also opens an explicit transaction (`sql.begin`) and issues
**7 statements before doing any work** (`SET LOCAL ROLE` + 6 `set_config`). That is ~8× round-trip
amplification on the hottest path. Batch them into one `SELECT set_config(…), set_config(…), …`.

**S-2 — `fn_applicant_status` recomputes queue position with a `COUNT(*)` per poll.** With 200
applicants polling every 5 s that is 40 sequential-ish counts/second over `queue_entries`. Needs a
covering index on `(track_id, state, priority DESC, enqueued_at)` at minimum.

**S-3 — `getOfflineRosterHashes()` calls `getAll()` on every scan** and rebuilds a `Set` of 1,000
entries per QR code. `searchOfflineRoster()` does the same per keystroke. At a check-in desk this
is the 15-seconds-at-the-desk budget (`principle 7`) spent on garbage collection.

**S-4 — The in-memory rate limiter is per-instance.** Honestly documented in the file's own header
and already tracked for Phase 5 — recording it here only for completeness. Under Vercel autoscale
the effective limit is *N* × configured.

**S-5 — `withIdempotency`'s `Map` eviction is FIFO by insertion, not by age or LRU.** Moot once C-6
is fixed.

**S-6 — Raw tokens travel in URL paths** (`/q/<token>`). They land in Vercel access logs, browser
history, and any intermediary. `Referrer-Policy: strict-origin-when-cross-origin` correctly
prevents leaking them via `Referer`, which is the important half. Consider a fragment or a
short-lived exchange for the long-lived form.

**S-7 — `/dev/notifications` reads with `withContext({})`.** Fail-closed RLS correctly returns zero
rows, so the preview page shows nothing even in development. The production guard
(`NODE_ENV === 'production'`) is right; the page just does not work.

**S-8 — `fn_bulk_reconcile` catches `raise_exception` per applicant inside a loop.** Correct for
"one failure must not abort the rest", but with a large `p_applicant_ids[]` and no length cap it
is an unbounded loop of `fn_check_in` calls in one transaction, holding locks for its duration.

**S-9 — `jobs/consistency.ts` and `jobs/anonymisation.ts` use `SUPABASE_SERVICE_ROLE_KEY`.**
Appropriate for a cron job, but they are exported functions in `backend/src/` with nothing
preventing a route handler from importing them — which would put a `BYPASSRLS` credential in the
request path, defeating [0010](backend/supabase/migrations/0010_app_role.sql) entirely. Move them
behind a separate entry point that `frontend/` cannot resolve, mirroring the `browser.ts` pattern.

---

## 5. What I tried to break and could not

Recorded so the next audit does not re-plough this ground:

| Attack | Result |
|---|---|
| Duplicate applicant IDs from concurrent desks (`R-020`) | **Held.** In-transaction `UPDATE cycles SET applicant_seq = applicant_seq + 1 … RETURNING`. No `MAX()+1` anywhere. |
| Double-assignment in the queue claim (`R-013`) | **Held.** `FOR UPDATE SKIP LOCKED` + `NOT EXISTS` for recusals. No `NOT IN` against a nullable subquery anywhere in 34 migrations. |
| Forging a QR by extracting a device secret (`R-021`, E1) | **Held.** Ed25519 throughout; only the public key reaches IndexedDB; `signToken` zeroes the seed buffer. No HMAC in the QR path. |
| Mixing raw and adjusted scores (`R-023`) | **Held.** `adjusted = raw − w × bias` stays on the same 0–100 scale; `applicantFinalScore` averages adjusted only. |
| Absolute score thresholds for review bands (`R-024`) | **Held.** Capacity-relative: `≤ 0.75C` / `≤ 2C`. |
| Non-deterministic allocation re-runs (`R-025`) | **Held by reading.** Full 5-level tiebreak + advisory lock + `ON COMMIT DROP` temp snapshot. *Unverified by execution — see H-10.* |
| Suppressing an upward wait revision (`R-026`) | **Held.** Increases are emitted with a typed `cause` (`panels` / `service_time`); no clamping. |
| Names or scores on the display channel (`R-028`) | **Held.** `fn_display_board` returns `display_id`, `room_name`, `called_at` only — excluded at the publisher, not the client. |
| Client-supplied evaluation score | **Held.** The route accepts criterion scores only; `fn_submit_evaluation` computes the weighted total and the route deliberately does not return it. |
| Open mail relay via the public form | **Held.** `fn_enqueue_notification` derives the recipient from the applicant row; the caller cannot supply an address. |
| SQL injection | **Held.** `postgres.js` tagged templates throughout; every `SECURITY DEFINER` function pins `SET search_path = public`. No string-concatenated SQL found. |
| Dual-control bypass (one admin locks *and* confirms) | **Held.** `fn_confirm_lock` explicitly rejects `v_cycle.locked_by = v_actor`. |
| Session-level `SET` leaking across pooled connections (E9, `R-014`) | **Held.** `set_config(…, true)` transaction-local only; `withoutContext` is named so its misuse is visible in review. |
| Malformed security context causing a 500 instead of a denial | **Held.** 0012 wraps every cast; malformed is indistinguishable from absent. |
| Dependency supply chain | **Clean.** `npm audit --omit=dev` → 0 vulnerabilities. |

---

## 6. Recommended order of work

**Before anything else deploys** — these three are each independently exploitable by an anonymous
user holding only the public anon key:

1. **C-2** — one migration: revoke `EXECUTE` from `PUBLIC`/`anon`/`authenticated`, revoke schema
   `USAGE`, then add the missing capability checks.
2. **C-3** — enable RLS on the five uncovered tables; isolate `totp_secret_enc`.
3. **C-1** — authenticate `/api/fast-track` and its page.

**Before the event:**

4. **C-6** — finish the idempotency migration so the repo builds; then **H-8** immediately after.
5. **C-4**, **C-5**, **H-1**, **H-2** — the integrity set: IDOR on offers, token persistence,
   audit forgery, unauthenticated destruction.
6. **H-3**, **H-4** — the offline path silently loses check-ins today. This is the finding most
   likely to actually hurt on the day.
7. **H-6** — there is no way for staff to sign in. Everything above assumes an auth surface that
   does not yet exist.
8. **H-10** — get the DB suite running in CI. Nothing in §5 is *demonstrated* until it does.

**Then:** C-7, H-5, H-7, H-9, and the M-series.

---

### Note on `R-054`

Nothing in this report changes a locked decision or resolves an open issue. Two findings touch
committee territory and are flagged rather than assumed: **C-5**'s fix affects how status links
are delivered (adjacent to **OI-6**, individual notices), and **M-11**'s roster-wipe policy is a
data-retention question adjacent to **OI-11** (data residency) and **OI-12** (retention approval).
Both are decisions for the committee, not implementation details.
