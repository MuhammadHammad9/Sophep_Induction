/**
 * The security perimeter, asserted against a real PostgreSQL engine with NO infrastructure.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM tests/rls/.
 *
 * The `tests/rls/` suite needs a live Postgres and drops the schema, so it is guarded behind
 * `RMS_ALLOW_DESTRUCTIVE_TESTS`. That guard is correct — `DATABASE_URL` on a developer machine
 * points at a real Supabase project. But the consequence was that 157 tests never ran anywhere,
 * including CI, and the five invariants were verified by reading rather than by executing.
 *
 * That is exactly how the 2026-08-12 audit's worst finding survived review: `CREATE FUNCTION`
 * grants EXECUTE to PUBLIC by default, nothing revoked it, and nothing FAILED. A defect whose
 * only symptom is "everything works, for everybody" cannot be caught by reading the diff that
 * introduced it, because that diff is empty.
 *
 * PGlite is PostgreSQL 18 compiled to WebAssembly. It runs in-process, needs no server, no
 * Docker and no connection string, and it applies these migrations with the real grammar, the
 * real privilege system, real RLS and real PL/pgSQL. So the perimeter is now provable on any
 * machine that can run `npm test`, which is the only way an invariant stays true.
 *
 * WHAT THIS FILE CANNOT DO. PGlite is single-user: there is no separate superuser to prove that
 * `rms_app` cannot escalate, and no connection pooler to reproduce errata E9. Concurrency
 * (FR-QUE-002's twenty simultaneous claims) is meaningless single-threaded. Those belong to
 * `tests/rls/` and `tests/concurrency/` against a real server, and this file does not replace
 * them — it makes the privilege and policy surface testable everywhere, all the time.
 *
 * Two of these assertions found genuine defects in the migrations that introduced them:
 *   - a column-level REVOKE is a silent no-op under a table-level GRANT (0037, 0042)
 *   - `ALTER DEFAULT PRIVILEGES` did not cover functions created by LATER migrations (0044)
 * Neither is visible without executing. Both are now regression-guarded below.
 *
 * Refs: audit C-2, C-3, C-5, H-1, H-7, H-10, M-7, rules.md R-011, R-014, R-022, R-032
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { citext } from '@electric-sql/pglite/contrib/citext'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations')

let db: PGlite
let cycleId: string
const userIds: Record<string, string> = {}

/** Bind a security context exactly as `withContext` does, then run one statement. */
async function asRole<T = Record<string, unknown>>(
  userId: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec('BEGIN')
  try {
    await db.exec('SET LOCAL ROLE rms_app')
    await db.query("SELECT set_config('app.user_id',$1,true)", [userId ?? ''])
    const r = await db.query<T>(sql, params)
    await db.exec('COMMIT')
    return r.rows
  } catch (e) {
    await db.exec('ROLLBACK')
    throw e
  }
}

beforeAll(async () => {
  db = await PGlite.create({ extensions: { citext, pg_trgm, pgcrypto } })

  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
    } catch (e) {
      throw new Error(`migration ${f} failed to apply: ${(e as Error).message}`)
    }
  }

  await db.exec(`
    INSERT INTO societies (code,name) VALUES ('SPH','SOPHEP');
    INSERT INTO cycles (society_id,season,year,name,state)
      SELECT id,'SP',2026,'Spring 2026','registration_open' FROM societies;
  `)
  cycleId = (await db.query<{ id: string }>('SELECT id FROM cycles LIMIT 1')).rows[0]!.id

  for (const role of ['super_admin', 'coordinator', 'admin', 'volunteer', 'interviewer']) {
    await db.query('INSERT INTO users (email,full_name) VALUES ($1,$2)', [`${role}@t.test`, role])
    await db.query(
      `INSERT INTO memberships (cycle_id,user_id,role)
       SELECT $1::uuid, id, $2::role_name FROM users WHERE email=$3`,
      [cycleId, role, `${role}@t.test`],
    )
    userIds[role] = (
      await db.query<{ id: string }>('SELECT id FROM users WHERE email=$1', [`${role}@t.test`])
    ).rows[0]!.id
  }
}, 180_000)

describe('every migration applies', () => {
  it('reaches the end of the migration set', async () => {
    // Vacuous-looking and not: `beforeAll` throws with the failing filename, so this is the
    // assertion that the whole set is applicable at all. Parsing SQL proves the grammar;
    // only applying it compiles the PL/pgSQL inside every $$…$$ body.
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public'",
    )
    expect(r.rows[0]!.n).toBeGreaterThan(70)
  })
})

