# 2004Tracker — Records-First Design Spec

**Date:** 2026-07-05 (v2 — supersedes `2026-07-03-hiscores-collector-design.md`)
**Status:** Draft for review

## Goal

A records-first service for 2004scape: players run **timed XP record attempts**
(6h, 24h, 1w, 1mo, 1y) with defensible start/end boundaries, despite an API
that only exposes "total XP as of the last propagated logout." General
population hiscores tracking is dropped entirely.

## The Epistemic Limit (drives everything)

The API gives us total XP per skill at the player's last *propagated* logout —
no timestamps, no session info. Hiscores update ~5 minutes after logout
(assumed; **must be measured**, see Phase 0). Therefore:

- We never observe logins/logouts, only landings of new values.
- Every record boundary is observable only to ± (propagation delay + poll
  interval). Anti-cheat means shrinking and bounding that blind spot, not
  eliminating it.
- Boundary noise is ~constant, so short records are proportionally more
  gameable → **minimum record duration: 6h** (sole exception: the flag-gated
  `15m` dev tier for flow validation, never published).

## API Facts (unchanged from v1 spec, verified live 2026-07-03/04)

- Base `https://2004.lostcity.rs`; endpoints `/api/hiscores/category/:type?rank=N`
  (21/page) and `/api/hiscores/player/:username`.
- Responses carry `{username|type, level, value, rank}` — **no date field**.
- `value` = XP × 10; store raw, divide only for display.
- Skill types 0–18 and 21 (Runecrafting); 19–20 don't exist.
- Cloudflare edge cache **~15 min TTL**; unique `_cb` param forces origin.
  **Record-related fetches are always fresh mode — never cached.**
- Origin rate limit **1 request / 2 seconds** (x-ratelimit headers on every
  MISS). Client cap 0.5 req/s process-wide, 429 halves it for the process.
- TODO(verify): behavior for unranked/new players — expectation is the player
  lookup still returns them; test with a fresh account before trusting
  records for low-level players.

## Accounts & Identity (new)

Lowest-barrier basic auth for a small community:

- **Account**: username + password (bcrypt). Login issues a bearer token.
- An account **claims** in-game names, first-come-first-served (unique claim
  per in-game name). Only the claiming account can start or cancel record
  attempts for that name.
- **No auto-cancel ever**: starting an attempt for a duration tier that
  already has an active/pending attempt is an error; cancel is an explicit,
  authenticated action. (Overlap across *different* tiers is allowed — see
  the concurrency rule in the lifecycle section.)
- TODO(ownership): no proof of in-game ownership initially. Later: verify via
  an uploaded screenshot of the account typing a server-issued string; add a
  dispute/reassign flow for contested names.

## Record Attempt Lifecycle (state machine)

All state lives in SQLite; the daemon derives due work from state on every
tick, so restarts recover by re-reading the DB. (Decision: no Redis/queue
service — a second stateful service adds ops burden and removes no logic at
our scale. TODO(scale): revisit if this ever becomes multi-process.)

States: `pending_kickoff → active → awaiting_end → verified`, with `voided`
and `cancelled` as terminal branches.

### 1. Start → `pending_kickoff`

- Authenticated "start attempt" for a claimed name, with a duration
  (`6h|24h|1w|1mo|1y`, custom parser: h/d/w=7d/mo=30d/y=365d).
- **Dev duration**: a `15m` tier exists purely to validate the full flow
  (kickoff landing ≈ 5 min in, a few minutes of play, logout landing inside
  the end window). Gated behind a server flag (`-allow-dev-records`), never
  shown on public results, exempt from the 6h minimum. If Phase 0 measures
  propagation slower than ~5 min, bump the dev tier so it still fits
  kickoff + play + end window.
- **Concurrency rule**: a player may run overlapping attempts, but only one
  *per duration tier* at a time — e.g. one active 1y attempt plus many
  sequential 6h attempts inside it. Starting a duration that's already
  active/pending for that player is an error (still no auto-cancel).
  Snapshots are shared: any attempt's boundary and context fetches become
  context data points for every other overlapping attempt on the same
  player. Simultaneous pending kickoffs (say a 6h and a 24h started
  together) each get their own random challenge; one login session gaining
  both challenge skills satisfies both with a single logout.
- Fresh fetch captures **baseline A** (all skills).
- Server issues a **challenge**: a randomly chosen **non-combat skill**
  (pool: Cooking, Woodcutting, Fletching, Fishing, Firemaking, Crafting,
  Smithing, Mining, Herblore, Agility, Thieving, Runecrafting). Player must
  log in, gain XP in that skill, and log out.
- Why random + non-combat: a pre-banked logout (grind → log out → click
  start → log back in immediately) cannot contain gains in a skill chosen
  *after* it happened. This kills the stale-baseline/masquerade exploit.
  Combat skills excluded because some accounts are self-identified
  "skillers" who never gain combat XP; shrinking the pool to non-combat
  skills accommodates them. Note: challenge XP lands *before* the window
  opens so it never pollutes the record itself.
