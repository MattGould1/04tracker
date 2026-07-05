# 2004scape Hiscores API — Live Findings

Everything we've verified against the live API, consolidated. The published
docs are out of date; where they disagree with observation, observation wins.
(Base URL: `https://2004.lostcity.rs`)

## Rate limiting — **per IP, 1 request / 2 seconds** (verified 2026-07-04/05)

- Every origin (cache MISS) response carries
  `x-ratelimit-limit: 1, x-ratelimit-remaining: 0, x-ratelimit-reset: 2`.
- Reproduced directly: two fresh requests 0.5s apart → `200`, then `429`.
- **The budget is per IP and shared by every client behind it** (verified
  2026-07-05: a monitor at 1 req/3s plus a local app polling at 15s
  intervals — comfortably legal individually — produced steady 429s for
  both). Consequences:
  - Any process we run must funnel *all* requests through one limiter.
  - Separate deployments (EC2 daemon, Vercel proxy, a dev laptop) have
    separate budgets — but never assume two of our tools can share a
    machine or NAT while both talking to the API.
  - Enforcement shows some burstiness: occasional 429s appeared even at
    1 req/3s while sharing the IP, so back off gracefully rather than
    sailing exactly at the limit.
- Docs claim ~100 requests / 5 seconds — wrong (or a different layer).

## Cloudflare edge cache — ~15 min TTL (measured 2026-07-04)

- Bare URLs are cached: `cf-cache-status: HIT`, ages into the 700s+ range;
  entry HIT at age 778s and EXPIRED by age 942s → TTL ∈ (779, 942], almost
  certainly 900s. Origin sends no cache-control.
- A unique query param (`?_cb=<anything fresh>`) forces MISS → origin. Each
  distinct param value becomes its own cache entry.
- A cached body was measurably stale (83 XP behind a fresh fetch).
  **Time-sensitive reads must always cache-bust.**

## Hiscores update on a ~5-minute cycle, not per-logout (measured 2026-07-05)

- Trial delays from logout to visible update are **bimodal**: 32–33s or
  280–311s — inconsistent with a fixed per-logout delay.
- Consecutive landings observed 5m01s–5m03s apart.
- Smoking gun: one landing delivered exactly the sum of two separate
  logouts' XP (41 + 42 = 83) in a single update — batch/tick behavior.
- Model: logouts are picked up by the next ~5-min tick; delay = time to
  next tick, anywhere in [0, ~cycle].
- **Unknown (tests pending):** whether the tick grid is global (server
  batch job) or per-player (origin cache TTL, possibly phase-anchored by
  our own request timing). Discriminating tests: staggered multi-player
  monitoring (grid alignment) and the idle-phase test (unpolled player,
  logout, single fetch 60s later — fresh data ⇒ cache, stale ⇒ batch).

## Response shape (verified 2026-07-03)

- **No `date` field** on either endpoint, despite the docs. Entries are
  `{username|type, level, value, rank}` only. Staleness is unobservable
  per response.
- `value` = XP × 10 (store raw, truncate-divide for display).
- Skill type codes 0–18 and 21 (Runecrafting); 19 and 20 do not exist.
- Player endpoint returns all 20 entries; empty array for unknown names
  (cannot distinguish "doesn't exist" from "unranked" — untested for
  genuinely new/low accounts).
- CORS: `access-control-allow-origin: https://2004.lostcity.rs` — browsers
  on other origins cannot call the API directly; a server-side proxy is
  required for web apps.

## Design consequences (see records spec)

- Record boundaries must be defined as **observed landings**, not inferred
  wall-clock logout times; the time dimension is quantized to one cycle.
- XP values themselves are exact — all measurement error lives in time.
- Boundary uncertainty ≈ one cycle (~5 min): negligible for 24h+ records,
  ~1.4% of a 6h record, disqualifying for anything much shorter.