describe('C-2 — the privilege perimeter', () => {
  it('grants EXECUTE on no public-schema function to PUBLIC', async () => {
    // Written as a PROPERTY, not a list of names: it keeps holding when migration 0050 adds a
    // function, whereas an enumeration silently stops covering the new one.
    const r = await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1`,
    )
    expect(r.rows.map((x) => x.proname)).toEqual([])
  })

  it('still lets rms_app execute', async () => {
    const r = await db.query<{ ok: boolean }>(
      "SELECT has_function_privilege('rms_app','fn_current_user_id()','EXECUTE') ok",
    )
    expect(r.rows[0]!.ok).toBe(true)
  })

  it('pins search_path on every SECURITY DEFINER function', async () => {
    const r = await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef AND NOT EXISTS (
          SELECT 1 FROM unnest(coalesce(p.proconfig,ARRAY[]::text[])) c WHERE c LIKE 'search_path=%')`,
    )
    expect(r.rows.map((x) => x.proname)).toEqual([])
  })

  it('covers functions created by migrations AFTER the revoke (0044 regression)', async () => {
    // The defect this guards: migration 0036 revoked EXECUTE from PUBLIC and added
    // ALTER DEFAULT PRIVILEGES to keep it revoked. Four functions created in 0037–0042 were
    // executable by PUBLIC anyway. Nothing failed; they simply worked, for everyone.
    for (const fn of [
      'fn_resolve_staff_session',
      'fn_require_capability',
      'fn_anonymise_old_data',
      'fn_enqueue_notification',
    ]) {
      const r = await db.query<{ leaked: boolean | null }>(
        `SELECT bool_or(has_function_privilege('public', p.oid,'EXECUTE')) leaked
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`,
        [fn],
      )
      expect(r.rows[0]!.leaked, `${fn} is executable by PUBLIC`).toBeFalsy()
    }
  })

  it('auto-revokes a function created after 0044 via the event trigger', async () => {
    // The invariant is now structural: a future migration cannot reopen the hole by forgetting
    // a REVOKE, because there is no REVOKE left to forget.
    await db.exec(
      'CREATE FUNCTION fn_canary_after_0044() RETURNS int LANGUAGE sql AS $x$ SELECT 1 $x$;',
    )
    const pub = await db.query<{ leaked: boolean }>(
      "SELECT has_function_privilege('public','fn_canary_after_0044()','EXECUTE') leaked",
    )
    expect(pub.rows[0]!.leaked).toBe(false)

    const app = await db.query<{ ok: boolean }>(
      "SELECT has_function_privilege('rms_app','fn_canary_after_0044()','EXECUTE') ok",
    )
    expect(app.rows[0]!.ok).toBe(true)
  })
})

