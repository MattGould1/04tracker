# 2004Tracker Hiscores Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single Go binary that collects 2004scape hiscores data: daily full-population sweeps, on-demand player updates, and long-running record cycles, stored append-only in SQLite.

**Architecture:** One Go module, packages `internal/api` (HTTP client with shared 0.5 req/s throttle, cached vs fresh request modes), `internal/db` (SQLite storage, one exported function per file), `internal/dur` (offset parser), `internal/sweep` (discovery + sweep orchestration), `internal/app` (update/record commands), `internal/daemon` (scheduler), `cmd/tracker` (dispatch). Spec: `docs/superpowers/specs/2026-07-03-hiscores-collector-design.md` (rev 5).

**Tech Stack:** Go ≥1.23, `modernc.org/sqlite` (pure Go, no cgo), stdlib `testing` + `httptest`. No other dependencies.

## Global Constraints

- Module path: `github.com/MattGould1/2004tracker`
- Only external dependency: `modernc.org/sqlite`
- Small files: one exported function/concern per file, matching `_test.go` beside it
- Store `value` raw (XP × 10) — never divide before storage
- All DB timestamps: UTC RFC3339 strings
- Default rate cap **0.5 req/s**; 429 halves the cap for the remainder of the process
- Cached mode = bare URL; fresh mode = unique `_cb` query param per request
- Skill type codes: 0–18 and 21 (19–20 do not exist)
- Commit after every task (repo git identity already set to MattGould1)
- **Plan deviation from spec, agreed rationale:** full discovery stops only on a short/empty page (never on "all known") — otherwise weekly full scans would terminate at page 2 and miss mid-list entrants. Tail discovery starts ~5 pages from the end.

---

### Task 1: Module scaffold + skill map

**Files:**
- Create: `go.mod`, `internal/api/skills.go`
- Test: `internal/api/skills_test.go`

**Interfaces:**
- Produces: `api.SkillName(t int) (string, bool)`, `api.SkillTypes() []int`, `api.XP(value int64) int64`

- [ ] **Step 1: Init module**

```bash
cd /Users/matthewgould/Projects/2004tracker
go mod init github.com/MattGould1/2004tracker
```

- [ ] **Step 2: Write the failing test**

`internal/api/skills_test.go`:

```go
package api

import "testing"

func TestSkillName(t *testing.T) {
	cases := map[int]string{0: "Overall", 1: "Attack", 18: "Thieving", 21: "Runecrafting"}
	for code, want := range cases {
		got, ok := SkillName(code)
		if !ok || got != want {
			t.Errorf("SkillName(%d) = %q, %v; want %q, true", code, got, ok, want)
		}
	}
	for _, gap := range []int{19, 20, 22, -1} {
		if _, ok := SkillName(gap); ok {
			t.Errorf("SkillName(%d) should not exist", gap)
		}
	}
}

func TestSkillTypes(t *testing.T) {
	types := SkillTypes()
	if len(types) != 20 {
		t.Fatalf("want 20 skill types, got %d", len(types))
	}
	if types[0] != 0 || types[19] != 21 {
		t.Errorf("types must be sorted 0..18,21; got first=%d last=%d", types[0], types[19])
	}
}

func TestXP(t *testing.T) {
	if got := XP(498679606); got != 49867960 {
		t.Errorf("XP(498679606) = %d; want 49867960", got)
	}
	if got := XP(9); got != 0 {
		t.Errorf("XP(9) = %d; want 0 (truncate)", got)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/api/`
Expected: FAIL (undefined: SkillName)

- [ ] **Step 4: Write implementation**

`internal/api/skills.go`:

```go
// Package api is the 2004scape (lostcity.rs) hiscores API client.
package api

import "sort"

var skillNames = map[int]string{
	0: "Overall", 1: "Attack", 2: "Defence", 3: "Strength", 4: "Hitpoints",
	5: "Ranged", 6: "Prayer", 7: "Magic", 8: "Cooking", 9: "Woodcutting",
	10: "Fletching", 11: "Fishing", 12: "Firemaking", 13: "Crafting",
	14: "Smithing", 15: "Mining", 16: "Herblore", 17: "Agility",
	18: "Thieving", 21: "Runecrafting", // 19-20 do not exist in the API
}

// SkillName returns the display name for an API skill type code.
func SkillName(t int) (string, bool) {
	name, ok := skillNames[t]
	return name, ok
}

// SkillTypes returns all valid type codes in ascending order.
func SkillTypes() []int {
	types := make([]int, 0, len(skillNames))
	for t := range skillNames {
		types = append(types, t)
	}
	sort.Ints(types)
	return types
}

// XP converts a raw API value (XP * 10) to whole XP, truncating.
func XP(value int64) int64 { return value / 10 }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/api/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add go.mod internal/api/
git commit -m "feat: module scaffold and skill type map"
```

---

### Task 2: Throttle (cap + adaptive halving)

**Files:**
- Create: `internal/api/throttle.go`
- Test: `internal/api/throttle_test.go`

**Interfaces:**
- Produces: `api.NewThrottle(reqPerSec float64) *Throttle`, `(*Throttle).Wait(ctx context.Context) error`, `(*Throttle).Halve()`, `(*Throttle).Interval() time.Duration`

- [ ] **Step 1: Write the failing test**

`internal/api/throttle_test.go`:

```go
package api

import (
	"context"
	"testing"
	"time"
)

func TestThrottleSpacesRequests(t *testing.T) {
	th := NewThrottle(100) // 10ms interval — fast enough for tests
	ctx := context.Background()
	start := time.Now()
	for i := 0; i < 4; i++ {
		if err := th.Wait(ctx); err != nil {
			t.Fatal(err)
		}
	}
	// 4 requests at 10ms spacing: first is immediate, so >= 30ms total.
	if elapsed := time.Since(start); elapsed < 30*time.Millisecond {
		t.Errorf("4 waits took %v; want >= 30ms", elapsed)
	}
}

func TestThrottleHalve(t *testing.T) {
	th := NewThrottle(2) // 500ms
	th.Halve()
	if got := th.Interval(); got != time.Second {
		t.Errorf("after Halve, interval = %v; want 1s", got)
	}
}

func TestThrottleRespectsContext(t *testing.T) {
	th := NewThrottle(0.001) // 1000s interval
	ctx := context.Background()
	if err := th.Wait(ctx); err != nil { // first is immediate
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if err := th.Wait(ctx); err != context.DeadlineExceeded {
		t.Errorf("Wait err = %v; want DeadlineExceeded", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run TestThrottle`
Expected: FAIL (undefined: NewThrottle)

- [ ] **Step 3: Write implementation**

`internal/api/throttle.go`:

```go
package api

import (
	"context"
	"sync"
	"time"
)

// Throttle is a shared rate limiter: every request in the process reserves
// the next available slot, so the cap can never be exceeded. Halve doubles
// the spacing permanently (the adaptive 429 response).
type Throttle struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time
}

func NewThrottle(reqPerSec float64) *Throttle {
	return &Throttle{interval: time.Duration(float64(time.Second) / reqPerSec)}
}

// Wait blocks until this caller's reserved slot arrives, or ctx is done.
func (t *Throttle) Wait(ctx context.Context) error {
	t.mu.Lock()
	now := time.Now()
	slot := t.next
	if slot.Before(now) {
		slot = now
	}
	t.next = slot.Add(t.interval)
	t.mu.Unlock()

	d := time.Until(slot)
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Halve doubles the interval for the remainder of the process.
func (t *Throttle) Halve() {
	t.mu.Lock()
	t.interval *= 2
	t.mu.Unlock()
}

func (t *Throttle) Interval() time.Duration {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.interval
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/ -run TestThrottle`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/throttle.go internal/api/throttle_test.go
git commit -m "feat: shared throttle with adaptive halving"
```

---

### Task 3: Client core (modes, retry, 429 handling)

**Files:**
- Create: `internal/api/client.go`
- Test: `internal/api/client_test.go`

**Interfaces:**
- Consumes: `NewThrottle`, `(*Throttle).Wait/Halve`
- Produces: `api.New(baseURL string, reqPerSec float64) *Client`, unexported `(*Client).get(ctx context.Context, path string, query url.Values, fresh bool) ([]byte, error)`. Field `sleep func(time.Duration)` (test seam, defaults to `time.Sleep`).

- [ ] **Step 1: Write the failing test**

`internal/api/client_test.go`:

```go
package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"
)

// newTestClient returns a fast client whose backoff sleeps are recorded, not real.
func newTestClient(serverURL string) (*Client, *[]time.Duration) {
	c := New(serverURL, 1000)
	var slept []time.Duration
	var mu sync.Mutex
	c.sleep = func(d time.Duration) { mu.Lock(); slept = append(slept, d); mu.Unlock() }
	return c, &slept
}

func TestCachedModeHasNoCacheBuster(t *testing.T) {
	var gotQuery url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.Query()
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	if _, err := c.get(context.Background(), "/api/x", nil, false); err != nil {
		t.Fatal(err)
	}
	if gotQuery.Get("_cb") != "" {
		t.Errorf("cached request must not carry _cb; got %q", gotQuery.Get("_cb"))
	}
}

func TestFreshModeCacheBusterIsUnique(t *testing.T) {
	seen := map[string]bool{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		cb := r.URL.Query().Get("_cb")
		if cb == "" {
			t.Error("fresh request missing _cb")
		}
		if seen[cb] {
			t.Errorf("_cb value %q reused", cb)
		}
		seen[cb] = true
		mu.Unlock()
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	for i := 0; i < 5; i++ {
		if _, err := c.get(context.Background(), "/api/x", nil, true); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRetryOn5xxThenSuccess(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(500)
			return
		}
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, slept := newTestClient(srv.URL)
	if _, err := c.get(context.Background(), "/api/x", nil, false); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Errorf("want 2 calls (1 retry), got %d", calls)
	}
	if len(*slept) != 1 || (*slept)[0] != 30*time.Second {
		t.Errorf("want one 30s backoff sleep, got %v", *slept)
	}
}

func Test5xxTwiceFails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	if _, err := c.get(context.Background(), "/api/x", nil, false); err == nil {
		t.Fatal("want error after second 5xx")
	}
}

