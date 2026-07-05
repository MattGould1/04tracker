# 2004Tracker Collector — Design Spec

**Date:** 2026-07-03 (rev 5 — cache TTL measured, 1/2s limit confirmed, two request modes)
**Status:** Approved pending review

## Goal

A minimal Go data collector for the 2004scape (lostcity.rs) hiscores API. No UI.
It discovers players, snapshots every player's full skill stats once per day,
supports on-demand refreshes, and lets competitive players start **record
cycles** (checkpoint snapshots at 6h/24h/1w/1mo/1y offsets). Data accumulates
for years in SQLite.

## API Facts (from official docs)

- Base URL: `https://2004.lostcity.rs`
- `GET /api/hiscores/category/:type?rank=N` — paginated leaderboard, 21 entries
  per page; `?rank=N` returns ranks N-20 … N. Entries:
  `{username, level, value, rank}`. Sorted by rank (total level/XP).
- `GET /api/hiscores/player/:username` — full stats for one player. Entries:
  `{type, level, value, rank}`. Cannot be used to test account existence.
- `value` is XP × 10. **Store raw; divide/truncate only for display.**
- Skill types: 0 Overall, 1 Attack, 2 Defence, 3 Strength, 4 Hitpoints,
  5 Ranged, 6 Prayer, 7 Magic, 8 Cooking, 9 Woodcutting, 10 Fletching,
  11 Fishing, 12 Firemaking, 13 Crafting, 14 Smithing, 15 Mining, 16 Herblore,
  17 Agility, 18 Thieving, **21 Runecrafting** (19–20 do not exist; verified live).
- Hiscores update ~5 minutes after player logout (not on a schedule). A
  snapshot therefore reflects the player's last processed logout, never live
  XP. Staleness is not observable per response — only our own `fetched_at`.
- Documented rate limit: ~100 requests / 5 seconds. **Live evidence disagrees**
  (see below).

### Live API observations (verified 2026-07-03)

The published docs are out of date in ways that shape the design:

- **No `date` field exists** on either endpoint, despite the docs. Responses
  carry only `{username|type, level, value, rank}`.
- **Cloudflare caches API responses with a ~15-minute edge TTL** (measured
  2026-07-04: entry HIT at age 778s, EXPIRED by age 942s → TTL ∈ (779, 942],
  i.e. almost certainly 900s). The origin sends no cache-control; a cached
  body was measurably stale (83 XP behind a fresh fetch). A unique query
  param (e.g. `_cb=<unix nanos>`) forces `MISS` → origin; each distinct
  param value gets its own cache entry, so the value must be fresh per use.
- **Two request modes** follow from this (see Rate Policy): *cached* (bare
  URL) for sweeps/discovery, where ≤15 min staleness is irrelevant at daily
  granularity and warm entries from the site's own traffic spare the origin;
  *fresh* (`_cb` busted) for records and on-demand updates, where accurate
  time-keeping matters.
- **Origin rate limit is 1 request / 2 seconds**, not the documented 100/5s:
  every origin (MISS) response carries `x-ratelimit-limit: 1,
  x-ratelimit-remaining: 0, x-ratelimit-reset: 2` (confirmed on multiple
  origin hits across two days; absent only on edge HITs). The rate policy
  below treats this as the real limit.

## Rate Policy: cap vs pace

- **Cap:** a single shared token-bucket limiter in the API client, default
  ceiling **0.5 req/s** — matching the measured 1-per-2s origin limit
  (flag-configurable if the limit is ever relaxed). Nothing in the process can
  exceed it; record checkpoints and on-demand updates queue behind it rather
  than spike. All requests share the limiter regardless of mode — edge HITs
  may not count against the origin limit, but assuming they do is the safe
  and simple posture.
- **Pace:** the daily sweep additionally spreads its own requests evenly over a
  target window, default **180 minutes** (~0.49 req/s for ~5,250 requests —
  sitting just under the origin limit while leaving the daemon's other
  traffic to interleave via the shared limiter).