describe('C-3 / H-7 — RLS coverage', () => {
  it('enables row-level security on every table', async () => {
    const r = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity
          -- schema_migrations is the ledger; _rms_test_database is the marker the destructive
          -- test guard looks for (tests/helpers.ts). Neither is application data.
          AND c.relname NOT IN ('schema_migrations', '_rms_test_database') ORDER BY 1`,
    )
    expect(r.rows.map((x) => x.relname)).toEqual([])
  })

  it('FORCEs it too, so the owner is not exempt', async () => {
    const r = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
          AND NOT c.relforcerowsecurity ORDER BY 1`,
    )
    expect(r.rows.map((x) => x.relname)).toEqual([])
  })

  it('shows an unbound context no users at all', async () => {
    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    const r = await db.query('SELECT id FROM users')
    await db.exec('COMMIT')
    expect(r.rows.length).toBe(0)
  })

  it('shows a staff member only themselves', async () => {
    const rows = await asRole<{ id: string }>(userIds['volunteer']!, 'SELECT id FROM users')
    expect(rows.map((x) => x.id)).toEqual([userIds['volunteer']])
  })

  it('refuses totp_secret_enc to the application role', async () => {
    // Regression guard for a fix that did NOT work when first written: column privileges are
    // additive, so `REVOKE SELECT (col)` does nothing while a table-level SELECT is held.
    await expect(asRole(null, 'SELECT totp_secret_enc FROM users')).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('makes notification_secrets unreadable, and leaves notifications SELECT-able', async () => {
    // 0042 protected the secret with a column-level revoke, which works but makes `SELECT *`
    // fail for the WHOLE table — a broad, surprising side effect that broke fail-closed.test.
    // 0047 moved it to a side table with RLS on, no policy and SELECT revoked, the same shape
    // as idempotency_keys and rate_limits. Both halves are asserted here.
    await expect(asRole(null, 'SELECT params_enc FROM notification_secrets')).rejects.toThrow(
      /permission denied/i,
    )

    // The star must work again: this is the regression 0047 exists to undo.
    const rows = await asRole(null, 'SELECT * FROM notifications')
    expect(rows.length).toBe(0) // fail-closed by RLS, not by a privilege error
  })

  it('no longer carries the secret column on notifications', async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name='notifications' AND column_name='secret_params_enc'`,
    )
    // One place a secret can live, not two — the second would be unprotected the moment
    // somebody re-granted the table.
    expect(r.rows[0]!.n).toBe(0)
  })

  it('makes idempotency_keys unreadable by anyone', async () => {
    await expect(asRole(null, 'SELECT key FROM idempotency_keys')).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('H-1 — audit integrity', () => {
  it('does not let the application role insert an audit row', async () => {
    await expect(
      asRole(
        userIds['volunteer']!,
        `INSERT INTO audit_events (cycle_id,actor_id,action,entity_type,entity_id)
         VALUES ($1::uuid,$2::uuid,'results.published','cycle',$1::uuid)`,
        [cycleId, userIds['super_admin']],
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('keeps UPDATE and DELETE revoked', async () => {
    for (const priv of ['UPDATE', 'DELETE']) {
      const r = await db.query<{ ok: boolean }>(
        "SELECT has_table_privilege('rms_app','audit_events',$1) ok",
        [priv],
      )
      expect(r.rows[0]!.ok, priv).toBe(false)
    }
  })

  it('still writes through fn_audit — no audit, no commit', async () => {
    const before = (await db.query<{ n: number }>('SELECT count(*)::int n FROM audit_events'))
      .rows[0]!.n
    await asRole(
      userIds['super_admin']!,
      "SELECT fn_audit($1::uuid,'test.action','cycle',$1::uuid,NULL,NULL,'schema test')",
      [cycleId],
    )
    const after = (await db.query<{ n: number }>('SELECT count(*)::int n FROM audit_events'))
      .rows[0]!.n
    expect(after).toBe(before + 1)
  })
})

describe('M-7 — context accessors', () => {
  it('ignores a request.jwt.claims user_id entirely', async () => {
    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ user_id: userIds['super_admin'] }),
    ])
    const r = await db.query<{ uid: string | null }>('SELECT fn_current_user_id() uid')
    await db.exec('COMMIT')
    expect(r.rows[0]!.uid).toBeNull()
  })

  it('treats a malformed context as absent rather than raising', async () => {
    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    await db.query("SELECT set_config('app.user_id','not-a-uuid',true)")
    const r = await db.query<{ uid: string | null }>('SELECT fn_current_user_id() uid')
    await db.exec('COMMIT')
    expect(r.rows[0]!.uid).toBeNull()
  })
})

describe('C-2 / C-4 — function-level authorisation', () => {
  const denied = /DUAL_CONTROL_REQUIRED|TOKEN_INVALID/i

  it('refuses fn_export_selected without data.export', async () => {
    await expect(
      asRole(userIds['volunteer']!, 'SELECT * FROM fn_export_selected($1::uuid)', [cycleId]),
    ).rejects.toThrow(denied)
  })

  it('refuses fn_run_allocation without allocation.run', async () => {
    await expect(
      asRole(userIds['coordinator']!, 'SELECT * FROM fn_run_allocation($1::uuid)', [cycleId]),
    ).rejects.toThrow(denied)
  })

  it('refuses the roster bundle without checkin.perform', async () => {
    await expect(
      asRole(userIds['interviewer']!, 'SELECT * FROM fn_roster_bundle_v2($1::uuid)', [cycleId]),
    ).rejects.toThrow(denied)
  })

  it('ALLOWS the roster bundle to a volunteer — the gate is not simply "deny"', async () => {
    const rows = await asRole(userIds['volunteer']!, 'SELECT * FROM fn_roster_bundle_v2($1::uuid)', [
      cycleId,
    ])
    expect(rows.length).toBe(0)
  })

  it('refuses to advance another user’s TOTP watermark', async () => {
    await expect(
      asRole(
        userIds['volunteer']!,
        'SELECT fn_record_totp_use($1::uuid, 9223372036854775807::bigint)',
        [userIds['super_admin']],
      ),
    ).rejects.toThrow(denied)
  })

  it('allows advancing your own', async () => {
    await asRole(userIds['volunteer']!, 'SELECT fn_record_totp_use($1::uuid, 42::bigint)', [
      userIds['volunteer'],
    ])
  })

  it('refuses an unbound caller', async () => {
    await expect(
      asRole(null, 'SELECT * FROM fn_export_selected($1::uuid)', [cycleId]),
    ).rejects.toThrow(denied)
  })

  it('refuses fn_bulk_reconcile without checkin.reconcile', async () => {
    await db.query(
      `INSERT INTO stages (cycle_id,kind,name,starts_at,ends_at)
       VALUES ($1::uuid,'registration','Desk',now(),now()+interval '4 hours')`,
      [cycleId],
    )
    const stage = (await db.query<{ id: string }>('SELECT id FROM stages LIMIT 1')).rows[0]!.id
    await expect(
      asRole(userIds['volunteer']!, 'SELECT * FROM fn_bulk_reconcile($1::uuid, ARRAY[]::uuid[])', [
        stage,
      ]),
    ).rejects.toThrow(denied)
  })
})

describe('C-5 — a raw token may never be stored', () => {
  let applicantId: string

  beforeAll(async () => {
    await db.query(
      `INSERT INTO applicants (cycle_id,sequence,display_id,full_name,email,phone,state,source)
       VALUES ($1::uuid,9001,'SPH-SP26-9001','Token Test','t@x.com','03001234567','submitted','online')`,
      [cycleId],
    )
    applicantId = (await db.query<{ id: string }>('SELECT id FROM applicants LIMIT 1')).rows[0]!.id
  })

  it('REFUSES a body containing a status link', async () => {
    // The database refuses the shape outright, so a future template cannot reintroduce the
    // leak by interpolating the URL directly — which is exactly how it happened the first time.
    await expect(
      db.query(
        `SELECT fn_enqueue_notification($1::uuid,'registration.confirmation',1::smallint,
          'S','<p>x</p>','Status: https://h/q/AAAAAAAAAAAAAAAAAAAAAA',NULL)`,
        [applicantId],
      ),
    ).rejects.toThrow(/raw access token/i)
  })

  it('accepts the same message with a placeholder', async () => {
    const r = await db.query<{ id: string }>(
      `SELECT fn_enqueue_notification($1::uuid,'registration.confirmation',1::smallint,
        'S','<p>x</p>','Status: {{statusUrl}}',NULL) id`,
      [applicantId],
    )
    expect(r.rows[0]!.id).toBeTruthy()
  })

  it('STORES the ciphertext when one is supplied', async () => {
    // Regression guard for a silent drop found only by running the app: `enqueue` computed the
    // ciphertext and then called fn_enqueue_notification without it, so the parameters were
    // discarded. Nothing failed — the row was created, the body held the placeholder, and the
    // C-5 assertions above all still passed. The applicant would simply have received an email
    // containing the literal text `{{statusUrl}}` and no way to reach their status page.
    //
    // A test that only checks "no raw token is stored" is satisfied by storing nothing at all.
    // This asserts the other half: the substitution value must actually be there.
    const r = await db.query<{ id: string }>(
      `SELECT fn_enqueue_notification($1::uuid,'registration.confirmation',1::smallint,
        'S','<p>x</p>','Status: {{statusUrl}}',$2::bytea) id`,
      [applicantId, Buffer.from('pretend-ciphertext')],
    )
    const stored = await db.query<{ n: number }>(
      'SELECT count(*)::int n FROM notification_secrets WHERE notification_id=$1',
      [r.rows[0]!.id],
    )
    expect(stored.rows[0]!.n).toBe(1)
  })

  it('holds no /q/<token>-shaped string in any stored body', async () => {
    const r = await db.query(
      `SELECT id FROM notifications
        WHERE body_text ~ '/q/[A-Za-z0-9_-]{22}' OR body_html ~ '/q/[A-Za-z0-9_-]{22}'`,
    )
    expect(r.rows.length).toBe(0)
  })

  it('leaves no six-argument overload to fall back to', async () => {
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM pg_proc WHERE proname='fn_enqueue_notification'",
    )
    expect(r.rows[0]!.n).toBe(1)
  })
})

describe('H-6 / M-5 — the staff session bootstrap', () => {
  it('resolves nothing for an unknown auth uid', async () => {
    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    const r = await db.query(
      "SELECT * FROM fn_resolve_staff_session('00000000-0000-4000-8000-000000000000'::uuid)",
    )
    await db.exec('COMMIT')
    expect(r.rows.length).toBe(0)
  })

  it('resolves roles and capabilities from an EMPTY context', async () => {
    // The regression this guards is total: under the previous implementation this ran as an
    // ordinary SELECT on `memberships`, whose policies deny on a NULL user id — so
    // requireStaff returned null for everyone and every staff endpoint answered 401.
    const authUid = '11111111-1111-4111-8111-111111111111'
    await db.query("UPDATE users SET auth_user_id=$1::uuid WHERE email='coordinator@t.test'", [
      authUid,
    ])

    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    const r = await db.query<{ user_id: string; capabilities: string[] }>(
      'SELECT * FROM fn_resolve_staff_session($1::uuid)',
      [authUid],
    )
    await db.exec('COMMIT')

    expect(r.rows.length).toBeGreaterThan(0)
    expect(r.rows[0]!.user_id).toBe(userIds['coordinator'])
    expect(r.rows[0]!.capabilities).toContain('queue.call_next')
  })

  it('never resolves by email address', async () => {
    await db.exec('BEGIN')
    await db.exec('SET LOCAL ROLE rms_app')
    const r = await db.query(
      "SELECT * FROM fn_resolve_staff_session('22222222-2222-4222-8222-222222222222'::uuid)",
    )
    await db.exec('COMMIT')
    expect(r.rows.length).toBe(0)
  })
})

describe('S-2 — the hot-path indexes exist', () => {
  it('created all four', async () => {
    const r = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public'
        AND indexname IN ('idx_queue_applicant_recent','idx_offers_applicant_live',
                          'idx_notifications_bounce_lookup','idx_applicant_phone_trgm')
        ORDER BY 1`,
    )
    expect(r.rows.map((x) => x.indexname)).toEqual([
      'idx_applicant_phone_trgm',
      'idx_notifications_bounce_lookup',
      'idx_offers_applicant_live',
      'idx_queue_applicant_recent',
    ])
  })
})

