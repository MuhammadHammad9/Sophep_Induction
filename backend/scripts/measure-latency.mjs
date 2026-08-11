/**
 * Latency measurement against the NFR-PERF targets.
 *
 * The targets that matter on the day:
 *   NFR-PERF-002  check-in API, p95 <= 300 ms
 *   NFR-PERF-004  queue claim,  p95 <= 200 ms
 *
 * ⚠ READ THE NUMBERS WITH THE NETWORK IN MIND. This measures from a developer laptop in
 * Pakistan to a Supabase instance in ap-southeast-1, so every figure includes ~60-80 ms of
 * round-trip that will NOT exist in production, where the app runs in a Vercel region beside
 * the database. Treat these as an upper bound and a regression signal, not as a pass/fail
 * against the spec — a proper measurement runs from the deployed environment (Phase 5).
 */

import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const sql = postgres(url, { max: 10, prepare: false, onnotice: () => {} })

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function report(label, samples, targetMs) {
  const p50 = percentile(samples, 50)
  const p95 = percentile(samples, 95)
  const verdict = p95 <= targetMs ? 'within target' : 'ABOVE target'
  console.log(
    `${label.padEnd(28)} n=${String(samples.length).padStart(4)}  ` +
      `p50=${p50.toFixed(0).padStart(4)}ms  p95=${p95.toFixed(0).padStart(4)}ms  ` +
      `(target ${targetMs}ms — ${verdict})`,
  )
}

async function time(fn) {
  const t = process.hrtime.bigint()
  await fn()
  return Number(process.hrtime.bigint() - t) / 1e6
}

try {
  const [cycle] = await sql`SELECT id FROM cycles WHERE state = 'registration_open' LIMIT 1`
  if (!cycle) {
    console.error('No open cycle — run npm run db:seed first')
    process.exit(1)
  }

  const [track] = await sql`SELECT id FROM tracks WHERE cycle_id = ${cycle.id} LIMIT 1`
  let [stage] = await sql`
    SELECT id FROM stages WHERE cycle_id = ${cycle.id} AND kind = 'interview' LIMIT 1
  `
  if (!stage) {
    ;[stage] = await sql`
      INSERT INTO stages (cycle_id, kind, name, starts_at, ends_at)
      VALUES (${cycle.id}, 'interview', 'Perf', now() - interval '1 hour', now() + interval '8 hours')
      RETURNING id
    `
  }

  // ── Queue depth: NFR-SCAL-003 requires claim latency not to degrade more than 20% from
  // 50 to 1,000 waiting entries, so measure with a realistic queue, not an empty one.
  const N = 200
  const names = [], emails = [], phones = []
  const run = Date.now().toString().slice(-6)

  // norm_phone keeps only the LAST 9 DIGITS, so the varying part must live inside them —
  // differing prefixes are discarded and every number collides.
  let phoneSeq = Number(run) * 1000
  const nextPhone = () => `03${String(++phoneSeq % 1_000_000_000).padStart(9, '0')}`

  for (let i = 0; i < N; i++) {
    names.push(`Perf ${i}`)
    emails.push(`perf-${run}-${i}@example.com`)
    phones.push(nextPhone())
  }

  console.log(`Seeding ${N} queued applicants...`)
  await sql`
    SELECT fn_enqueue(
      (fn_register_applicant(${cycle.id}::uuid, d.n, d.e, d.p, 'online')).id,
      ${track.id}::uuid, ${stage.id}::uuid)
    FROM unnest(${names}::text[], ${emails}::text[], ${phones}::text[]) AS d(n, e, p)
  `

  const [{ waiting }] = await sql`
    SELECT count(*)::int AS waiting FROM queue_entries WHERE state = 'waiting'
  `
  console.log(`Queue depth: ${waiting}\n`)

  // Baseline first. Without it every number below is uninterpretable — a 210 ms result could
  // be a slow query or a slow network, and those demand entirely different responses.
  const rtt = []
  for (let i = 0; i < 40; i++) rtt.push(await time(() => sql`SELECT 1`))
  report('network baseline (SELECT 1)', rtt, 999)

  // ── Check-in ────────────────────────────────────────────────────────────────────────
  const checkInSamples = []
  for (let i = 0; i < 40; i++) {
    const [a] = await sql`
      SELECT id FROM fn_register_applicant(
        ${cycle.id}::uuid, ${'CheckIn ' + i}, ${`ci-${run}-${i}@example.com`},
        ${nextPhone()}, 'online')
    `
    checkInSamples.push(await time(() => sql`SELECT * FROM fn_check_in(${a.id}, ${stage.id})`))
  }
  report('fn_check_in', checkInSamples, 300)

  // ── Claim ───────────────────────────────────────────────────────────────────────────
  const [room] = await sql`
    INSERT INTO rooms (cycle_id, code, name) VALUES (${cycle.id}, ${'PERF' + run}, 'Perf Room')
    ON CONFLICT (cycle_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id
  `
  const [panel] = await sql`
    INSERT INTO panels (cycle_id, room_id, name, status, opened_at, last_heartbeat)
    VALUES (${cycle.id}, ${room.id}, 'Perf Panel', 'open', now(), now()) RETURNING id
  `
  await sql`INSERT INTO panel_tracks (panel_id, track_id) VALUES (${panel.id}, ${track.id})`

  const claimSamples = []
  for (let i = 0; i < 60; i++) {
    claimSamples.push(await time(() => sql`SELECT * FROM fn_claim_next(${panel.id})`))
    await sql`UPDATE panels SET status = 'open' WHERE id = ${panel.id}`
  }
  report('fn_claim_next', claimSamples, 200)

  // ── Status page ─────────────────────────────────────────────────────────────────────
  const [tok] = await sql`
    SELECT token_hash FROM access_tokens WHERE revoked_at IS NULL LIMIT 1
  `
  if (tok) {
    const statusSamples = []
    for (let i = 0; i < 40; i++) {
      statusSamples.push(
        await time(() => sql`SELECT * FROM fn_applicant_status(${tok.token_hash})`),
      )
    }
    report('fn_applicant_status', statusSamples, 300)
  }

  // Server-side execution, excluding the network entirely. THIS is the figure that tests the
  // query and the partial index; the wall-clock numbers above are dominated by distance.
  const plans = []
  for (let i = 0; i < 20; i++) {
    const rows = await sql.unsafe(
      'EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM fn_claim_next($1)',
      [panel.id],
    )
    plans.push(rows[0]['QUERY PLAN'][0]['Execution Time'])
    await sql`UPDATE panels SET status = 'open' WHERE id = ${panel.id}`
  }
  report('fn_claim_next SERVER-SIDE', plans, 200)

  console.log(
    '\nWall-clock figures include cross-region round-trip from this laptop and are an UPPER\n' +
      'BOUND, not a verdict — subtract the baseline. The SERVER-SIDE figure is the one that\n' +
      'tests the query. Re-measure from the deployed environment before the event (Phase 5).',
  )
} finally {
  await sql.end()
}
