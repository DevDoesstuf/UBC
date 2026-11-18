// Types for replay games (ported from Huddle's @huddle/shared, trimmed to what the question engine needs).

export type Sport = "soccer" | "nfl";

export interface TeamRef {
  name: string;
  /** Short code, e.g. "DAL". GameEvent.team uses this code. */
  short: string;
  color?: string;
}

export type GameEventType =
  | "kickoff"
  | "goal"
  | "penalty_awarded"
  | "penalty_result"
  | "corner"
  | "card"
  | "sub"
  | "snap"
  | "play_result"
  | "drive_start"
  | "drive_end"
  | "period_start"
  | "period_end"
  | "final"
  | "score_update";

/** One normalized sports event (see config/replays/README in the Huddle repo for the data conventions). */
export interface GameEvent {
  gameId: string;
  sport: Sport;
  seq: number;
  clock: { period: number; display: string };
  type: GameEventType;
  team?: string;
  player?: string;
  data: Record<string, unknown>;
  score: { home: number; away: number };
  text?: string;
}

/** Running game state, reduced from the event stream. */
export interface GameState {
  gameId: string;
  sport: Sport;
  status: "pre" | "live" | "final";
  home: TeamRef;
  away: TeamRef;
  score: { home: number; away: number };
  clock: { period: number; display: string };
  minute?: number;
  secondsRemaining?: number;
  possession?: "home" | "away";
  down?: number;
  distance?: number;
  yardline?: number;
  lastSeq: number;
  counters: Record<string, number>;
  periodScores: { period: number; home: number; away: number }[];
  lastEvent?: GameEvent;
}

export function initialGameState(gameId: string, sport: Sport, home: TeamRef, away: TeamRef): GameState {
  return {
    gameId,
    sport,
    status: "pre",
    home,
    away,
    score: { home: 0, away: 0 },
    clock: { period: 0, display: sport === "soccer" ? "0'" : "15:00" },
    lastSeq: 0,
    counters: {},
    periodScores: [],
  };
}

export interface Outcome {
  id: string;
  label: string;
}

export interface ResolverSpec {
  type: string;
  params: Record<string, unknown>;
}

export interface GeminiHint {
  kind: "moneyline" | "total" | "period_winner";
  period?: string;
  line?: number;
  team?: string;
}

/** A question the engine proposes. Prices come from the models, never from an LLM. */
export interface MarketCandidate {
  templateId: string;
  kind: "moment" | "game";
  question: string;
  hook?: string;
  outcomes: Outcome[];
  prior: Record<string, number>;
  lockAfterSecs?: number;
  lockOnEvent?: string;
  resolver: ResolverSpec;
  geminiHint?: GeminiHint;
  priority: number;
  rationale: string;
}

/** The slice of a market the engine reads to lock, resolve and reprice. */
export interface EngineMarket {
  templateId: string;
  state: "draft" | "open" | "locked" | "resolved" | "voided";
  createdAtSeq?: number;
  lock?: { onEvent?: string };
  resolver?: ResolverSpec;
  outcomes: Outcome[];
  prior: Record<string, number>;
  price?: Record<string, number>;
}

export type ResolverResult = { outcome: string } | { void: true; reason: string } | null;

/** Gemini quote in the shape the engine's calibration reads. */
export interface GeminiEventQuote {
  eventTicker: string;
  kind: "moneyline" | "period_winner" | "total" | "spread" | "other";
  period?: string;
  contracts: { contractTicker: string; label: string; prob: number | null }[];
}

export interface GameInfo {
  id: string;
  sport: Sport;
  title: string;
  home: TeamRef;
  away: TeamRef;
}