- **Adaptive:** any 429 halves the effective cap for the remainder of the
  process (not just the run) and logs loudly; it is evidence our reading of
  the limits is wrong, so the collector should get *more* conservative, not
  retry harder. Being kind to the API is the default posture.

## Architecture

One Go module → one static binary `tracker`. SQLite via `modernc.org/sqlite`
(pure Go, cross-compiles for linux/arm64). Long-running daemon replaces cron.

**File philosophy: small files.** One exported function (or one tight concern)
per file, with a matching `_test.go` beside it.

```
cmd/tracker/main.go              subcommand dispatch + flags
internal/api/
  client.go                      base client, shared limiter wiring; two modes:
                                 cached (bare URL) vs fresh (unique _cb param)
  throttle.go (+_test)           token bucket: cap + pacing + adaptive halving
  category.go (+_test)           category endpoint + pagination iterator
  player.go (+_test)             player endpoint
  skills.go (+_test)             type-code map incl. the 19–20 gap
internal/db/
  db.go                          open + idempotent migration (go:embed schema.sql)
  schema.sql
  upsert_player.go (+_test)
  insert_snapshots.go (+_test)
  latest_fetch.go (+_test)       powers the on-demand cooldown
  sweep_runs.go (+_test)
  record_cycles.go (+_test)      create/due/advance/complete cycles
internal/sweep/
  discovery.go (+_test)          full + tail-scan discovery
  sweep.go (+_test)              orchestrates discovery + player fetches
internal/daemon/
  daemon.go (+_test)             scheduler loops, graceful shutdown
scripts/
  setup-ec2.sh                   provision EC2: install Go, build, systemd unit
```

### Subcommands

- `tracker daemon` — long-running scheduler:
  - daily sweep at a configured time (default 04:00 local)
  - record-cycle checker every 30 s (fetch players with due checkpoints)
  - graceful shutdown on SIGINT/SIGTERM (finish in-flight request, mark state)
- `tracker sweep` — run one sweep immediately (manual/testing)
- `tracker update <username>` — on-demand refresh; 5-minute per-player cooldown
  (vs latest `fetched_at`); refusal prints time remaining, exits 2
- `tracker record start <username> [-checkpoints 6h,24h,1w,1mo,1y]` — start a
  record cycle: immediate baseline snapshot, then checkpoint fetches at each
  offset from start. Offsets use a small custom parser (`h` hours, `d` days,
  `w` = 7d, `mo` = 30d, `y` = 365d) since Go's `time.ParseDuration` stops at
  hours
- `tracker record status <username>` — show active cycle progress

### Flags (defaults)

`-db tracker.db` · `-base-url https://2004.lostcity.rs` · `-cap 0.5` (req/s
ceiling) · `-sweep-spread 180m` · `-sweep-at 04:00` · `-max-pages 0`

## Database Schema

```sql
CREATE TABLE players (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_seen TEXT NOT NULL,           -- UTC ISO-8601
  last_seen  TEXT NOT NULL
);

CREATE TABLE snapshots (
  player_id    INTEGER NOT NULL REFERENCES players(id),
  skill_type   INTEGER NOT NULL,
  value        INTEGER NOT NULL,      -- raw XP*10
  level        INTEGER NOT NULL,
  rank         INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL,         -- UTC, ours (the API exposes no date)
  source       TEXT NOT NULL          -- 'sweep' | 'update' | 'record'
);
CREATE INDEX idx_snapshots_player ON snapshots (player_id, skill_type, fetched_at);

CREATE TABLE sweep_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  discovery_mode  TEXT,               -- 'full' | 'tail'
  players_seen    INTEGER,
  players_fetched INTEGER,
  players_failed  INTEGER,
  requests        INTEGER
);

CREATE TABLE record_cycles (
  id                 INTEGER PRIMARY KEY,
  player_id          INTEGER NOT NULL REFERENCES players(id),
  started_at         TEXT NOT NULL,
  checkpoints        TEXT NOT NULL,   -- JSON array of offsets, e.g. ["6h","24h","1w","1mo","1y"]
  next_checkpoint_ix INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL    -- 'active' | 'done' | 'cancelled'
);
```

