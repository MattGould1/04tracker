# 04tracker — Phase 0 Propagation Measurement Spec

**Date:** 2026-07-05
**Status:** Draft for review
**Repo:** github.com/MattGould1/04tracker (throwaway; exists to answer one question)

## The Question

How long after a 2004scape logout does the hiscores API reflect the new XP,
and how consistent is that delay? The records-first design
(`2004tracker/docs/superpowers/specs/2026-07-05-records-first-design.md`)
needs the distribution (D_min / D_median / D_p95, and whether it's tight) to
pick its kickoff timeout K and end-acceptance window W.

## Approach

A tiny Next.js app on Vercel that any community member can use in their
browser. No database, no accounts, nothing to operate. Each tester runs
trials; results live in their browser (localStorage) and are shared back as
copy-pasted JSON.

### Why there's one route handler (the "no server" caveat)

The hiscores API sends `access-control-allow-origin: https://2004.lostcity.rs`
(verified 2026-07-05), so browsers on our origin cannot call it directly.
A single Next.js route handler (`/api/player/[username]`) proxies the GET
server-side with `cache: 'no-store'` and a unique `_cb` param (Cloudflare
busting — measurements must never see the ~15-min edge cache). That handler
is the entire "backend."

Consequence of proxying: every tester's polls egress from Vercel's shared
IPs against the measured **1 request / 2 seconds** origin limit. Mitigations:
poll interval 15s per active trial (a handful of simultaneous testers stays
well under the limit), and on any 429 the client backs off (doubles its poll
interval for the rest of the trial) and shows a warning.

## The Dummy Flow (mirrors the real record flow)

One page, a wizard of four steps:

1. **Enter account name** → app fetches current stats via the proxy and
   shows total XP + per-skill values (this is "baseline A"). Any name can be
   entered — testers use their own accounts.
2. **Instruction screen**: "Log in, gain some XP (any skill), then log out.
   The moment you log out, click the button." The **"I just logged out"**
   button stamps `loggedOutAt` (client clock).
3. **Polling screen**: app polls every 15s (each request `_cb`-busted via
   the proxy). Shows elapsed time since logout, live. When any skill's
   `value` differs from baseline → stamp `landedAt`, stop polling, and show
   **propagation delay = landedAt − loggedOutAt** big and bold.
   Timeout: after 30 minutes of no change, mark the trial `timeout` and stop
   (data point still saved — "didn't land in 30m" is signal too).
4. **Result screen**: delay for this trial + a table of all trials stored in
   this browser (player, loggedOutAt, landedAt, delay, XP gained, status).
   Buttons: "Copy results as JSON" (for sharing back), "Run another trial",
   "Clear my data".

Edge handling:

- Polling continues in the page; navigating away abandons the trial (noted
  in the UI — keep the tab open; this is also a dry run of the real flow's
  "watch the screen" step).
- If the value has *already changed* between step 1 and the logout click
  (e.g. tester was logged in during baseline), the app warns and restarts
  the trial from a fresh baseline — baseline must predate the logout.
- 0 XP gained: the app can't detect a landing (unchanged value is
  indistinguishable from no propagation); instructions stress "gain at
  least a little XP," and the timeout catches violations.
- Clock skew: `loggedOutAt` uses the tester's client clock, `landedAt` is
  client-observed too, so the *delay* (difference) is immune to skew; only
  poll granularity (±15s) and human click lag blur it. Fine for our purpose.

## Trial Record Shape (localStorage + exported JSON)

```json
{
  "player": "whoosh",
  "loggedOutAt": "2026-07-05T13:02:11.000Z",
  "landedAt": "2026-07-05T13:07:41.000Z",
  "delaySeconds": 330,
  "xpGained": 830,
  "pollIntervalSeconds": 15,
  "status": "landed",              // landed | timeout | abandoned
  "userAgentHint": "..."           // coarse, for dedup when aggregating
}
```

Analysis happens offline: paste everyone's JSON together, compute
D_min/median/p95 and variance by time of day. Success = ~10–15 landed trials
across different times of day.

## Stack & Structure

- Next.js (App Router, TypeScript), deployed on Vercel from this repo.
- No UI libraries; a few components and plain CSS. It's a measurement jig,
  not a product.

```
app/
  page.tsx                  the wizard (client component, state machine)
  api/player/[username]/route.ts   proxy: fetch lostcity with _cb, no-store
lib/
  hiscores.ts               fetch wrapper + types + value-diff helper
  trials.ts                 localStorage read/write/export
docs/
  2026-07-05-phase0-propagation-spec.md   this file
```

## Politeness Rules (inherited from the main project)

- Every proxied request is fresh (`_cb` = ms timestamp + counter) — cached
  data would corrupt measurements.
- 15s minimum poll interval, one active trial per browser tab.
- 429 → double the interval for the trial's remainder + visible warning.
- The proxy only accepts `GET`, only forwards to the player endpoint, and
  validates the username shape (letters/digits/spaces/underscores, ≤ 12
  chars) so it can't be used as an open proxy.

## Out of Scope

Accounts, persistence beyond localStorage, aggregation server, leaderboards,
any reuse ambitions — when Phase 0 has its numbers, this repo's job is done.
