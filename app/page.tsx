"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchPlayer,
  hasChanged,
  RateLimitedError,
  totalValue,
  xp,
  type SkillEntry,
} from "@/lib/hiscores";
import {
  clearTrials,
  exportJSON,
  loadTrials,
  newTrialId,
  upsertTrial,
  userAgentHint,
  type Trial,
} from "@/lib/trials";

const POLL_MS = 15_000;
const TIMEOUT_MS = 30 * 60_000;
const SETTLE_POLL_MS = 30_000;
const SETTLE_REQUIRED_MS = 6 * 60_000; // > the ~5-min visibility cycle

type Step = "enter" | "settling" | "instruct" | "polling" | "result";

export default function Home() {
  const [step, setStep] = useState<Step>("enter");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<SkillEntry[] | null>(null);
  const [trial, setTrial] = useState<Trial | null>(null);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState(false);

  // Poll loop state lives in refs so the timeout closures stay current.
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef(POLL_MS);
  const trialRef = useRef<Trial | null>(null);
  const baselineRef = useRef<SkillEntry[] | null>(null);
  const settleStartRef = useRef<number>(0);
  const settledSecondsRef = useRef<number | null>(null);
  const [settledFor, setSettledFor] = useState(0);

  useEffect(() => setTrials(loadTrials()), []);
  useEffect(() => () => stopPolling(), []);

  // Smooth 1s tickers (the actual polls are 15-30s apart).
  useEffect(() => {
    if (step === "polling") {
      const tick = setInterval(() => {
        const t = trialRef.current;
        if (t) setElapsed(Math.round((Date.now() - Date.parse(t.loggedOutAt)) / 1000));
      }, 1000);
      return () => clearInterval(tick);
    }
    if (step === "settling") {
      const tick = setInterval(() => {
        setSettledFor(Math.round((Date.now() - settleStartRef.current) / 1000));
      }, 1000);
      return () => clearInterval(tick);
    }
  }, [step]);

  function stopPolling() {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }

  async function captureBaseline() {
    setBusy(true);
    setError(null);
    try {
      const entries = await fetchPlayer(name.trim());
      if (entries.length === 0) {
        setError(
          "No hiscores data for that name. Check the spelling — brand new accounts may not appear yet.",
        );
        return;
      }
      setBaseline(entries);
      baselineRef.current = entries;
      settleStartRef.current = Date.now();
      setSettledFor(0);
      setStep("settling");
      schedule(settlePoll, SETTLE_POLL_MS);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setBusy(false);
    }
  }

  // Settling phase: the trial may only start from a provably-quiet account.
  // Any value change here means an *earlier* logout was still becoming
  // visible — it silently becomes the new baseline and the clock restarts.
  // This prevents stale logouts from masquerading as the trial's landing.
  async function settlePoll() {
    if (!baselineRef.current) return;
    try {
      const current = await fetchPlayer(name.trim());
      if (current.length > 0 && hasChanged(baselineRef.current, current)) {
        setBaseline(current);
        baselineRef.current = current;
        settleStartRef.current = Date.now();
        setWarning(
          "A leftover update landed during the wait — baseline refreshed, settle timer restarted.",
        );
      }
    } catch {
      // Missed settle poll: fine, try again next tick.
    }
    const settledMs = Date.now() - settleStartRef.current;
    setSettledFor(Math.round(settledMs / 1000));
    if (settledMs >= SETTLE_REQUIRED_MS) {
      settledSecondsRef.current = Math.round(settledMs / 1000);
      setWarning(null);
      setStep("instruct");
      return;
    }
    schedule(settlePoll, SETTLE_POLL_MS);
  }

  async function loggedOutNow() {
    setBusy(true);
    setError(null);
    setWarning(null);
    const loggedOutAt = new Date();
    try {
      // Stale-baseline guard: if XP already moved between baseline capture
      // and this click, an earlier logout was still propagating. Restart so
      // the baseline is guaranteed to predate the logout being measured.
      const check = await fetchPlayer(name.trim());
      if (baselineRef.current && hasChanged(baselineRef.current, check)) {
        setBaseline(check);
        baselineRef.current = check;
        setWarning(
          "Your XP changed before you clicked — an earlier logout was still landing. " +
            "Baseline has been refreshed: log in, gain XP, log out, and click again.",
        );
        return;
      }
    } catch {
      // Couldn't verify; proceed with the original baseline.
    } finally {
      setBusy(false);
    }

    const t: Trial = {
      id: newTrialId(),
      player: name.trim(),
      loggedOutAt: loggedOutAt.toISOString(),
      landedAt: null,
      delaySeconds: null,
      xpGained: null,
      pollIntervalSeconds: POLL_MS / 1000,
      settledSeconds: settledSecondsRef.current,
      status: "abandoned", // upgraded on landing/timeout; stays if tab closes
      userAgentHint: userAgentHint(),
    };
    setTrial(t);
    trialRef.current = t;
    setTrials(upsertTrial(t));
    pollIntervalRef.current = POLL_MS;
    setElapsed(0);
    setStep("polling");
    // First poll a full interval out: the guard check above just hit the
    // origin, and its rate limit is 1 request per 2 seconds. (Propagation
    // takes minutes — an instant first check bought nothing and always 429'd.)
    schedule(poll, POLL_MS);
  }

  function schedule(fn: () => void, delay: number) {
    pollRef.current = setTimeout(fn, delay);
  }

  async function poll() {
    const t = trialRef.current;
    const base = baselineRef.current;
    if (!t || !base) return;
    const started = Date.parse(t.loggedOutAt);
    const now = Date.now();
    setElapsed(Math.round((now - started) / 1000));

    if (now - started > TIMEOUT_MS) {
      finishTrial({ ...t, status: "timeout" });
      return;
    }
    try {
      const current = await fetchPlayer(t.player);
      if (hasChanged(base, current)) {
        const landedAt = new Date();
        finishTrial({
          ...t,
          landedAt: landedAt.toISOString(),
          delaySeconds: Math.round((landedAt.getTime() - started) / 1000),
          xpGained: xp(totalValue(current)) - xp(totalValue(base)),
          status: "landed",
        });
        return;
      }
    } catch (e) {
      if (e instanceof RateLimitedError) {
        pollIntervalRef.current *= 2;
        setWarning(
          `Rate limited — polling slowed to every ${pollIntervalRef.current / 1000}s for this trial.`,
        );
      }
      // Other errors: skip this poll, try again next tick.
    }
    schedule(poll, pollIntervalRef.current);
  }

  function finishTrial(finished: Trial) {
    stopPolling();
    setTrial(finished);
    trialRef.current = finished;
    setTrials(upsertTrial(finished));
    setStep("result");
  }

  function reset() {
    stopPolling();
    setStep("enter");
    setBaseline(null);
    baselineRef.current = null;
    setTrial(null);
    trialRef.current = null;
    settledSecondsRef.current = null;
    setError(null);
    setWarning(null);
  }

  async function copyResults() {
    await navigator.clipboard.writeText(exportJSON());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString();
  const fmtDelay = (s: number | null) =>
    s === null ? "—" : `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <main className="wrap">
      <h1>04tracker — hiscores propagation test</h1>
      <p className="sub">
        Measures how long after you log out the 2004scape hiscores actually
        update. Run a few trials at different times of day and send the
        results back.
      </p>

      {error && <div className="error">{error}</div>}
      {warning && <div className="warning">{warning}</div>}

      {step === "enter" && (
        <section className="card">
          <h2>1 · Who are you testing with?</h2>
          <p>Enter the account you can log into. Any account name works.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) captureBaseline();
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="account name"
              maxLength={12}
              autoFocus
            />
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Fetching…" : "Capture baseline"}
            </button>
          </form>
        </section>
      )}

      {step === "settling" && baseline && (
        <section className="card">
          <h2>2 · Making sure your account is settled…</h2>
          <p className="bigNumber">
            {Math.floor(settledFor / 60)}m {settledFor % 60}s /{" "}
            {SETTLE_REQUIRED_MS / 60_000}m
          </p>
          <p>
            Before the trial starts, we wait for {SETTLE_REQUIRED_MS / 60_000}{" "}
            minutes of no hiscores changes for <b>{name.trim()}</b>. This
            guarantees no leftover update from an earlier session can
            contaminate the measurement. If anything lands, the timer restarts
            automatically.
          </p>
          <p className="dim">
            Don&apos;t log out during this wait (staying logged in is fine —
            play on!). Keep this tab open.
          </p>
          <button className="ghost" onClick={reset}>
            start over
          </button>
        </section>
      )}

      {step === "instruct" && baseline && (
        <section className="card">
          <h2>3 · Go gain some XP</h2>
          <p>
            Baseline captured for <b>{name.trim()}</b> — total XP{" "}
            <b>{xp(totalValue(baseline)).toLocaleString()}</b>.
          </p>
          <ol>
            <li>Log in to 2004scape.</li>
            <li>
              Gain a little XP in any skill (<b>at least a few points</b> — a
              zero-XP session is invisible to the hiscores).
            </li>
            <li>
              Log out, and click the button below <b>the moment you do</b>.
            </li>
          </ol>
          <button className="big" onClick={loggedOutNow} disabled={busy}>
            {busy ? "Checking…" : "I just logged out"}
          </button>
          <button className="ghost" onClick={reset}>
            start over
          </button>
        </section>
      )}

      {step === "polling" && trial && (
        <section className="card">
          <h2>4 · Waiting for your XP to land…</h2>
          <p className="bigNumber">{fmtDelay(elapsed)}</p>
          <p>
            since your logout at {fmtClock(trial.loggedOutAt)}. Checking the
            hiscores every {pollIntervalRef.current / 1000}s.{" "}
            <b>Keep this tab open</b> — closing it abandons the trial.
          </p>
          <p className="dim">
            Gives up after 30 minutes (that result still counts as data).
          </p>
        </section>
      )}

      {step === "result" && trial && (
        <section className="card">
          {trial.status === "landed" ? (
            <>
              <h2>Landed 🎉</h2>
              <p className="bigNumber">{fmtDelay(trial.delaySeconds)}</p>
              <p>
                from logout ({fmtClock(trial.loggedOutAt)}) to hiscores update
                ({trial.landedAt ? fmtClock(trial.landedAt) : "—"}), gaining{" "}
                {trial.xpGained?.toLocaleString()} XP.
              </p>
            </>
          ) : (
            <>
              <h2>No update within 30 minutes</h2>
              <p>
                That&apos;s unusual — and useful data. Make sure you actually
                gained XP and logged out; then try another trial.
              </p>
            </>
          )}
          <button className="big" onClick={reset}>
            Run another trial
          </button>
        </section>
      )}

      {trials.length > 0 && (
        <section className="card">
          <h2>Your trials ({trials.length})</h2>
          <table>
            <thead>
              <tr>
                <th>player</th>
                <th>logged out</th>
                <th>landed</th>
                <th>delay</th>
                <th>xp</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {[...trials].reverse().map((t) => (
                <tr key={t.id}>
                  <td>{t.player}</td>
                  <td>{new Date(t.loggedOutAt).toLocaleString()}</td>
                  <td>{t.landedAt ? fmtClock(t.landedAt) : "—"}</td>
                  <td>{fmtDelay(t.delaySeconds)}</td>
                  <td>{t.xpGained?.toLocaleString() ?? "—"}</td>
                  <td>{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row">
            <button onClick={copyResults}>
              {copied ? "Copied ✓" : "Copy results as JSON"}
            </button>
            <button
              className="ghost"
              onClick={() => {
                if (confirm("Delete all trials stored in this browser?")) {
                  clearTrials();
                  setTrials([]);
                }
              }}
            >
              clear my data
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