Append-only snapshots (~100k rows/day at 5k players; ~2–4 GB/year, fine).
All SQL behind named functions in `internal/db` — a future Postgres migration
touches one package.

## Record Cycles (competitive players)

1. `record start` normalizes the username, upserts the player, takes an
   immediate baseline snapshot (`source='record'`), and stores the cycle with
   its checkpoint offsets.
2. The daemon's cycle loop (every 30 s) finds cycles whose next checkpoint time
   (`started_at + checkpoints[next_checkpoint_ix]`) has passed, fetches the
   player through the shared limiter, snapshots, and advances the index;
   after the last checkpoint the cycle is `done`.
3. Gains for any window = diff of the two snapshots nearest the window edges —
   computed at read time, no extra storage.
4. One active cycle per player at a time (starting a new one cancels the old).
5. Missed checkpoints (daemon was down): on restart, take the checkpoint fetch
   immediately, keep the original schedule for subsequent ones.

## Sweep Algorithm

1. **Discovery** —
   *Full* (first run, then weekly): page category 0 via `rank=21,42,…` until a
   short/empty/all-known-and-not-first page. Upsert everyone.
   *Tail* (other days): players are rank-sorted and new accounts enter at the
   bottom, so re-scan only the last ~5 known pages and walk forward until a
   short page. Mid-list new entrants are caught by the weekly full pass.
2. **Fetch** — for **every** player in `players` (not just today's discoveries),
   call the player endpoint, insert one snapshot row per skill. Requests are
   paced to spread across `-sweep-spread`. Empty response → count as skipped.
3. **Record** — write `sweep_runs` row; print one summary line.

## Errors, Backoff, Logging

- Timeout / 5xx: wait **30 s**, retry once, then skip and continue.
- HTTP 429: sleep 60 s, then halve the effective cap for the remainder of the
  process (see Rate Policy), log loudly.
- Malformed JSON: skip entry, count failed, never abort a run.
- Logging: stdout, one line per significant event.
  **TODO(logging):** structured logging + error reporting (e.g. Sentry's Go
  SDK) once this runs unattended on EC2 — revisit after v1.

## Deploy (EC2, no cron)

- `scripts/setup-ec2.sh`: installs Go (official arm64 tarball), builds the
  binary from the repo, installs + enables a **systemd service** for
  `tracker daemon` (restart-on-failure, survives reboots).
- Alternative documented in README: cross-compile locally
  (`GOOS=linux GOARCH=arm64 go build`) and scp just the binary — Go on the
  server is optional, not required.
- Backup: Litestream or periodic S3 copy of the db file (README note, not v1 code).

## Testing

- Per-file `_test.go` throughout (matching the small-file philosophy).
- `internal/api`: `httptest` mock — pagination termination, XP*10 passthrough,
  skill-gap map, cap enforcement, adaptive 429 halving, and mode behavior
  (cached requests carry no `_cb`; every fresh request carries a previously
  unused `_cb` value).
- `internal/db`: temp-file DB — idempotent migration, upserts, cooldown,
  cycle advancement.
- `internal/sweep` + `internal/daemon`: end-to-end against mock server + temp
  DB with a fake clock; asserts row counts, checkpoint firing, missed-checkpoint
  catch-up.
- Manual smoke: `tracker sweep -max-pages 1` (≤ ~30 real requests).

## Out of Scope (v1)

- UI / HTTP server (record cycles are CLI-triggered for now)
- EHP/records *computation* (schema supports it)
- Snapshot dedupe, Postgres/Timescale, Sentry wiring (TODOs noted)