describe('H-6 — MFA enrolment and challenge', () => {
  it('refuses to hand a TOTP secret to an unbound caller', async () => {
    // No argument means no identifier to tamper with; an unbound context has no row to match.
    await expect(asRole(null, 'SELECT fn_totp_secret_for_self()')).rejects.toThrow(
      /TOKEN_INVALID|authenticated/i,
    )
  })

  it('returns only the CALLER’s own secret, never another account’s', async () => {
    // The property that replaces the pre-0037 state, where any query holding applicant.view
    // could read every row of `users` including this column.
    await db.query("UPDATE users SET totp_secret_enc = $1::bytea WHERE email='super_admin@t.test'", [
      Buffer.from('super-admin-secret'),
    ])
    const rows = await asRole<{ secret: Uint8Array | null }>(
      userIds['volunteer']!,
      'SELECT fn_totp_secret_for_self() AS secret',
    )
    expect(rows[0]!.secret).toBeNull()
  })

  it('reports MFA as required for privileged roles and not for a volunteer', async () => {
    const priv = await asRole<{ required: boolean; enrolled: boolean }>(
      userIds['coordinator']!,
      'SELECT * FROM fn_mfa_status()',
    )
    expect(priv[0]!.required).toBe(true)

    // NFR-USE-001 / rules.md §7: the volunteer class is deliberately not challenged. An
    // authenticator app at a check-in desk costs more than it protects.
    const vol = await asRole<{ required: boolean }>(
      userIds['volunteer']!,
      'SELECT * FROM fn_mfa_status()',
    )
    expect(vol[0]!.required).toBe(false)
  })

  it('enrols in two steps, and confirmation initialises the replay watermark', async () => {
    const uid = userIds['admin']!
    await asRole(uid, 'SELECT fn_totp_begin_enrolment($1::bytea)', [Buffer.from('staged-secret')])

    // Staged but NOT enabled: a volunteer who scans the QR badly must not be locked out.
    const staged = await asRole<{ required: boolean; enrolled: boolean }>(
      uid,
      'SELECT * FROM fn_mfa_status()',
    )
    expect(staged[0]!.enrolled).toBe(false)

    await asRole(uid, 'SELECT fn_totp_confirm_enrolment($1::bigint)', [1000])

    const done = await asRole<{ enrolled: boolean }>(uid, 'SELECT * FROM fn_mfa_status()')
    expect(done[0]!.enrolled).toBe(true)

    // Enabling and initialising the watermark share one transaction — a crash between them
    // would leave MFA on with a NULL watermark, which accepts a replay of the enrolment code.
    const wm = await db.query<{ step: string }>(
      'SELECT totp_last_used_step::text step FROM users WHERE id=$1',
      [uid],
    )
    expect(Number(wm.rows[0]!.step)).toBe(1000)
  })

  it('refuses re-enrolment once enabled', async () => {
    // Otherwise anyone holding a live session could swap the second factor for one they own,
    // which defeats the point of having it. Disabling is a separate, administrative action.
    await expect(
      asRole(userIds['admin']!, 'SELECT fn_totp_begin_enrolment($1::bytea)', [Buffer.from('x')]),
    ).rejects.toThrow(/already enabled/i)
  })

  it('refuses to confirm without a staged secret', async () => {
    await expect(
      asRole(userIds['interviewer']!, 'SELECT fn_totp_confirm_enrolment($1::bigint)', [5]),
    ).rejects.toThrow(/no staged secret/i)
  })
})

