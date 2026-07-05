# 04tracker — Phase 0: hiscores propagation test

A throwaway measurement jig for the 2004tracker records project. It answers
one question: **how long after you log out does the 2004scape hiscores API
reflect your new XP, and how consistent is that delay?**

Spec: [`docs/2026-07-05-phase0-propagation-spec.md`](docs/2026-07-05-phase0-propagation-spec.md)
— the wider records-first design lives in [`docs/2004tracker/`](docs/2004tracker/).

## How to run a trial

1. Open the app, enter your account name → baseline is captured.
2. Log in to 2004scape, gain a little XP (any skill), log out — and click
   **"I just logged out"** the moment you do.
3. Keep the tab open. The app polls the hiscores every 15s until your new XP
   lands, then shows the propagation delay.
4. Run a few trials at different times of day, then **Copy results as JSON**
   and send them back.

Trials are stored only in your browser (localStorage). There is no database.

## Dev

```bash
npm install
npm run dev     # http://localhost:3000
```

The only server code is `app/api/player/[username]/route.ts`, a locked-down
proxy that exists because the hiscores API's CORS policy blocks direct
browser calls. Every upstream request is cache-busted past Cloudflare's
~15-minute edge cache; polls back off on 429.
