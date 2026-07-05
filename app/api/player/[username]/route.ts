import { NextResponse } from "next/server";

// Proxy for the 2004scape hiscores player endpoint.
//
// Exists only because the API's CORS policy (access-control-allow-origin:
// https://2004.lostcity.rs) blocks direct browser calls. Locked down so it
// can't serve as an open proxy: GET only, one upstream path, validated
// username. Every upstream request is cache-busted (_cb) — measurements must
// never see Cloudflare's ~15-min edge cache.

const USERNAME_RE = /^[A-Za-z0-9 _-]{1,12}$/;

export const dynamic = "force-dynamic";

let cbCounter = 0;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params;
  if (!USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "invalid username" }, { status: 400 });
  }
  const cb = `${Date.now()}.${++cbCounter}`;
  const url = `https://2004.lostcity.rs/api/hiscores/player/${encodeURIComponent(
    username,
  )}?_cb=${cb}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "upstream unreachable" }, { status: 502 });
  }
  if (upstream.status === 429) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  if (!upstream.ok) {
    return NextResponse.json(
      { error: `upstream status ${upstream.status}` },
      { status: 502 },
    );
  }
  const data = await upstream.json();
  return NextResponse.json(data, {
    headers: { "cache-control": "no-store" },
  });
}
