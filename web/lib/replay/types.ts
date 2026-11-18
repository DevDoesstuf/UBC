// Types for replay games (ported from Huddle's @huddle/shared, trimmed to what the question engine needs).

export type Sport = "soccer" | "nfl" | "nba";

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
  | "score_update"
  // basketball (NBA replays)
  | "shot"
  | "free_throw"
  | "turnover"
  | "timeout";

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
    clock: { period: 0, display: sport === "soccer" ? "0'" : sport === "nba" ? "12:00" : "15:00" },
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

/**
 * Gemini data a replay file carries (written by scripts/build-replays.mjs from Gemini's public API):
 * the pregame snapshot (prices one minute before kickoff, the fallback and the calibration input) and
 * `track`, Gemini's real price at each moment of the real game, keyed by replay time.
 */
export interface ReplayGemini {
  /** Ticker base, e.g. "NFL-2611152125-SF-DAL". */
  event: string;
  home?: string;
  away?: string;
  /** Gemini event status when the file was built ("settled" for finished games). */
  status?: string;
  settledAt?: string | null;
  kickoff?: string;
  url?: string;
  builtAt?: string;
  snapshot?: { asOf: string; events: { ticker: string; title?: string; slug?: string; contracts: { ticker: string; label: string; bestBid?: string; bestAsk?: string; lastTradePrice?: string }[] }[] };
  /** eventTicker -> contract code -> [[replay ms, probability], ...] (ascending, deduped). */
  track?: Record<string, Record<string, [number, number][]>>;
}
