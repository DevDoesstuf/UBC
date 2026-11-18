// Replay timelines (ported from Huddle packages/sports/src/replay.ts `buildTimeline`).
// The JSON files in config/replays are bundled at build time, so nothing reads the disk on Vercel.
import titansCowboys from "@/config/replays/titans-cowboys.json";
import portugalSpain from "@/config/replays/portugal-spain.json";
import { reduce, nflSecondsRemaining } from "./reduce";
import { initialGameState, type GameEvent, type GameEventType, type GameInfo, type GameState, type Sport, type TeamRef } from "./types";

export interface ReplayEntry {
  atMs: number;
  type: GameEventType;
  period?: number;
  minute?: number;
  clock?: string;
  team?: string;
  player?: string;
  data?: Record<string, unknown>;
  score?: [number, number];
  text?: string;
}

export interface ReplayFile {
  id: string;
  sport: Sport;
  title: string;
  home: TeamRef;
  away: TeamRef;
  durationMs?: number;
  startsAt?: string;
  description?: string;
  events: ReplayEntry[];
}

export interface Timeline {
  info: GameInfo & { durationMs: number; startsAt?: string };
  /** Normalized events in seq order (seq = index + 1). */
  events: { atMs: number; event: GameEvent }[];
}

const EVENT_TYPES: ReadonlySet<string> = new Set<GameEventType>([
  "kickoff", "goal", "penalty_awarded", "penalty_result", "corner", "card", "sub", "snap", "play_result",
  "drive_start", "drive_end", "period_start", "period_end", "final", "score_update",
]);

/** Validate and normalize one replay file. Throws with a readable message on bad input. */
export function buildTimeline(file: ReplayFile): Timeline {
  if (!file?.id) throw new Error("replay file needs an id");
  if (file.sport !== "soccer" && file.sport !== "nfl") throw new Error(`replay ${file.id}: sport must be soccer or nfl`);
  if (!Array.isArray(file.events) || file.events.length === 0) throw new Error(`replay ${file.id}: no events`);
  const entries = file.events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.atMs - b.e.atMs || a.i - b.i)
    .map((x) => x.e);

  const score = { home: 0, away: 0 };
  let period = 1;
  let minute = 0;
  let display = file.sport === "soccer" ? "0'" : "15:00";
  const events: Timeline["events"] = [];
  entries.forEach((entry, idx) => {
    if (!EVENT_TYPES.has(entry.type)) throw new Error(`replay ${file.id}: event ${idx} has unknown type "${entry.type}"`);
    if (typeof entry.period === "number") period = entry.period;
    const data: Record<string, unknown> = { ...(entry.data ?? {}) };
    if (file.sport === "soccer") {
      if (typeof entry.minute === "number") minute = entry.minute;
      else if (typeof data.minute === "number") minute = data.minute;
      data.minute = minute;
      display = entry.clock ?? `${minute}'`;
    } else {
      if (entry.clock) display = entry.clock;
      if (typeof data.secondsRemaining !== "number") {
        const secs = entry.type === "final" ? 0 : nflSecondsRemaining(period, display);
        if (secs !== undefined) data.secondsRemaining = secs;
      }
    }
    if ((entry.type === "period_start" || entry.type === "period_end") && data.period === undefined) data.period = period;
    if (entry.score) {
      score.home = entry.score[0];
      score.away = entry.score[1];
    } else if (file.sport === "soccer" && entry.type === "goal") {
      const t = entry.team?.toUpperCase();
      if (t === file.home.short.toUpperCase()) score.home += 1;
      else if (t === file.away.short.toUpperCase()) score.away += 1;
    }
    const event: GameEvent = {
      gameId: file.id, sport: file.sport, seq: idx + 1, clock: { period, display }, type: entry.type, data, score: { ...score },
    };
    if (entry.team) event.team = entry.team;
    if (entry.player) event.player = entry.player;
    if (entry.text) event.text = entry.text;
    events.push({ atMs: entry.atMs, event });
  });
  const lastAt = events[events.length - 1].atMs;
  return {
    info: {
      id: file.id, sport: file.sport, title: file.title, home: file.home, away: file.away,
      durationMs: Math.max(file.durationMs ?? 0, lastAt + (file.durationMs ? 0 : 3000)),
      startsAt: file.startsAt,
    },
    events,
  };
}

const FILES: ReplayFile[] = [titansCowboys as unknown as ReplayFile, portugalSpain as unknown as ReplayFile];
const cache = new Map<string, Timeline>();

export function getTimeline(id: string): Timeline | undefined {
  const hit = cache.get(id);
  if (hit) return hit;
  const file = FILES.find((f) => f.id === id);
  if (!file) return undefined;
  const t = buildTimeline(file);
  cache.set(id, t);
  return t;
}

export function replayIds(): string[] {
  return FILES.map((f) => f.id);
}

/** Game state after folding every event with atMs <= t (pure; used for previews and tests). */
export function stateAt(t: Timeline, ms: number): GameState {
  let s = initialGameState(t.info.id, t.info.sport, t.info.home, t.info.away);
  for (const { atMs, event } of t.events) {
    if (atMs > ms) break;
    s = reduce(s, event);
  }
  return s;
}