- Poll fresh every 30s. Kickoff **lands** when challenge skill value > A's
  and total value > A's (strictly positive gain required — an unchanged
  value is indistinguishable from "not propagated yet").
- Timeout: if no landing within **K minutes** (constant TBD from Phase 0;
  order of 20–30 min), attempt → `voided` (free to retry).

### 2. `active`

- `started_at` = **our observation time** of the kickoff landing (never
  back-dated). `ends_at = started_at + duration`. The player is told both.
- The landed kickoff snapshot is **baseline B** — the record measures gains
  from B.
- Player may log in/out freely. Sparse mid-run context polls (fresh, e.g.
  every 6h for long attempts) enrich the dataset; they are informative, not
  authoritative for boundaries.
- Player must log out before `ends_at` for a fully-verified end (see below).

### 3. `awaiting_end`

- At `ends_at`: immediate fresh snapshot = **fallback end** (the last
  propagated value — by design: on a 1y attempt the player may have been
  offline for hours/days at the deadline, and their true final state is
  already sitting in the hiscores).
- From `ends_at + 2min`, poll fresh every 30s until `ends_at + W`.
- If a new value lands in the window → it's the **end XP** and
  `final_logout_captured = true`.
- If nothing lands by `ends_at + W` → fallback end stands,
  `final_logout_captured = false`. Still `verified` (legitimate for long
  attempts), but the flag is part of the public record.
- **Overtime bound**: with a consistent propagation delay D, a logout at time
  T lands at ≈ T + D within a predictable window. Accepting only landings in
  `[ends_at, ends_at + W]` means a logout later than `ends_at + (W − D_min)`
  cannot be counted. W = D_p95 + margin (constants from Phase 0). If the
  delay proves *inconsistent*, W widens and the overtime bound weakens —
  that's a measured trade-off, not a silent one.
- A landing that arrives *after* the window closed is ignored for the record
  (data point still stored).

### 4. Outcomes

- `verified` + `final_logout_captured` true/false, with the measured values.
- `voided`: kickoff timeout, unrecoverable data problems, or a daemon outage
  that spanned the end window (never fabricate a boundary).
- `cancelled`: explicit authenticated cancel.
- Every published record carries its boundary observations (times we saw
  landings) so results are auditable.

## Rate Budget & Scheduling

- Shared 0.5 req/s cap unchanged. Poll cadences: kickoff 30s, end-window 30s,
  mid-run context 6h.
- Small community ⇒ contention is rare; when it happens, polls queue behind
  the limiter (the accepted "cooloff" — a poll may run seconds late, which
  only ever *shrinks* what an attacker can hide, never breaks correctness,
  because all comparisons use observation timestamps).
- Priority order when queued: end-window > kickoff > context/manual.
- No population sweeps anymore. Optional light "scan" of *claimed* players
  (cached mode, daily) purely for context data points; `source` column keeps
  them out of boundary math.

## Storage (SQLite, unchanged philosophy)

Tables (final SQL at plan time): `accounts`, `claims` (account ↔ in-game
name, unique per name), `players`, `snapshots` (player_id, skill_type, raw
value, level, rank, fetched_at, source: `record|scan|manual`),
`record_attempts` (player_id, account_id, duration, status, challenge_skill,
baseline A & B refs, started_at, ends_at, end refs, final_logout_captured,
observation timestamps, cancel token/audit fields).

Append-only snapshots; boundary rows referenced by id from `record_attempts`.

## Interface (v1: HTTP API + CLI, UI later)

Records-first requires interactivity ("click start, watch the screen"), so
the daemon grows a small authenticated HTTP API (Go stdlib `net/http`):
register/login, claim name, start/cancel attempt, attempt status (poll-able
by a future web page). CLI subcommands wrap the same internals for local
admin. TODO(ui): minimal web page with live status + audible ping when the
kickoff lands or an end window needs attention ("forgot to log out" is the
player's problem, but the UI should help them not have it).

## Phase 0 — Propagation Measurement (before any constants are fixed)

A `measure` harness: poll a test player fresh every 15s while the tester logs
in/out at recorded wall-clock times; log every landing with its observation
time. ~10–15 trials across different times of day. Outputs: D_min, D_median,
D_p95, and whether the delay is consistent enough for a tight W. Constants K
(kickoff timeout) and W (end acceptance window) are chosen from this data and
recorded in this spec before implementation of the state machine.

## Out of Scope (v1)

- Web UI (API is UI-ready; page comes later)
- Ownership enforcement (TODO above), password reset flows
- Population hiscores/EHP features
- Redis/queue infra (TODO(scale))
- Sentry/structured logging (TODO(logging) carried over from v1 spec)

## Superseded

`2026-07-03-hiscores-collector-design.md` (population collector) and the plan
`2026-07-04-hiscores-collector.md`. Reusable from that work: API client with
fresh/cached modes + throttle + 429 adaptation, skill map, offset parser,
SQLite layer patterns, small-files philosophy, EC2/systemd deployment.