describe('S-4 — the rate limit is global and atomic', () => {
  it('allows exactly `max` attempts and then refuses', async () => {
    const key = 'mfa:test-user-a'
    const results: boolean[] = []
    for (let i = 0; i < 7; i++) {
      const r = await db.query<{ allowed: boolean }>(
        'SELECT allowed FROM fn_rate_limit_consume($1, 5::int, 900::int)',
        [key],
      )
      results.push(r.rows[0]!.allowed)
    }
    // Five through, then closed. Against a six-digit code this limit IS the control.
    expect(results).toEqual([true, true, true, true, true, false, false])
  })

  it('reports a retry-after inside the window', async () => {
    const r = await db.query<{ retry_after_seconds: number }>(
      "SELECT retry_after_seconds FROM fn_rate_limit_consume('mfa:test-user-b', 1::int, 900::int)",
    )
    expect(r.rows[0]!.retry_after_seconds).toBeGreaterThan(0)
    expect(r.rows[0]!.retry_after_seconds).toBeLessThanOrEqual(900)
  })

  it('starts a fresh window once the old one expires', async () => {
    // A zero-second window is expired the moment it is written, which is the boundary the
    // CASE in fn_rate_limit_consume exists to handle — carrying the old count forward would
    // lock a legitimate caller out permanently.
    const key = 'mfa:test-user-c'
    await db.query('SELECT * FROM fn_rate_limit_consume($1, 1::int, 0::int)', [key])
    const second = await db.query<{ allowed: boolean }>(
      'SELECT allowed FROM fn_rate_limit_consume($1, 1::int, 0::int)',
      [key],
    )
    expect(second.rows[0]!.allowed).toBe(true)
  })

  it('counts concurrent attempts without letting any slip through', async () => {
    // The race an attacker parallelises: read-then-write would let two requests read the same
    // count and both be allowed. One atomic UPSERT is why they cannot.
    const key = 'mfa:test-user-d'
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () =>
        db.query<{ allowed: boolean }>(
          'SELECT allowed FROM fn_rate_limit_consume($1, 5::int, 900::int)',
          [key],
        ),
      ),
    )
    const allowed = verdicts.filter((v) => v.rows[0]!.allowed).length
    expect(allowed).toBe(5)
  })

  it('keeps the counter table unreadable by the application role', async () => {
    // A table of IP addresses and attempt counts is not something any endpoint should be able
    // to enumerate. Same shape as idempotency_keys: RLS on, no policy, SELECT revoked.
    await expect(asRole(null, 'SELECT key FROM rate_limits')).rejects.toThrow(/permission denied/i)
  })

  it('sweeps expired windows', async () => {
    await db.query(
      "INSERT INTO rate_limits (key, count, window_ends) VALUES ('stale:x', 9, now() - interval '2 hours')",
    )
    const r = await db.query<{ fn_sweep_rate_limits: number }>('SELECT fn_sweep_rate_limits()')
    expect(r.rows[0]!.fn_sweep_rate_limits).toBeGreaterThan(0)
  })
})
