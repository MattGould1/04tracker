// Trial storage: localStorage only. Testers share results back by copying
// the exported JSON — there is deliberately no server-side persistence.

export type TrialStatus = "landed" | "timeout" | "abandoned";

export type Trial = {
  id: string;
  player: string;
  loggedOutAt: string; // ISO, client clock
  landedAt: string | null; // ISO, client clock; null unless status=landed
  delaySeconds: number | null;
  xpGained: number | null; // whole XP (value diff / 10)
  pollIntervalSeconds: number;
  status: TrialStatus;
  userAgentHint: string; // coarse, for dedup when aggregating results
};

const KEY = "04tracker-trials";

export function loadTrials(): Trial[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Trial[]) : [];
  } catch {
    return [];
  }
}

export function upsertTrial(trial: Trial): Trial[] {
  const trials = loadTrials().filter((t) => t.id !== trial.id);
  trials.push(trial);
  window.localStorage.setItem(KEY, JSON.stringify(trials));
  return trials;
}

export function clearTrials(): void {
  window.localStorage.removeItem(KEY);
}

export function exportJSON(): string {
  return JSON.stringify(loadTrials(), null, 2);
}

export function newTrialId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function userAgentHint(): string {
  if (typeof navigator === "undefined") return "unknown";
  return navigator.userAgent.split(" ").slice(-2).join(" ");
}
