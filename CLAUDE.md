# SOPHEP RMS — Project Context

> **Before your first edit in this repository, read [`rules.md`](rules.md) in full and confirm
> in your first response that you have done so.** It is not optional and it is not a summary of
> this file — it contains blocking constraints that prevent reintroducing defects this design
> has already found and fixed.

---

## What this is

A cycle-based recruitment management system for SOPHEP, a student society. It runs an induction
end to end: **registration → check-in → queue → interview → evaluation → scoring → allocation →
offers → onboarding**. Roughly 100–1,000 applicants per cycle, 6–20 volunteers, 8–30
interviewers, run in a noisy hall on unreliable campus WiFi by people with 15 minutes of training.

Those operating conditions drive nearly every design decision. When a trade-off appears, the
event continuing matters more than the feature working perfectly.

## Source of truth — in precedence order

| Rank | Document | Use for |
|---|---|---|
| 1 | `Documents/sophep-rms-spec.json` | Machine-readable spec. **Wins on conflict.** |
| 2 | `Documents/SOPHEP-RMS-v2-Architecture-and-UX.md` | Design rationale, schema, screens, *why* |
| 3 | `Documents/SOPHEP-RMS-TRD-v1.0.md` | 238 numbered requirements + verification methods |

The JSON's own `notes_for_implementers` is explicit: if the JSON and the prose disagree, that is
**a defect in the JSON — raise it, do not silently pick one**. Requirements using *shall* are
mandatory; absence is a defect.

⚠️ **`Flows/` contains obsolete boards that encode known defects.** See `rules.md` §4 before
opening anything in there. Flow `05` still shows the HMAC scheme that was a security flaw; flow
`10` still shows the broken score normalisation.

## Repository layout

```
frontend/     Next.js App Router — all UI. Thin route handlers only.
backend/      SQL migrations, RLS, Postgres functions, domain logic, jobs, DB tests.
Documents/    READ-ONLY reference.
Flows/        READ-ONLY reference, partly obsolete (rules.md §4).
rules.md      Blocking constraints. Read first.
ROADMAP.md    Phase tracker with exit criteria.
```

**File placement is a blocking rule** (`R-001`–`R-003`): no UI outside `frontend/`, no SQL
outside `backend/`, and no business logic inside a Next.js route handler.

## Design principles (Architecture spec §1)

1. **The event never stops.** Every critical path has a degraded mode.
2. **Never present a number you know is stale as if it were live.** Honesty beats the appearance
   of stability. *This is a principle because v1 violated it.*
3. Every state change is atomic, idempotent, and audited.
4. **One writer per fact.** Projections are written in the same transaction as their source.
5. Fairness is enforced by the schema, not by policy.
6. Applicants see only themselves — at the row level in the database.
7. Optimise for the fifteen seconds at the desk.
8. Configuration over code. A new cycle never requires a deployment.
9. Cycles are immutable once closed.

## The five invariants — expensive to retrofit, so correct from day one

1. **Cycle scoping** on every table except `societies` and `users`.
2. **Append-only audit**, written in the same transaction as the change. No audit, no commit.
3. **Single-writer state ownership** — `applicants.state` is a projection, never written directly.
4. **`FOR UPDATE SKIP LOCKED`** queue claim with `NOT EXISTS` recusals.
5. **Fail-closed RLS** — unset context yields zero rows, never all rows.

Details and rationale in `rules.md` §2. Everything else in this system can be changed later;
these four cannot without a destructive migration.

## Tech stack

Next.js App Router · TypeScript · Tailwind · Supabase (Postgres + RLS + Realtime + Auth) ·
Vercel · npm workspaces.

Email is **mocked behind an interface** until a Resend account and verified sending domain
exist. Messages persist to a `notifications` table and render at a local preview route. This
keeps `FR-NOT-001` (asynchronous, never synchronous in a user-facing request) honest regardless.

## Commands

```bash
npm install              # install all workspaces
npm run dev              # frontend dev server
npm run verify           # typecheck + lint + test — run before every commit
npm test                 # all workspace tests
npm run test:rls         # direct-SQL RLS tests, bypassing the API
npm run test:concurrency # 20-actor claim and registration tests
npm run db:migrate       # apply migrations
npm run db:seed          # seed a demo cycle
```

## Locked decisions — do not re-litigate

| Decision | Value |
|---|---|
| Panel size | 2 interviewers, both evaluate |
| Interview structure | One general interview; department fit is a rubric criterion |
| Ranked preferences | Up to 3 |
| Interview duration | **Variable, 10–30 min** (not the spec's fixed 12) |
| Wait estimate tuning | Seed 20 min, smoothing 0.2, range −30%/+50% — all cycle config |
| Offer expiry | **1 day**, reminder at **T−6h** (overrides FR-OFF-002's 48h) |
| Waitlist cascade | Runs **hourly** — required by the 1-day expiry |
| Slot booking | **No public booking.** Host team grants priority 50 on request, with a reason |
| Capacity model | Takes **min and max** duration, reports a feasibility *range* |
| Timeline | Phases 1–4 in 6–8 weeks; Phase 5 before the event |

The last four exist because a variable 10–30 minute interview breaks maths the spec tuned for a
fixed 12 minutes, and a 1-day expiry makes a 48-hour reminder impossible. Changing any of these
is a decision, not an implementation detail — see `R-054`.

## Open issues — defaults in force until the committee decides

| ID | Issue | Default | Blocks |
|---|---|---|---|
| OI-4 | Placement in two departments | No | Phase 4 |
| OI-5 | Second interview round | No | Phase 3 |
| OI-6 | Public list of selected IDs, or individual notices only | Individual only | Phase 4 |
| OI-10 | Waiver authority | Coordinator, audited | Phase 3 |
| OI-11 | Hosting tier and **data residency** | Undetermined | Phase 1 |
| OI-12 | Faculty approval for retention policy | Assumed yes | Phase 1 |

OI-6 and OI-11 are committee decisions, not engineering ones. OI-11 has a real deadline: data
residency is painful to change once applicant PII exists.

The TRD **is not baselined** until four approvals are recorded (President, General Secretary,
Engineering lead, Faculty advisor). Building against a draft is fine; pretending it is final is not.

## Environment notes

This repository lives inside **OneDrive**. `node_modules/` and `.next/` are gitignored and
should be excluded from sync. If a build fails with `EPERM` or `EBUSY`, that is OneDrive file
locking, not the code — pause sync and retry before debugging anything else.
