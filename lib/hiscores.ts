// Types and helpers for the hiscores data that flows through our proxy.

export type SkillEntry = {
  type: number;
  level: number;
  value: number; // raw XP * 10 — divide by 10 (truncate) only for display
  rank: number;
};

export const SKILL_NAMES: Record<number, string> = {
  0: "Overall",
  1: "Attack",
  2: "Defence",
  3: "Strength",
  4: "Hitpoints",
  5: "Ranged",
  6: "Prayer",
  7: "Magic",
  8: "Cooking",
  9: "Woodcutting",
  10: "Fletching",
  11: "Fishing",
  12: "Firemaking",
  13: "Crafting",
  14: "Smithing",
  15: "Mining",
  16: "Herblore",
  17: "Agility",
  18: "Thieving",
  21: "Runecrafting", // 19-20 do not exist in the API
};

export class RateLimitedError extends Error {
  constructor() {
    super("rate limited by the hiscores API");
  }
}

export async function fetchPlayer(username: string): Promise<SkillEntry[]> {
  const res = await fetch(`/api/player/${encodeURIComponent(username)}`);
  if (res.status === 429) throw new RateLimitedError();
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const data = (await res.json()) as SkillEntry[];
  if (!Array.isArray(data)) throw new Error("unexpected response shape");
  return data;
}

export function xp(value: number): number {
  return Math.floor(value / 10);
}

export function totalValue(entries: SkillEntry[]): number {
  const overall = entries.find((e) => e.type === 0);
  if (overall) return overall.value;
  return entries.reduce((sum, e) => sum + e.value, 0);
}

// True when any skill's raw value differs — the signal that a logout landed.
export function hasChanged(baseline: SkillEntry[], current: SkillEntry[]): boolean {
  const base = new Map(baseline.map((e) => [e.type, e.value]));
  return current.some((e) => base.get(e.type) !== e.value);
}