func Test429HalvesCapAndSleeps60(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(429)
			return
		}
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, slept := newTestClient(srv.URL)
	before := c.throttle.Interval()
	if _, err := c.get(context.Background(), "/api/x", nil, false); err != nil {
		t.Fatal(err)
	}
	if got := c.throttle.Interval(); got != before*2 {
		t.Errorf("429 must halve cap: interval %v -> %v; want %v", before, got, before*2)
	}
	if len(*slept) != 1 || (*slept)[0] != 60*time.Second {
		t.Errorf("want one 60s sleep, got %v", *slept)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run 'TestCached|TestFresh|TestRetry|Test5xx|Test429'`
Expected: FAIL (undefined: New)

- [ ] **Step 3: Write implementation**

`internal/api/client.go`:

```go
package api

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Client talks to the hiscores API through a shared throttle.
//
// Two request modes (spec "Live API observations"): cached (bare URL, may be
// served by Cloudflare's ~15-min edge cache — fine for sweeps) and fresh
// (unique _cb param forces an origin hit — for records and on-demand).
type Client struct {
	baseURL  string
	http     *http.Client
	throttle *Throttle
	sleep    func(time.Duration) // test seam for backoff waits
	cbSeq    atomic.Int64
}

func New(baseURL string, reqPerSec float64) *Client {
	return &Client{
		baseURL:  strings.TrimRight(baseURL, "/"),
		http:     &http.Client{Timeout: 20 * time.Second},
		throttle: NewThrottle(reqPerSec),
		sleep:    time.Sleep,
	}
}

// cacheBuster returns a value never used before by this process.
func (c *Client) cacheBuster() string {
	return fmt.Sprintf("%d.%d", time.Now().UnixNano(), c.cbSeq.Add(1))
}

// get performs one throttled GET. Timeout/5xx: 30s backoff, one retry.
// 429: halve the cap for the rest of the process, 60s backoff, one retry.
func (c *Client) get(ctx context.Context, path string, query url.Values, fresh bool) ([]byte, error) {
	for attempt := 0; ; attempt++ {
		if err := c.throttle.Wait(ctx); err != nil {
			return nil, err
		}
		q := url.Values{}
		for k, vs := range query {
			q[k] = vs
		}
		if fresh {
			q.Set("_cb", c.cacheBuster())
		}
		u := c.baseURL + path
		if len(q) > 0 {
			u += "?" + q.Encode()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.http.Do(req)
		if err != nil {
			if attempt == 0 {
				log.Printf("api: %s failed (%v); retrying in 30s", path, err)
				c.sleep(30 * time.Second)
				continue
			}
			return nil, fmt.Errorf("GET %s: %w", path, err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		switch {
		case resp.StatusCode == http.StatusOK:
			if readErr != nil {
				return nil, fmt.Errorf("GET %s: reading body: %w", path, readErr)
			}
			return body, nil
		case resp.StatusCode == http.StatusTooManyRequests:
			// A 429 means our reading of their limits is wrong: get more
			// conservative for the remainder of the process, not just now.
			c.throttle.Halve()
			log.Printf("api: 429 on %s — halved cap to one request per %v", path, c.throttle.Interval())
			if attempt == 0 {
				c.sleep(60 * time.Second)
				continue
			}
			return nil, fmt.Errorf("GET %s: rate limited after retry", path)
		case resp.StatusCode >= 500:
			if attempt == 0 {
				log.Printf("api: %s returned %d; retrying in 30s", path, resp.StatusCode)
				c.sleep(30 * time.Second)
				continue
			}
			return nil, fmt.Errorf("GET %s: status %d after retry", path, resp.StatusCode)
		default:
			return nil, fmt.Errorf("GET %s: unexpected status %d", path, resp.StatusCode)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/`
Expected: PASS (all api tests)

- [ ] **Step 5: Commit**

```bash
git add internal/api/client.go internal/api/client_test.go
git commit -m "feat: api client with cached/fresh modes and adaptive backoff"
```

---

### Task 4: Category endpoint

**Files:**
- Create: `internal/api/category.go`
- Test: `internal/api/category_test.go`

**Interfaces:**
- Consumes: `(*Client).get`
- Produces: `api.CategoryEntry{Username string; Level int; Value int64; Rank int}`, `(*Client).Category(ctx context.Context, skillType, rank int, fresh bool) ([]CategoryEntry, error)`

- [ ] **Step 1: Write the failing test**

`internal/api/category_test.go`:

```go
package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCategoryParsesEntries(t *testing.T) {
	var gotPath, gotRank string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotRank = r.URL.Query().Get("rank")
		w.Write([]byte(`[{"username":"mogn","level":1840,"value":2504199746,"rank":1},
		                 {"username":"whoosh","level":1500,"value":498679606,"rank":2}]`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	entries, err := c.Category(context.Background(), 0, 21, false)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/hiscores/category/0" || gotRank != "21" {
		t.Errorf("bad request: path=%q rank=%q", gotPath, gotRank)
	}
	if len(entries) != 2 || entries[0].Username != "mogn" || entries[0].Value != 2504199746 {
		t.Errorf("bad parse: %+v", entries)
	}
}

func TestCategoryMalformedJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{not json`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	if _, err := c.Category(context.Background(), 0, 21, false); err == nil {
		t.Fatal("want parse error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run TestCategory`
Expected: FAIL (undefined: Category)

- [ ] **Step 3: Write implementation**

`internal/api/category.go`:

```go
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// CategoryEntry is one row of a hiscores leaderboard page.
// Note: the live API sends no "date" field despite the docs.
type CategoryEntry struct {
	Username string `json:"username"`
	Level    int    `json:"level"`
	Value    int64  `json:"value"` // raw XP*10
	Rank     int    `json:"rank"`
}

// Category fetches one leaderboard page: ?rank=N returns ranks N-20..N (21 rows).
func (c *Client) Category(ctx context.Context, skillType, rank int, fresh bool) ([]CategoryEntry, error) {
	q := url.Values{"rank": []string{strconv.Itoa(rank)}}
	body, err := c.get(ctx, fmt.Sprintf("/api/hiscores/category/%d", skillType), q, fresh)
	if err != nil {
		return nil, err
	}
	var entries []CategoryEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("category %d rank %d: bad JSON: %w", skillType, rank, err)
	}
	return entries, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/ -run TestCategory`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/category.go internal/api/category_test.go
git commit -m "feat: category endpoint"
```

---

### Task 5: Player endpoint

**Files:**
- Create: `internal/api/player.go`
- Test: `internal/api/player_test.go`

**Interfaces:**
- Consumes: `(*Client).get`
- Produces: `api.PlayerEntry{Type int; Level int; Value int64; Rank int}`, `(*Client).Player(ctx context.Context, username string, fresh bool) ([]PlayerEntry, error)`

- [ ] **Step 1: Write the failing test**

`internal/api/player_test.go`:

```go
package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPlayerParsesAndEscapes(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.EscapedPath()
		w.Write([]byte(`[{"type":0,"level":1500,"value":498679606,"rank":42},
		                 {"type":21,"level":50,"value":1017730,"rank":100}]`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	entries, err := c.Player(context.Background(), "iron man", false)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/hiscores/player/iron%20man" {
		t.Errorf("username must be path-escaped; got %q", gotPath)
	}
	if len(entries) != 2 || entries[1].Type != 21 || entries[1].Value != 1017730 {
		t.Errorf("bad parse: %+v", entries)
	}
}

func TestPlayerEmptyResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	c, _ := newTestClient(srv.URL)
	entries, err := c.Player(context.Background(), "ghost", false)
	if err != nil || len(entries) != 0 {
		t.Errorf("empty response is valid (not an error): entries=%v err=%v", entries, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/api/ -run TestPlayer`
Expected: FAIL (undefined: Player)

- [ ] **Step 3: Write implementation**

`internal/api/player.go`:

```go
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

// PlayerEntry is one skill row from the player endpoint.
type PlayerEntry struct {
	Type  int   `json:"type"`
	Level int   `json:"level"`
	Value int64 `json:"value"` // raw XP*10
	Rank  int   `json:"rank"`
}

// Player fetches all skill entries for one player. An empty slice is a valid
// result (the endpoint cannot confirm account existence).
func (c *Client) Player(ctx context.Context, username string, fresh bool) ([]PlayerEntry, error) {
	body, err := c.get(ctx, "/api/hiscores/player/"+url.PathEscape(username), nil, fresh)
	if err != nil {
		return nil, err
	}
	var entries []PlayerEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("player %s: bad JSON: %w", username, err)
	}
	return entries, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/api/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/player.go internal/api/player_test.go
git commit -m "feat: player endpoint"
```

---

### Task 6: Offset duration parser

**Files:**
- Create: `internal/dur/parse.go`
- Test: `internal/dur/parse_test.go`

**Interfaces:**
- Produces: `dur.Parse(s string) (time.Duration, error)` — units `h`, `d`(=24h), `w`(=7d), `mo`(=30d), `y`(=365d)

- [ ] **Step 1: Write the failing test**

`internal/dur/parse_test.go`:

```go
package dur

import (
	"testing"
	"time"
)

func TestParse(t *testing.T) {
	day := 24 * time.Hour
	cases := map[string]time.Duration{
		"6h": 6 * time.Hour, "24h": 24 * time.Hour, "3d": 3 * day,
		"1w": 7 * day, "1mo": 30 * day, "1y": 365 * day,
	}
	for in, want := range cases {
		got, err := Parse(in)
		if err != nil || got != want {
			t.Errorf("Parse(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	for _, in := range []string{"", "h", "5", "5m", "1.5h", "-6h", "6H", "1 mo"} {
		if _, err := Parse(in); err == nil {
			t.Errorf("Parse(%q) should fail", in)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/dur/`
Expected: FAIL (undefined: Parse)

- [ ] **Step 3: Write implementation**

`internal/dur/parse.go`:

```go
// Package dur parses record-cycle checkpoint offsets like "6h", "1w", "1mo".
// Go's time.ParseDuration stops at hours, so days and up need this.
package dur

import (
	"fmt"
	"regexp"
	"strconv"
	"time"
)

var pattern = regexp.MustCompile(`^(\d+)(h|d|w|mo|y)$`)

var unit = map[string]time.Duration{
	"h":  time.Hour,
	"d":  24 * time.Hour,
	"w":  7 * 24 * time.Hour,
	"mo": 30 * 24 * time.Hour,
	"y":  365 * 24 * time.Hour,
}

func Parse(s string) (time.Duration, error) {
	m := pattern.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("invalid offset %q (want e.g. 6h, 24h, 1w, 1mo, 1y)", s)
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid offset %q", s)
	}
	return time.Duration(n) * unit[m[2]], nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/dur/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/dur/
git commit -m "feat: checkpoint offset parser"
```

---

### Task 7: DB open + schema migration

**Files:**
- Create: `internal/db/db.go`, `internal/db/schema.sql`
- Test: `internal/db/db_test.go`

**Interfaces:**
- Produces: `db.Open(path string) (*DB, error)`, `(*DB).Close() error`. Struct `db.DB` holds the `*sql.DB` in unexported field `sql` (all queries go through methods added by later tasks). Also unexported helper `ts(t time.Time) string` (RFC3339 UTC) and `parseTS(s string) (time.Time, error)` used by every later db file.

- [ ] **Step 1: Get the driver**

```bash
go get modernc.org/sqlite
```

- [ ] **Step 2: Write the failing test**

`internal/db/db_test.go`:

```go
package db

import (
	"path/filepath"
	"testing"
	"time"
)

// openTest returns a DB backed by a temp file, closed on test cleanup.
func openTest(t *testing.T) *DB {
	t.Helper()
	d, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestOpenCreatesSchemaIdempotently(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")
	for i := 0; i < 2; i++ { // second Open must not fail on existing tables
		d, err := Open(path)
		if err != nil {
			t.Fatalf("Open #%d: %v", i+1, err)
		}
		for _, table := range []string{"players", "snapshots", "sweep_runs", "record_cycles"} {
			var n int
			err := d.sql.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&n)
			if err != nil || n != 1 {
				t.Errorf("table %s missing (n=%d, err=%v)", table, n, err)
			}
		}
		d.Close()
	}
}

func TestTimestampRoundTrip(t *testing.T) {
	now := time.Date(2026, 7, 4, 10, 30, 0, 0, time.UTC)
	got, err := parseTS(ts(now))
	if err != nil || !got.Equal(now) {
		t.Errorf("round trip: %v, %v; want %v", got, err, now)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/db/`
Expected: FAIL (undefined: Open)

- [ ] **Step 4: Write implementation**

`internal/db/schema.sql`:

```sql
-- Idempotent schema. Spec rev 5: append-only snapshots, no hiscore_date
-- (the live API exposes no date field).
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  player_id  INTEGER NOT NULL REFERENCES players(id),
  skill_type INTEGER NOT NULL,
  value      INTEGER NOT NULL,      -- raw XP*10
  level      INTEGER NOT NULL,
  rank       INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,         -- UTC RFC3339, ours
  source     TEXT NOT NULL          -- 'sweep' | 'update' | 'record'
);
CREATE INDEX IF NOT EXISTS idx_snapshots_player
  ON snapshots (player_id, skill_type, fetched_at);

CREATE TABLE IF NOT EXISTS sweep_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  discovery_mode  TEXT,             -- 'full' | 'tail'
  players_seen    INTEGER,
  players_fetched INTEGER,
  players_failed  INTEGER,
  requests        INTEGER
);

CREATE TABLE IF NOT EXISTS record_cycles (
  id                 INTEGER PRIMARY KEY,
  player_id          INTEGER NOT NULL REFERENCES players(id),
  started_at         TEXT NOT NULL,
  checkpoints        TEXT NOT NULL, -- JSON array, e.g. ["6h","24h","1w","1mo","1y"]
  next_checkpoint_ix INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL  -- 'active' | 'done' | 'cancelled'
);
```

`internal/db/db.go`:

```go
// Package db is the SQLite storage layer. One exported function per file.
package db

import (
	"database/sql"
	_ "embed"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

// DB wraps the SQLite handle; all access goes through methods in this package.
type DB struct {
	sql *sql.DB
}

func Open(path string) (*DB, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	h, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	// The collector is single-process; one connection avoids writer contention.
	h.SetMaxOpenConns(1)
	if _, err := h.Exec(schema); err != nil {
		h.Close()
		return nil, fmt.Errorf("migrate %s: %w", path, err)
	}
	return &DB{sql: h}, nil
}

func (d *DB) Close() error { return d.sql.Close() }

// ts formats a DB timestamp: UTC RFC3339, the only format this package stores.
func ts(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func parseTS(s string) (time.Time, error) { return time.Parse(time.RFC3339, s) }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/db/`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/db/
git commit -m "feat: sqlite storage with embedded idempotent schema"
```

---

### Task 8: UpsertPlayer + FindPlayer + ListPlayers + CountPlayers

**Files:**
- Create: `internal/db/upsert_player.go`, `internal/db/list_players.go`
- Test: `internal/db/upsert_player_test.go`, `internal/db/list_players_test.go`

**Interfaces:**
- Consumes: `openTest` helper, `ts`
- Produces: `(*DB).UpsertPlayer(username string, now time.Time) (id int64, created bool, err error)`; `db.Player{ID int64; Username string}`; `(*DB).FindPlayer(username string) (int64, bool, error)`; `(*DB).ListPlayers() ([]Player, error)`; `(*DB).CountPlayers() (int, error)`

- [ ] **Step 1: Write the failing tests**

`internal/db/upsert_player_test.go`:

```go
package db

import (
	"testing"
	"time"
)

func TestUpsertPlayer(t *testing.T) {
	d := openTest(t)
	t0 := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	t1 := t0.Add(24 * time.Hour)

	id, created, err := d.UpsertPlayer("Whoosh", t0)
	if err != nil || !created || id == 0 {
		t.Fatalf("first upsert: id=%d created=%v err=%v", id, created, err)
	}
	// Same player, different case: must update, not duplicate.
	id2, created2, err := d.UpsertPlayer("whoosh", t1)
	if err != nil || created2 || id2 != id {
		t.Fatalf("second upsert: id=%d created=%v err=%v (want id=%d, created=false)", id2, created2, err, id)
	}
	var firstSeen, lastSeen string
	if err := d.sql.QueryRow(`SELECT first_seen, last_seen FROM players WHERE id=?`, id).Scan(&firstSeen, &lastSeen); err != nil {
		t.Fatal(err)
	}
	if firstSeen != ts(t0) || lastSeen != ts(t1) {
		t.Errorf("first_seen=%s last_seen=%s; want %s / %s", firstSeen, lastSeen, ts(t0), ts(t1))
	}
}
```

`internal/db/list_players_test.go`:

```go
package db

import (
	"testing"
	"time"
)

func TestFindListCountPlayers(t *testing.T) {
	d := openTest(t)
	now := time.Now()
	idA, _, _ := d.UpsertPlayer("alpha", now)
	d.UpsertPlayer("beta", now)

	if id, ok, err := d.FindPlayer("ALPHA"); err != nil || !ok || id != idA {
		t.Errorf("FindPlayer(ALPHA) = %d, %v, %v; want %d, true", id, ok, err, idA)
	}
	if _, ok, err := d.FindPlayer("nobody"); err != nil || ok {
		t.Errorf("FindPlayer(nobody) ok=%v err=%v; want false, nil", ok, err)
	}
	players, err := d.ListPlayers()
	if err != nil || len(players) != 2 {
		t.Fatalf("ListPlayers: %v, %v", players, err)
	}
	if players[0].Username != "alpha" || players[0].ID != idA {
		t.Errorf("ListPlayers[0] = %+v", players[0])
	}
	if n, err := d.CountPlayers(); err != nil || n != 2 {
		t.Errorf("CountPlayers = %d, %v; want 2", n, err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/db/ -run 'TestUpsert|TestFindList'`
Expected: FAIL (undefined: UpsertPlayer)

- [ ] **Step 3: Write implementations**

`internal/db/upsert_player.go`:

```go
package db

import (
	"database/sql"
	"errors"
	"time"
)

// UpsertPlayer inserts a player or refreshes last_seen. Usernames are
// case-insensitive (COLLATE NOCASE). created reports whether the row is new.
func (d *DB) UpsertPlayer(username string, now time.Time) (int64, bool, error) {
	var id int64
	err := d.sql.QueryRow(`SELECT id FROM players WHERE username = ?`, username).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := d.sql.Exec(
			`INSERT INTO players (username, first_seen, last_seen) VALUES (?, ?, ?)`,
			username, ts(now), ts(now))
		if err != nil {
			return 0, false, err
		}
		id, err = res.LastInsertId()
		return id, true, err
	case err != nil:
		return 0, false, err
	default:
		_, err = d.sql.Exec(`UPDATE players SET last_seen = ? WHERE id = ?`, ts(now), id)
		return id, false, err
	}
}
```

`internal/db/list_players.go`:

```go
package db

import (
	"database/sql"
	"errors"
)

// Player is the identity row used by sweeps and lookups.
type Player struct {
	ID       int64
	Username string
}

// FindPlayer looks a player up by (case-insensitive) username.
func (d *DB) FindPlayer(username string) (int64, bool, error) {
	var id int64
	err := d.sql.QueryRow(`SELECT id FROM players WHERE username = ?`, username).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, err
}

// ListPlayers returns every known player, ordered by username.
func (d *DB) ListPlayers() ([]Player, error) {
	rows, err := d.sql.Query(`SELECT id, username FROM players ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var players []Player
	for rows.Next() {
		var p Player
		if err := rows.Scan(&p.ID, &p.Username); err != nil {
			return nil, err
		}
		players = append(players, p)
	}
	return players, rows.Err()
}

// CountPlayers returns the number of known players.
func (d *DB) CountPlayers() (int, error) {
	var n int
	err := d.sql.QueryRow(`SELECT count(*) FROM players`).Scan(&n)
	return n, err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/db/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/db/upsert_player.go internal/db/upsert_player_test.go internal/db/list_players.go internal/db/list_players_test.go
git commit -m "feat: player upsert and lookups"
```

---

### Task 9: InsertSnapshots + LatestFetch

**Files:**
- Create: `internal/db/insert_snapshots.go`, `internal/db/latest_fetch.go`
- Test: `internal/db/insert_snapshots_test.go`, `internal/db/latest_fetch_test.go`

**Interfaces:**
- Consumes: `api.PlayerEntry`, `UpsertPlayer`
- Produces: `(*DB).InsertSnapshots(playerID int64, entries []api.PlayerEntry, fetchedAt time.Time, source string) error`; `(*DB).LatestFetch(playerID int64) (time.Time, bool, error)`

- [ ] **Step 1: Write the failing tests**

`internal/db/insert_snapshots_test.go`:

```go
package db

import (
	"testing"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
)

func TestInsertSnapshots(t *testing.T) {
	d := openTest(t)
	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	id, _, _ := d.UpsertPlayer("whoosh", now)
	entries := []api.PlayerEntry{
		{Type: 0, Level: 1500, Value: 498679606, Rank: 42},
		{Type: 21, Level: 50, Value: 1017730, Rank: 100},
	}
	if err := d.InsertSnapshots(id, entries, now, "sweep"); err != nil {
		t.Fatal(err)
	}
	var n int
	var value int64
	var source string
	if err := d.sql.QueryRow(`SELECT count(*) FROM snapshots WHERE player_id=?`, id).Scan(&n); err != nil || n != 2 {
		t.Fatalf("want 2 rows, got %d (%v)", n, err)
	}
	err := d.sql.QueryRow(`SELECT value, source FROM snapshots WHERE player_id=? AND skill_type=21`, id).Scan(&value, &source)
	if err != nil || value != 1017730 || source != "sweep" {
		t.Errorf("row: value=%d source=%s err=%v", value, source, err)
	}
}
```

`internal/db/latest_fetch_test.go`:

```go
package db

import (
	"testing"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
)

func TestLatestFetch(t *testing.T) {
	d := openTest(t)
	t0 := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	t1 := t0.Add(time.Hour)
	id, _, _ := d.UpsertPlayer("whoosh", t0)

	if _, ok, err := d.LatestFetch(id); err != nil || ok {
		t.Fatalf("no snapshots yet: ok=%v err=%v; want false, nil", ok, err)
	}
	e := []api.PlayerEntry{{Type: 0, Level: 1, Value: 10, Rank: 1}}
	d.InsertSnapshots(id, e, t0, "sweep")
	d.InsertSnapshots(id, e, t1, "update")
	got, ok, err := d.LatestFetch(id)
	if err != nil || !ok || !got.Equal(t1) {
		t.Errorf("LatestFetch = %v, %v, %v; want %v, true, nil", got, ok, err, t1)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/db/ -run 'TestInsertSnapshots|TestLatestFetch'`
Expected: FAIL (undefined: InsertSnapshots)

- [ ] **Step 3: Write implementations**

`internal/db/insert_snapshots.go`:

```go
package db

import (
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
)

// InsertSnapshots appends one row per skill entry, all with the same
// fetched_at and source ('sweep' | 'update' | 'record'). Values stay raw XP*10.
func (d *DB) InsertSnapshots(playerID int64, entries []api.PlayerEntry, fetchedAt time.Time, source string) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.Prepare(
		`INSERT INTO snapshots (player_id, skill_type, value, level, rank, fetched_at, source)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, e := range entries {
		if _, err := stmt.Exec(playerID, e.Type, e.Value, e.Level, e.Rank, ts(fetchedAt), source); err != nil {
			return err
		}
	}
	return tx.Commit()
}
```

`internal/db/latest_fetch.go`:

```go
package db

import "time"

// LatestFetch returns the most recent snapshot time for a player.
// ok is false when the player has no snapshots. Powers the update cooldown.
func (d *DB) LatestFetch(playerID int64) (time.Time, bool, error) {
	var s *string
	err := d.sql.QueryRow(
		`SELECT max(fetched_at) FROM snapshots WHERE player_id = ?`, playerID).Scan(&s)
	if err != nil {
		return time.Time{}, false, err
	}
	if s == nil {
		return time.Time{}, false, nil
	}
	t, err := parseTS(*s)
	return t, err == nil, err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/db/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/db/insert_snapshots.go internal/db/insert_snapshots_test.go internal/db/latest_fetch.go internal/db/latest_fetch_test.go
git commit -m "feat: snapshot writes and latest-fetch lookup"
```

---

### Task 10: Sweep run bookkeeping

**Files:**
- Create: `internal/db/sweep_runs.go`
- Test: `internal/db/sweep_runs_test.go`

**Interfaces:**
- Produces: `db.SweepStats{Seen, Fetched, Failed, Requests int}`; `(*DB).StartSweepRun(now time.Time, mode string) (int64, error)`; `(*DB).FinishSweepRun(id int64, now time.Time, s SweepStats) error`; `(*DB).LastFullDiscovery() (time.Time, bool, error)`

- [ ] **Step 1: Write the failing test**

`internal/db/sweep_runs_test.go`:

```go
package db

import (
	"testing"
	"time"
)

func TestSweepRunLifecycle(t *testing.T) {
	d := openTest(t)
	t0 := time.Date(2026, 7, 4, 4, 0, 0, 0, time.UTC)

	if _, ok, err := d.LastFullDiscovery(); err != nil || ok {
		t.Fatalf("empty db: ok=%v err=%v; want false, nil", ok, err)
	}
	id, err := d.StartSweepRun(t0, "full")
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	// Unfinished runs don't count as a completed full discovery.
	if _, ok, _ := d.LastFullDiscovery(); ok {
		t.Fatal("unfinished run must not count")
	}
	stats := SweepStats{Seen: 100, Fetched: 98, Failed: 2, Requests: 110}
	if err := d.FinishSweepRun(id, t0.Add(time.Hour), stats); err != nil {
		t.Fatal(err)
	}
	got, ok, err := d.LastFullDiscovery()
	if err != nil || !ok || !got.Equal(t0) {
		t.Errorf("LastFullDiscovery = %v, %v, %v; want %v, true", got, ok, err, t0)
	}
	// A tail run never affects LastFullDiscovery.
	tid, _ := d.StartSweepRun(t0.Add(24*time.Hour), "tail")
	d.FinishSweepRun(tid, t0.Add(25*time.Hour), stats)
	if got, _, _ := d.LastFullDiscovery(); !got.Equal(t0) {
		t.Errorf("tail run changed LastFullDiscovery to %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/db/ -run TestSweepRun`
Expected: FAIL (undefined: StartSweepRun)

- [ ] **Step 3: Write implementation**

`internal/db/sweep_runs.go`:

```go
package db

import (
	"database/sql"
	"errors"
	"time"
)

// SweepStats summarizes one sweep for the sweep_runs audit row.
type SweepStats struct {
	Seen     int // entries seen during discovery
	Fetched  int // players successfully snapshotted
	Failed   int // players whose fetch errored
	Requests int // total API requests made
}

func (d *DB) StartSweepRun(now time.Time, mode string) (int64, error) {
	res, err := d.sql.Exec(
		`INSERT INTO sweep_runs (started_at, discovery_mode) VALUES (?, ?)`, ts(now), mode)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (d *DB) FinishSweepRun(id int64, now time.Time, s SweepStats) error {
	_, err := d.sql.Exec(
		`UPDATE sweep_runs SET finished_at=?, players_seen=?, players_fetched=?, players_failed=?, requests=?
		 WHERE id=?`,
		ts(now), s.Seen, s.Fetched, s.Failed, s.Requests, id)
	return err
}

// LastFullDiscovery returns when the most recent *completed* full-discovery
// sweep started. Decides whether the weekly full pass is due.
func (d *DB) LastFullDiscovery() (time.Time, bool, error) {
	var s string
	err := d.sql.QueryRow(
		`SELECT started_at FROM sweep_runs
		 WHERE discovery_mode='full' AND finished_at IS NOT NULL
		 ORDER BY started_at DESC LIMIT 1`).Scan(&s)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, false, nil
	}
	if err != nil {
		return time.Time{}, false, err
	}
	t, err := parseTS(s)
	return t, err == nil, err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/db/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/db/sweep_runs.go internal/db/sweep_runs_test.go
git commit -m "feat: sweep run bookkeeping"
```

---

### Task 11: Record cycle storage

**Files:**
- Create: `internal/db/record_cycles.go`
- Test: `internal/db/record_cycles_test.go`

**Interfaces:**
- Consumes: `dur.Parse`, `UpsertPlayer`
- Produces: `db.Cycle{ID, PlayerID int64; Username string; StartedAt time.Time; Offsets []string; NextIx int}`; `(*DB).StartCycle(playerID int64, now time.Time, offsets []string) (int64, error)` (cancels any active cycle for the player); `(*DB).ActiveCycle(playerID int64) (Cycle, bool, error)`; `(*DB).DueCycles(now time.Time) ([]Cycle, error)`; `(*DB).AdvanceCycle(c Cycle) error`

- [ ] **Step 1: Write the failing test**

`internal/db/record_cycles_test.go`:

```go
package db

import (
	"testing"
	"time"
)

func TestCycleLifecycle(t *testing.T) {
	d := openTest(t)
	t0 := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	id, _, _ := d.UpsertPlayer("whoosh", t0)

	cid, err := d.StartCycle(id, t0, []string{"6h", "24h"})
	if err != nil || cid == 0 {
		t.Fatal(err)
	}
	// Not due before the first offset.
	if due, err := d.DueCycles(t0.Add(5 * time.Hour)); err != nil || len(due) != 0 {
		t.Fatalf("nothing due at +5h: %v, %v", due, err)
	}
	// Due at +6h, carrying username and parse-ready state.
	due, err := d.DueCycles(t0.Add(6 * time.Hour))
	if err != nil || len(due) != 1 {
		t.Fatalf("want 1 due at +6h: %v, %v", due, err)
	}
	c := due[0]
	if c.Username != "whoosh" || c.NextIx != 0 || len(c.Offsets) != 2 {
		t.Errorf("bad cycle: %+v", c)
	}
	// Advance past checkpoint 0 → next due at +24h.
	if err := d.AdvanceCycle(c); err != nil {
		t.Fatal(err)
	}
	if due, _ := d.DueCycles(t0.Add(7 * time.Hour)); len(due) != 0 {
		t.Error("checkpoint 1 must not be due at +7h")
	}
	due, _ = d.DueCycles(t0.Add(24 * time.Hour))
	if len(due) != 1 || due[0].NextIx != 1 {
		t.Fatalf("want checkpoint 1 due at +24h: %v", due)
	}
	// Advancing past the last checkpoint completes the cycle.
	if err := d.AdvanceCycle(due[0]); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := d.ActiveCycle(id); ok {
		t.Error("cycle should be done")
	}
	if due, _ := d.DueCycles(t0.Add(1000 * time.Hour)); len(due) != 0 {
		t.Error("done cycles are never due")
	}
}

func TestStartCycleCancelsActive(t *testing.T) {
	d := openTest(t)
	t0 := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	id, _, _ := d.UpsertPlayer("whoosh", t0)
	first, _ := d.StartCycle(id, t0, []string{"6h"})
	second, err := d.StartCycle(id, t0.Add(time.Hour), []string{"24h"})
	if err != nil || second == first {
		t.Fatal(err)
	}
	c, ok, err := d.ActiveCycle(id)
	if err != nil || !ok || c.ID != second {
		t.Errorf("active cycle = %+v, %v, %v; want id %d", c, ok, err, second)
	}
	var status string
	d.sql.QueryRow(`SELECT status FROM record_cycles WHERE id=?`, first).Scan(&status)
	if status != "cancelled" {
		t.Errorf("first cycle status = %s; want cancelled", status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/db/ -run 'TestCycle|TestStartCycle'`
Expected: FAIL (undefined: StartCycle)

- [ ] **Step 3: Write implementation**

`internal/db/record_cycles.go`:

```go
package db

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/MattGould1/2004tracker/internal/dur"
)

// Cycle is an active record cycle joined with its player's username.
type Cycle struct {
	ID        int64
	PlayerID  int64
	Username  string
	StartedAt time.Time
	Offsets   []string // checkpoint offsets from StartedAt, e.g. ["6h","24h"]
	NextIx    int      // index into Offsets of the next checkpoint to fire
}

// StartCycle cancels any active cycle for the player and starts a new one.
// Offsets must already be validated with dur.Parse by the caller.
func (d *DB) StartCycle(playerID int64, now time.Time, offsets []string) (int64, error) {
	if len(offsets) == 0 {
		return 0, errors.New("cycle needs at least one checkpoint offset")
	}
	cj, err := json.Marshal(offsets)
	if err != nil {
		return 0, err
	}
	if _, err := d.sql.Exec(
		`UPDATE record_cycles SET status='cancelled' WHERE player_id=? AND status='active'`,
		playerID); err != nil {
		return 0, err
	}
	res, err := d.sql.Exec(
		`INSERT INTO record_cycles (player_id, started_at, checkpoints, next_checkpoint_ix, status)
		 VALUES (?, ?, ?, 0, 'active')`,
		playerID, ts(now), string(cj))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ActiveCycle returns the player's active cycle, if any.
func (d *DB) ActiveCycle(playerID int64) (Cycle, bool, error) {
	cycles, err := d.queryCycles(`AND c.player_id = ?`, playerID)
	if err != nil || len(cycles) == 0 {
		return Cycle{}, false, err
	}
	return cycles[0], true, nil
}

// DueCycles returns active cycles whose next checkpoint time has passed.
// Missed checkpoints (daemon downtime) are naturally due immediately.
func (d *DB) DueCycles(now time.Time) ([]Cycle, error) {
	cycles, err := d.queryCycles(``)
	if err != nil {
		return nil, err
	}
	var due []Cycle
	for _, c := range cycles {
		off, err := dur.Parse(c.Offsets[c.NextIx])
		if err != nil {
			return nil, fmt.Errorf("cycle %d has bad offset %q: %w", c.ID, c.Offsets[c.NextIx], err)
		}
		if !c.StartedAt.Add(off).After(now) {
			due = append(due, c)
		}
	}
	return due, nil
}

// AdvanceCycle moves past the current checkpoint, completing the cycle when
// it was the last one.
func (d *DB) AdvanceCycle(c Cycle) error {
	next := c.NextIx + 1
	if next >= len(c.Offsets) {
		_, err := d.sql.Exec(
			`UPDATE record_cycles SET status='done', next_checkpoint_ix=? WHERE id=?`, next, c.ID)
		return err
	}
	_, err := d.sql.Exec(
		`UPDATE record_cycles SET next_checkpoint_ix=? WHERE id=?`, next, c.ID)
	return err
}

func (d *DB) queryCycles(extraWhere string, args ...any) ([]Cycle, error) {
	rows, err := d.sql.Query(
		`SELECT c.id, c.player_id, p.username, c.started_at, c.checkpoints, c.next_checkpoint_ix
		 FROM record_cycles c JOIN players p ON p.id = c.player_id
		 WHERE c.status = 'active' `+extraWhere, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cycles []Cycle
	for rows.Next() {
		var c Cycle
		var started, checkpoints string
		if err := rows.Scan(&c.ID, &c.PlayerID, &c.Username, &started, &checkpoints, &c.NextIx); err != nil {
			return nil, err
		}
		if c.StartedAt, err = parseTS(started); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(checkpoints), &c.Offsets); err != nil {
			return nil, err
		}
		cycles = append(cycles, c)
	}
	return cycles, rows.Err()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/db/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/db/record_cycles.go internal/db/record_cycles_test.go
git commit -m "feat: record cycle storage"
```

---

### Task 12: Discovery (full + tail)

**Files:**
- Create: `internal/sweep/discovery.go`
- Test: `internal/sweep/discovery_test.go`

**Interfaces:**
- Consumes: `(*api.Client).Category`, `(*db.DB).UpsertPlayer`, `(*db.DB).CountPlayers`
- Produces: `sweep.Sweeper{API *api.Client; DB *db.DB; Spread time.Duration; MaxPages int; Now func() time.Time}`; method `(*Sweeper).discover(ctx context.Context, mode string) (seen, requests int, err error)`. Constructor `sweep.New(a *api.Client, d *db.DB, spread time.Duration, maxPages int) *Sweeper` (Now defaults to `time.Now`).

- [ ] **Step 1: Write the failing test**

`internal/sweep/discovery_test.go`:

```go
package sweep

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
)

// fakeHiscores serves a deterministic population of n players.
// Player i (1-based rank) is named "player<i>". Also serves player detail.
type fakeHiscores struct{ n int }

func (f fakeHiscores) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/hiscores/category/0", func(w http.ResponseWriter, r *http.Request) {
		rank, _ := strconv.Atoi(r.URL.Query().Get("rank"))
		var page []map[string]any
		for i := rank - 20; i <= rank && i <= f.n; i++ {
			if i < 1 {
				continue
			}
			page = append(page, map[string]any{
				"username": fmt.Sprintf("player%d", i),
				"level":    2000 - i, "value": 1000000 - i*10, "rank": i,
			})
		}
		json.NewEncoder(w).Encode(page)
	})
	mux.HandleFunc("/api/hiscores/player/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]any{
			{"type": 0, "level": 100, "value": 12345, "rank": 1},
			{"type": 1, "level": 50, "value": 6789, "rank": 2},
		})
	})
	return mux
}

func newTestSweeper(t *testing.T, n int) (*Sweeper, *db.DB) {
	t.Helper()
	srv := httptest.NewServer(fakeHiscores{n: n}.handler())
	t.Cleanup(srv.Close)
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	s := New(api.New(srv.URL, 10000), d, 0, 0)
	s.Now = func() time.Time { return time.Date(2026, 7, 4, 4, 0, 0, 0, time.UTC) }
	return s, d
}

func TestFullDiscoveryWalksEverything(t *testing.T) {
	s, d := newTestSweeper(t, 50) // pages: 21 + 21 + 8
	seen, requests, err := s.discover(context.Background(), "full")
	if err != nil {
		t.Fatal(err)
	}
	if seen != 50 || requests != 3 {
		t.Errorf("seen=%d requests=%d; want 50, 3", seen, requests)
	}
	if n, _ := d.CountPlayers(); n != 50 {
		t.Errorf("CountPlayers = %d; want 50", n)
	}
	// Second full run: still walks all pages (never early-stops on known players).
	_, requests2, _ := s.discover(context.Background(), "full")
	if requests2 != 3 {
		t.Errorf("second full run requests=%d; want 3", requests2)
	}
	if n, _ := d.CountPlayers(); n != 50 {
		t.Errorf("re-discovery duplicated players: %d", n)
	}
}

func TestTailDiscoveryScansEnd(t *testing.T) {
	s, d := newTestSweeper(t, 200) // 10 pages of 21 = 210 slots; short page at rank 210
	if _, _, err := s.discover(context.Background(), "full"); err != nil {
		t.Fatal(err)
	}
	_, requests, err := s.discover(context.Background(), "tail")
	if err != nil {
		t.Fatal(err)
	}
	// 200 known → 9 full pages known; tail starts 5 pages back → ~6 requests, far fewer than 10.
	if requests > 7 {
		t.Errorf("tail scan made %d requests; want <= 7", requests)
	}
	if n, _ := d.CountPlayers(); n != 200 {
		t.Errorf("CountPlayers = %d; want 200", n)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/sweep/`
Expected: FAIL (undefined: New / Sweeper)

- [ ] **Step 3: Write implementation**

`internal/sweep/discovery.go`:

```go
// Package sweep orchestrates discovery and the daily full-population sweep.
package sweep

import (
	"context"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
)

const pageSize = 21

// Sweeper runs discovery and daily sweeps. Now is a test seam.
type Sweeper struct {
	API      *api.Client
	DB       *db.DB
	Spread   time.Duration // window to spread player fetches over
	MaxPages int           // 0 = unlimited (smoke-test cap)
	Now      func() time.Time
}

func New(a *api.Client, d *db.DB, spread time.Duration, maxPages int) *Sweeper {
	return &Sweeper{API: a, DB: d, Spread: spread, MaxPages: maxPages, Now: time.Now}
}

// discover walks Overall (type 0) leaderboard pages, upserting every player.
//
// mode "full": walk from rank 21 until a short/empty page. Never early-stops
// on already-known players — the weekly full pass exists to catch mid-list
// entrants (plan deviation from spec, agreed).
// mode "tail": new players enter at the bottom of the rank-sorted list, so
// start ~5 pages before the known end and walk until a short page.
func (s *Sweeper) discover(ctx context.Context, mode string) (seen, requests int, err error) {
	startRank := pageSize
	if mode == "tail" {
		n, err := s.DB.CountPlayers()
		if err != nil {
			return 0, 0, err
		}
		startPage := n/pageSize - 5
		if startPage < 0 {
			startPage = 0
		}
		startRank = startPage*pageSize + pageSize
	}
	for rank, page := startRank, 1; ; rank, page = rank+pageSize, page+1 {
		if s.MaxPages > 0 && page > s.MaxPages {
			return seen, requests, nil
		}
		entries, err := s.API.Category(ctx, 0, rank, false) // cached mode: sweeps tolerate ~15 min staleness
		requests++
		if err != nil {
			return seen, requests, err
		}
		for _, e := range entries {
			if _, _, err := s.DB.UpsertPlayer(e.Username, s.Now()); err != nil {
				return seen, requests, err
			}
			seen++
		}
		if len(entries) < pageSize {
			return seen, requests, nil
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/sweep/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/sweep/
git commit -m "feat: full and tail discovery"
```

---

### Task 13: Sweep orchestration

**Files:**
- Create: `internal/sweep/sweep.go`
- Test: `internal/sweep/sweep_test.go`

**Interfaces:**
- Consumes: `discover`, `(*api.Client).Player`, `(*db.DB).ListPlayers/InsertSnapshots/StartSweepRun/FinishSweepRun/LastFullDiscovery`
- Produces: `(*Sweeper).Run(ctx context.Context) (db.SweepStats, error)` — picks full discovery when none completed in the last 7 days, else tail; fetches every known player in cached mode, paced across `Spread`; logs one summary line.

- [ ] **Step 1: Write the failing test**

`internal/sweep/sweep_test.go`:

```go
package sweep

import (
	"context"
	"testing"
	"time"
)

func TestRunSweepsEveryPlayer(t *testing.T) {
	s, d := newTestSweeper(t, 30) // 2 pages (21 + 9)
	stats, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// 2 discovery requests + 30 player fetches.
	if stats.Seen != 30 || stats.Fetched != 30 || stats.Failed != 0 || stats.Requests != 32 {
		t.Errorf("stats = %+v; want Seen 30 Fetched 30 Failed 0 Requests 32", stats)
	}
	// First run must be a full discovery and be recorded as completed.
	if _, ok, err := d.LastFullDiscovery(); err != nil || !ok {
		t.Errorf("full discovery not recorded: %v", err)
	}
	// 30 players x 2 skills per fake response = 60 snapshot rows.
	players, _ := d.ListPlayers()
	if len(players) != 30 {
		t.Fatalf("want 30 players, got %d", len(players))
	}
	last, ok, err := d.LatestFetchForTest(players[0].ID)
	if err != nil || !ok {
		t.Fatalf("player has no snapshots: %v %v", ok, err)
	}
	if !last.Equal(s.Now()) {
		t.Errorf("snapshot fetched_at = %v; want %v", last, s.Now())
	}
}

func TestSecondRunUsesTail(t *testing.T) {
	s, _ := newTestSweeper(t, 30)
	if _, err := s.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	// One day later (well within 7 days): must pick tail mode.
	base := s.Now()
	s.Now = func() time.Time { return base.Add(24 * time.Hour) }
	stats, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Tail over 30 players starts at page 0 (30/21-5 < 0) → same 2 pages here,
	// but mode must be recorded as tail.
	mode, err := s.DB.LastSweepModeForTest()
	if err != nil || mode != "tail" {
		t.Errorf("second run mode = %q, %v; want tail", mode, err)
	}
	if stats.Fetched != 30 {
		t.Errorf("tail run fetched %d; want 30", stats.Fetched)
	}
}
```

Add the two test-only helpers to the db package in `internal/db/testhelpers.go` (exported, clearly named, used only from tests):

```go
package db

// Test-support lookups. Not part of the storage API proper; kept tiny and
// exported so other packages' tests can assert on stored state.

import "time"

// LatestFetchForTest mirrors LatestFetch for cross-package tests.
func (d *DB) LatestFetchForTest(playerID int64) (time.Time, bool, error) {
	return d.LatestFetch(playerID)
}

// LastSweepModeForTest returns discovery_mode of the most recent sweep run.
func (d *DB) LastSweepModeForTest() (string, error) {
	var mode string
	err := d.sql.QueryRow(
		`SELECT discovery_mode FROM sweep_runs ORDER BY id DESC LIMIT 1`).Scan(&mode)
	return mode, err
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/sweep/ -run TestRun`
Expected: FAIL (undefined: Run)

- [ ] **Step 3: Write implementation**

`internal/sweep/sweep.go`:

```go
package sweep

import (
	"context"
	"log"
	"time"

	"github.com/MattGould1/2004tracker/internal/db"
)

const fullDiscoveryEvery = 7 * 24 * time.Hour

// Run executes one sweep: discovery, then a cached-mode player fetch for
// every known player, paced evenly across s.Spread. One bad player never
// aborts the run.
func (s *Sweeper) Run(ctx context.Context) (db.SweepStats, error) {
	var stats db.SweepStats
	start := s.Now()

	mode := "tail"
	last, ok, err := s.DB.LastFullDiscovery()
	if err != nil {
		return stats, err
	}
	if !ok || start.Sub(last) >= fullDiscoveryEvery {
		mode = "full"
	}
	runID, err := s.DB.StartSweepRun(start, mode)
	if err != nil {
		return stats, err
	}

	seen, requests, err := s.discover(ctx, mode)
	stats.Seen, stats.Requests = seen, requests
	if err != nil {
		return stats, err
	}

	players, err := s.DB.ListPlayers()
	if err != nil {
		return stats, err
	}
	var interval time.Duration
	if len(players) > 0 {
		interval = s.Spread / time.Duration(len(players))
	}
	for _, p := range players {
		if ctx.Err() != nil {
			break
		}
		fetchStart := time.Now()
		entries, err := s.API.Player(ctx, p.Username, false) // cached mode
		stats.Requests++
		switch {
		case err != nil:
			stats.Failed++
			log.Printf("sweep: %s failed: %v", p.Username, err)
		case len(entries) == 0:
			log.Printf("sweep: %s returned no data; skipping", p.Username)
		default:
			if err := s.DB.InsertSnapshots(p.ID, entries, s.Now(), "sweep"); err != nil {
				return stats, err // storage errors are fatal, API errors are not
			}
			stats.Fetched++
		}
		if wait := interval - time.Since(fetchStart); wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
			}
		}
	}

	if err := s.DB.FinishSweepRun(runID, s.Now(), stats); err != nil {
		return stats, err
	}
	log.Printf("sweep: mode=%s seen=%d fetched=%d failed=%d requests=%d duration=%s",
		mode, stats.Seen, stats.Fetched, stats.Failed, stats.Requests,
		time.Since(start).Round(time.Second))
	return stats, ctx.Err()
}
```

Note: the summary line computes duration with `time.Since(start)` where `start` came from `s.Now()`; in tests with a frozen clock this prints a nonsense duration but asserts nothing — acceptable.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/...`
Expected: PASS (all packages)

- [ ] **Step 5: Commit**

```bash
git add internal/sweep/sweep.go internal/sweep/sweep_test.go internal/db/testhelpers.go
git commit -m "feat: sweep orchestration with pacing and mode selection"
```

---

### Task 14: On-demand update command

**Files:**
- Create: `internal/app/update.go`
- Test: `internal/app/update_test.go`

**Interfaces:**
- Consumes: `(*db.DB).UpsertPlayer/LatestFetch/InsertSnapshots`, `(*api.Client).Player`
- Produces: `app.Update(ctx context.Context, c *api.Client, d *db.DB, username string, now time.Time) error`; `app.CooldownError{Remaining time.Duration}` implementing `error`; `app.UpdateCooldown = 5 * time.Minute`

- [ ] **Step 1: Write the failing test**

`internal/app/update_test.go`:

```go
package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
)

func testDeps(t *testing.T, playerJSON string) (*api.Client, *db.DB, *[]string) {
	t.Helper()
	var cbs []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cbs = append(cbs, r.URL.Query().Get("_cb"))
		w.Write([]byte(playerJSON))
	}))
	t.Cleanup(srv.Close)
	d, err := db.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	return api.New(srv.URL, 10000), d, &cbs
}

func TestUpdateFetchesFreshAndStores(t *testing.T) {
	c, d, cbs := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	if err := Update(context.Background(), c, d, "whoosh", now); err != nil {
		t.Fatal(err)
	}
	if len(*cbs) != 1 || (*cbs)[0] == "" {
		t.Errorf("update must use fresh mode (_cb set); got %v", *cbs)
	}
	id, ok, _ := d.FindPlayer("whoosh")
	if !ok {
		t.Fatal("player not created")
	}
	last, ok, _ := d.LatestFetchForTest(id)
	if !ok || !last.Equal(now) {
		t.Errorf("snapshot not stored at %v: %v %v", now, last, ok)
	}
}

func TestUpdateCooldown(t *testing.T) {
	c, d, _ := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	if err := Update(context.Background(), c, d, "whoosh", now); err != nil {
		t.Fatal(err)
	}
	err := Update(context.Background(), c, d, "whoosh", now.Add(2*time.Minute))
	var cd *CooldownError
	if !errors.As(err, &cd) {
		t.Fatalf("want CooldownError, got %v", err)
	}
	if cd.Remaining != 3*time.Minute {
		t.Errorf("Remaining = %v; want 3m", cd.Remaining)
	}
	// After the cooldown it works again.
	if err := Update(context.Background(), c, d, "whoosh", now.Add(6*time.Minute)); err != nil {
		t.Errorf("post-cooldown update failed: %v", err)
	}
}

func TestUpdateEmptyResponseIsError(t *testing.T) {
	c, d, _ := testDeps(t, `[]`)
	err := Update(context.Background(), c, d, "ghost", time.Now())
	if err == nil {
		t.Fatal("empty hiscores response must error for on-demand updates")
	}
}
```

(The test file's imports are: `context`, `errors`, `net/http`, `net/http/httptest`, `path/filepath`, `testing`, `time`, plus the two internal packages — no `encoding/json`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/app/`
Expected: FAIL (undefined: Update)

- [ ] **Step 3: Write implementation**

`internal/app/update.go`:

```go
// Package app implements the user-facing commands (update, record).
package app

import (
	"context"
	"fmt"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
)

// UpdateCooldown is the minimum gap between on-demand fetches per player.
// Hiscores only change ~5 min after logout, so refreshing faster is pointless.
const UpdateCooldown = 5 * time.Minute

// CooldownError reports how long until the next update is allowed.
type CooldownError struct {
	Remaining time.Duration
}

func (e *CooldownError) Error() string {
	return fmt.Sprintf("player was updated recently; try again in %s", e.Remaining.Round(time.Second))
}

// Update fetches one player in fresh mode and stores a snapshot.
func Update(ctx context.Context, c *api.Client, d *db.DB, username string, now time.Time) error {
	id, _, err := d.UpsertPlayer(username, now)
	if err != nil {
		return err
	}
	if last, ok, err := d.LatestFetch(id); err != nil {
		return err
	} else if ok && now.Sub(last) < UpdateCooldown {
		return &CooldownError{Remaining: UpdateCooldown - now.Sub(last)}
	}
	entries, err := c.Player(ctx, username, true) // fresh: accuracy matters here
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("no hiscores data for %q (unranked or not a player)", username)
	}
	return d.InsertSnapshots(id, entries, now, "update")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/app/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/app/
git commit -m "feat: on-demand update with cooldown"
```

---

### Task 15: Record commands (start, status, tick)

**Files:**
- Create: `internal/app/record_start.go`, `internal/app/record_status.go`, `internal/app/record_tick.go`
- Test: `internal/app/record_start_test.go`, `internal/app/record_status_test.go`, `internal/app/record_tick_test.go`

**Interfaces:**
- Consumes: `dur.Parse`, `(*db.DB).UpsertPlayer/InsertSnapshots/StartCycle/ActiveCycle/DueCycles/AdvanceCycle/FindPlayer`, `(*api.Client).Player`
- Produces: `app.RecordStart(ctx context.Context, c *api.Client, d *db.DB, username string, offsets []string, now time.Time) error`; `app.RecordStatus(d *db.DB, username string, now time.Time) (string, error)`; `app.RecordTick(ctx context.Context, c *api.Client, d *db.DB, now time.Time) (fired int, err error)`

- [ ] **Step 1: Write the failing tests**

`internal/app/record_start_test.go`:

```go
package app

import (
	"context"
	"testing"
	"time"
)

func TestRecordStartBaselinesAndCreatesCycle(t *testing.T) {
	c, d, cbs := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	if err := RecordStart(context.Background(), c, d, "whoosh", []string{"6h", "24h"}, now); err != nil {
		t.Fatal(err)
	}
	if len(*cbs) != 1 || (*cbs)[0] == "" {
		t.Error("baseline must be a fresh fetch")
	}
	id, _, _ := d.FindPlayer("whoosh")
	if _, ok, _ := d.ActiveCycle(id); !ok {
		t.Error("no active cycle created")
	}
	if last, ok, _ := d.LatestFetchForTest(id); !ok || !last.Equal(now) {
		t.Error("baseline snapshot missing")
	}
}

func TestRecordStartRejectsBadOffsets(t *testing.T) {
	c, d, cbs := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	err := RecordStart(context.Background(), c, d, "whoosh", []string{"6h", "5m"}, time.Now())
	if err == nil {
		t.Fatal("bad offset must fail before any network call")
	}
	if len(*cbs) != 0 {
		t.Error("no API call should happen on invalid offsets")
	}
}
```

`internal/app/record_status_test.go`:

```go
package app

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRecordStatus(t *testing.T) {
	c, d, _ := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	now := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)

	if _, err := RecordStatus(d, "whoosh", now); err == nil {
		t.Fatal("unknown player must error")
	}
	if err := RecordStart(context.Background(), c, d, "whoosh", []string{"6h", "24h"}, now); err != nil {
		t.Fatal(err)
	}
	out, err := RecordStatus(d, "whoosh", now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"whoosh", "6h", "24h", "next"} {
		if !strings.Contains(out, want) {
			t.Errorf("status output missing %q:\n%s", want, out)
		}
	}
}
```

`internal/app/record_tick_test.go`:

```go
package app

import (
	"context"
	"testing"
	"time"
)

func TestRecordTickFiresDueCheckpoints(t *testing.T) {
	c, d, cbs := testDeps(t, `[{"type":0,"level":10,"value":1000,"rank":5}]`)
	t0 := time.Date(2026, 7, 4, 12, 0, 0, 0, time.UTC)
	if err := RecordStart(context.Background(), c, d, "whoosh", []string{"6h", "24h"}, t0); err != nil {
		t.Fatal(err)
	}
	// Nothing due yet.
	if fired, err := RecordTick(context.Background(), c, d, t0.Add(time.Hour)); err != nil || fired != 0 {
		t.Fatalf("tick at +1h: fired=%d err=%v; want 0", fired, err)
	}
	// 6h checkpoint due (also covers missed-checkpoint catch-up: +7h > 6h).
	fired, err := RecordTick(context.Background(), c, d, t0.Add(7*time.Hour))
	if err != nil || fired != 1 {
		t.Fatalf("tick at +7h: fired=%d err=%v; want 1", fired, err)
	}
	if len(*cbs) != 2 { // baseline + checkpoint, both fresh
		t.Errorf("want 2 fresh calls total, got %d", len(*cbs))
	}
	// Final checkpoint completes the cycle.
	if fired, _ := RecordTick(context.Background(), c, d, t0.Add(25*time.Hour)); fired != 1 {
		t.Fatalf("tick at +25h fired %d; want 1", fired)
	}
	id, _, _ := d.FindPlayer("whoosh")
	if _, ok, _ := d.ActiveCycle(id); ok {
		t.Error("cycle should be done after last checkpoint")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/app/ -run TestRecord`
Expected: FAIL (undefined: RecordStart)

- [ ] **Step 3: Write implementations**

`internal/app/record_start.go`:

```go
package app

import (
	"context"
	"fmt"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
	"github.com/MattGould1/2004tracker/internal/dur"
)

// RecordStart validates offsets, takes an immediate fresh baseline snapshot,
// and opens a cycle (cancelling any active one for the player).
func RecordStart(ctx context.Context, c *api.Client, d *db.DB, username string, offsets []string, now time.Time) error {
	for _, o := range offsets {
		if _, err := dur.Parse(o); err != nil {
			return err
		}
	}
	id, _, err := d.UpsertPlayer(username, now)
	if err != nil {
		return err
	}
	entries, err := c.Player(ctx, username, true) // fresh baseline
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return fmt.Errorf("no hiscores data for %q; cannot start a record cycle", username)
	}
	if err := d.InsertSnapshots(id, entries, now, "record"); err != nil {
		return err
	}
	_, err = d.StartCycle(id, now, offsets)
	return err
}
```

`internal/app/record_status.go`:

```go
package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/MattGould1/2004tracker/internal/db"
	"github.com/MattGould1/2004tracker/internal/dur"
)

// RecordStatus renders a human-readable summary of a player's active cycle.
func RecordStatus(d *db.DB, username string, now time.Time) (string, error) {
	id, ok, err := d.FindPlayer(username)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("unknown player %q", username)
	}
	c, ok, err := d.ActiveCycle(id)
	if err != nil {
		return "", err
	}
	if !ok {
		return fmt.Sprintf("%s: no active record cycle", username), nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s: cycle started %s\n", c.Username, c.StartedAt.Format(time.RFC3339))
	for i, o := range c.Offsets {
		off, _ := dur.Parse(o) // validated at start
		at := c.StartedAt.Add(off)
		switch {
		case i < c.NextIx:
			fmt.Fprintf(&b, "  [done] %-4s at %s\n", o, at.Format(time.RFC3339))
		case i == c.NextIx:
			fmt.Fprintf(&b, "  [next] %-4s at %s (in %s)\n", o, at.Format(time.RFC3339), at.Sub(now).Round(time.Minute))
		default:
			fmt.Fprintf(&b, "  [    ] %-4s at %s\n", o, at.Format(time.RFC3339))
		}
	}
	return b.String(), nil
}
```

`internal/app/record_tick.go`:

```go
package app

import (
	"context"
	"log"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/db"
)

// RecordTick fires every due checkpoint: fresh fetch, snapshot, advance.
// Called by the daemon every 30s; missed checkpoints are due immediately.
// A failed fetch is logged and left due so the next tick retries it.
func RecordTick(ctx context.Context, c *api.Client, d *db.DB, now time.Time) (int, error) {
	due, err := d.DueCycles(now)
	if err != nil {
		return 0, err
	}
	fired := 0
	for _, cy := range due {
		entries, err := c.Player(ctx, cy.Username, true) // fresh: time-keeping accuracy
		if err != nil {
			log.Printf("record: checkpoint fetch for %s failed (will retry next tick): %v", cy.Username, err)
			continue
		}
		if len(entries) > 0 {
			if err := d.InsertSnapshots(cy.PlayerID, entries, now, "record"); err != nil {
				return fired, err
			}
		} else {
			log.Printf("record: %s returned no data at checkpoint; advancing anyway", cy.Username)
		}
		if err := d.AdvanceCycle(cy); err != nil {
			return fired, err
		}
		fired++
	}
	return fired, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/app/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/app/
git commit -m "feat: record cycle commands"
```

---

### Task 16: Daemon scheduler + main dispatch

**Files:**
- Create: `internal/daemon/daemon.go`, `cmd/tracker/main.go`
- Test: `internal/daemon/daemon_test.go`

**Interfaces:**
- Consumes: `sweep.Sweeper.Run`, `app.RecordTick`
- Produces: `daemon.NextSweepAt(now time.Time, hhmm string) (time.Time, error)`; `daemon.Run(ctx context.Context, s *sweep.Sweeper, c *api.Client, d *db.DB, sweepAt string, tickEvery time.Duration) error`. Binary subcommands: `daemon`, `sweep`, `update`, `record start`, `record status`.

- [ ] **Step 1: Write the failing test**

`internal/daemon/daemon_test.go`:

```go
package daemon

import (
	"testing"
	"time"
)

func TestNextSweepAt(t *testing.T) {
	loc := time.FixedZone("X", 0)
	now := time.Date(2026, 7, 4, 10, 0, 0, 0, loc)

	next, err := NextSweepAt(now, "04:00")
	if err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 7, 5, 4, 0, 0, 0, loc) // 04:00 already passed today
	if !next.Equal(want) {
		t.Errorf("NextSweepAt = %v; want %v", next, want)
	}

	next, _ = NextSweepAt(now, "23:30")
	want = time.Date(2026, 7, 4, 23, 30, 0, 0, loc) // still ahead today
	if !next.Equal(want) {
		t.Errorf("NextSweepAt = %v; want %v", next, want)
	}

	if _, err := NextSweepAt(now, "25:99"); err == nil {
		t.Error("invalid time must error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/daemon/`
Expected: FAIL (undefined: NextSweepAt)

- [ ] **Step 3: Write daemon implementation**

`internal/daemon/daemon.go`:

```go
// Package daemon is the long-running scheduler: a daily sweep plus a
// record-cycle tick, replacing any external cron.
package daemon

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/app"
	"github.com/MattGould1/2004tracker/internal/db"
	"github.com/MattGould1/2004tracker/internal/sweep"
)

// NextSweepAt returns the next occurrence of the local wall-clock time "HH:MM".
func NextSweepAt(now time.Time, hhmm string) (time.Time, error) {
	parsed, err := time.Parse("15:04", hhmm)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid -sweep-at %q: %w", hhmm, err)
	}
	next := time.Date(now.Year(), now.Month(), now.Day(),
		parsed.Hour(), parsed.Minute(), 0, 0, now.Location())
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next, nil
}

// Run blocks until ctx is cancelled, sweeping daily at sweepAt and firing
// due record checkpoints every tickEvery.
func Run(ctx context.Context, s *sweep.Sweeper, c *api.Client, d *db.DB, sweepAt string, tickEvery time.Duration) error {
	next, err := NextSweepAt(time.Now(), sweepAt)
	if err != nil {
		return err
	}
	log.Printf("daemon: next sweep at %s; record tick every %s", next.Format(time.RFC3339), tickEvery)

	sweepTimer := time.NewTimer(time.Until(next))
	defer sweepTimer.Stop()
	tick := time.NewTicker(tickEvery)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("daemon: shutting down")
			return nil
		case <-sweepTimer.C:
			if _, err := s.Run(ctx); err != nil && ctx.Err() == nil {
				log.Printf("daemon: sweep failed: %v", err)
			}
			next, _ = NextSweepAt(time.Now(), sweepAt)
			sweepTimer.Reset(time.Until(next))
			log.Printf("daemon: next sweep at %s", next.Format(time.RFC3339))
		case <-tick.C:
			if fired, err := app.RecordTick(ctx, c, d, time.Now()); err != nil && ctx.Err() == nil {
				log.Printf("daemon: record tick failed: %v", err)
			} else if fired > 0 {
				log.Printf("daemon: fired %d record checkpoint(s)", fired)
			}
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/daemon/`
Expected: PASS

- [ ] **Step 5: Write main dispatch**

`cmd/tracker/main.go`:

```go
// tracker is the 2004scape hiscores collector. Subcommands:
//
//	tracker daemon                     run the scheduler (daily sweep + record ticks)
//	tracker sweep                      run one sweep now
//	tracker update <username>          fetch one player now (5-min cooldown)
//	tracker record start <username>    start a record cycle
//	tracker record status <username>   show cycle progress
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/MattGould1/2004tracker/internal/api"
	"github.com/MattGould1/2004tracker/internal/app"
	"github.com/MattGould1/2004tracker/internal/daemon"
	"github.com/MattGould1/2004tracker/internal/db"
	"github.com/MattGould1/2004tracker/internal/sweep"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		var cd *app.CooldownError
		if errors.As(err, &cd) {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	fs := flag.NewFlagSet("tracker", flag.ExitOnError)
	dbPath := fs.String("db", "tracker.db", "SQLite database path")
	baseURL := fs.String("base-url", "https://2004.lostcity.rs", "hiscores API base URL")
	cap := fs.Float64("cap", 0.5, "request rate ceiling (req/s); origin limit is 1 per 2s")
	spread := fs.Duration("sweep-spread", 180*time.Minute, "window to spread sweep fetches over")
	sweepAt := fs.String("sweep-at", "04:00", "daily sweep time (local HH:MM)")
	maxPages := fs.Int("max-pages", 0, "cap discovery pages (0 = unlimited; smoke tests)")
	checkpoints := fs.String("checkpoints", "6h,24h,1w,1mo,1y", "record cycle checkpoint offsets")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "usage: tracker [flags] <daemon|sweep|update|record> [args]\n\n")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		fs.Usage()
		return errors.New("missing subcommand")
	}

	d, err := db.Open(*dbPath)
	if err != nil {
		return err
	}
	defer d.Close()
	client := api.New(*baseURL, *cap)
	sweeper := sweep.New(client, d, *spread, *maxPages)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd, rest := fs.Arg(0), fs.Args()[1:]; cmd {
	case "daemon":
		return daemon.Run(ctx, sweeper, client, d, *sweepAt, 30*time.Second)
	case "sweep":
		_, err := sweeper.Run(ctx)
		return err
	case "update":
		if len(rest) != 1 {
			return errors.New("usage: tracker update <username>")
		}
		return app.Update(ctx, client, d, rest[0], time.Now())
	case "record":
		if len(rest) < 2 {
			return errors.New("usage: tracker record <start|status> <username>")
		}
		switch rest[0] {
		case "start":
			return app.RecordStart(ctx, client, d, rest[1],
				strings.Split(*checkpoints, ","), time.Now())
		case "status":
			out, err := app.RecordStatus(d, rest[1], time.Now())
			if err != nil {
				return err
			}
			fmt.Print(out)
			return nil
		default:
			return fmt.Errorf("unknown record subcommand %q", rest[0])
		}
	default:
		return fmt.Errorf("unknown subcommand %q", cmd)
	}
}
```

- [ ] **Step 6: Build and smoke-test the binary**

```bash
go vet ./... && go build -o tracker ./cmd/tracker
./tracker            # expect usage + "missing subcommand", exit 1
./tracker sweep -h 2>/dev/null || true
```

Then one polite real-API smoke (≈2 requests at the default cap):

```bash
./tracker -max-pages 1 -sweep-spread 1s sweep
```

Expected: a `sweep: mode=full seen=21 ...` summary line and a `tracker.db` file. Note the run takes ~45s: `-max-pages 1` caps discovery at one page (21 players), but the sweep still fetches each of those 21 players, and 23 total requests at the default 0.5 req/s cap is ~46 seconds — let it finish. Then clean up: `rm -f tracker.db tracker.db-wal tracker.db-shm`.

- [ ] **Step 7: Add `.gitignore` and commit**

`.gitignore`:

```
tracker
tracker.db
tracker.db-wal
tracker.db-shm
```

```bash
git add .gitignore cmd/ internal/daemon/
git commit -m "feat: daemon scheduler and CLI dispatch"
```

---

### Task 17: EC2 provisioning script + README

**Files:**
- Create: `scripts/setup-ec2.sh`, `README.md`

**Interfaces:**
- Consumes: the built repo (script builds `cmd/tracker`)
- Produces: systemd service `tracker.service` running `tracker daemon`

- [ ] **Step 1: Write the script**

`scripts/setup-ec2.sh`:

```bash
#!/bin/bash
# Provision an EC2 instance (Amazon Linux 2023 / Ubuntu, arm64) to run the
# 2004tracker daemon under systemd. Run from the repo root on the instance:
#   git clone <repo> && cd 2004tracker && ./scripts/setup-ec2.sh
#
# Alternative (no Go on the server): build locally with
#   GOOS=linux GOARCH=arm64 go build -o tracker ./cmd/tracker
# scp the binary up, and reuse just the systemd unit below.
set -euo pipefail

GO_VERSION="1.23.4"
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64) GO_ARCH="arm64" ;;
  x86_64)  GO_ARCH="amd64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(whoami)"

if ! command -v go >/dev/null || ! go version | grep -q "go${GO_VERSION%.*}"; then
  echo "Installing Go ${GO_VERSION} (${GO_ARCH})..."
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" -o /tmp/go.tgz
  sudo rm -rf /usr/local/go
  sudo tar -C /usr/local -xzf /tmp/go.tgz
  rm /tmp/go.tgz
fi
export PATH="$PATH:/usr/local/go/bin"

echo "Building tracker..."
cd "$APP_DIR"
go build -o tracker ./cmd/tracker

echo "Installing systemd service..."
sudo tee /etc/systemd/system/tracker.service >/dev/null <<EOF
[Unit]
Description=2004tracker hiscores collector daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/tracker daemon
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now tracker.service
echo "Done. Follow logs with: journalctl -u tracker -f"
```

- [ ] **Step 2: Verify script syntax**

Run: `bash -n scripts/setup-ec2.sh && chmod +x scripts/setup-ec2.sh`
Expected: no output (clean parse)

- [ ] **Step 3: Write README**

`README.md`:

```markdown
# 2004tracker

A polite data collector for the [2004scape](https://2004.lostcity.rs) hiscores
API. One Go binary, SQLite storage, no UI.

## What it does

- **Daily sweep** (04:00 by default): discovers players from the Overall
  leaderboard and snapshots every known player's full skills, spread gently
  over ~3 hours.
- **On-demand updates**: `tracker update <username>` (5-minute cooldown).
- **Record cycles** for competitive players: `tracker record start <username>`
  takes a baseline now and checkpoint snapshots at 6h, 24h, 1w, 1mo, 1y.

## Being kind to the API

The measured origin limit is 1 request / 2 seconds; the client is capped at
0.5 req/s process-wide and gets *more* conservative (halves its cap) if it
ever sees a 429. Sweeps accept Cloudflare's ~15-min cache; only records and
on-demand updates bypass it. See
`docs/superpowers/specs/2026-07-03-hiscores-collector-design.md`.

## Run

```bash
go build -o tracker ./cmd/tracker
./tracker daemon           # scheduler: daily sweep + record checkpoints
./tracker sweep            # one sweep right now
./tracker update whoosh
./tracker record start whoosh
./tracker record status whoosh
```

Flags: `-db`, `-base-url`, `-cap`, `-sweep-spread`, `-sweep-at`, `-max-pages`,
`-checkpoints`. XP note: the API reports XP×10; `snapshots.value` stores it raw.

## Deploy (EC2)

```bash
./scripts/setup-ec2.sh     # installs Go, builds, enables systemd service
```

Back up `tracker.db` (e.g. Litestream to S3, or a periodic copy).

## Tests

```bash
go test ./...
```
```

- [ ] **Step 4: Full test suite + build check**

Run: `go vet ./... && go test ./... && go build ./...`
Expected: all PASS, clean build

- [ ] **Step 5: Commit**

```bash
git add scripts/ README.md
git commit -m "feat: EC2 provisioning script and README"
```

---

## Final verification (after all tasks)

- [ ] `go vet ./... && go test ./...` — everything passes
- [ ] `GOOS=linux GOARCH=arm64 go build -o /dev/null ./cmd/tracker` — cross-compiles clean (proves no cgo crept in)
- [ ] Polite live smoke: `./tracker -max-pages 1 -sweep-spread 1s -db /tmp/smoke.db sweep` → summary line, then inspect `sqlite3 /tmp/smoke.db 'select count(*) from snapshots'` (expect ~21 players × 20 skills ≈ 420 rows); delete the smoke DB
- [ ] `./tracker -db /tmp/smoke2.db update whoosh` then immediately again → second call exits 2 with cooldown message; delete smoke DB
```
