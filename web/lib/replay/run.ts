// Replay games: the game clock, the question engine and Dev's one-question-at-a-time lobby, glued together.
//
// Everything is stateless between requests (Vercel): the run lives in lobby.replay and advances inside
// tick() whenever the lobby is read or written. On each advance we fold the timeline events that are due
// (the ported reducer), let the question engine propose YES/NO candidates, lock/resolve the open question
// from the engine's lock rules and resolvers, and open the best new candidate when the room is free.
//
// The engine only prices and resolves. Scheduling uses the replay script itself: since the timeline is
// known, we can tell when a candidate will lock and resolve and skip ones that would leave the room
// staring at a locked market for long (one question at a time).
import { HuddleQuestionEngine, type GameMemo, type GameModel } from "./engine";
import { reduce } from "./reduce";
import { getTimeline, type Timeline } from "./timeline";
import {
  initialGameState, type EngineMarket, type GameEvent, type GameState, type GeminiEventQuote, type GeminiHint,
  type MarketCandidate, type Outcome, type ResolverResult, type ResolverSpec, type TeamRef,
} from "./types";
import type { Market } from "../types";

/** Trading must stay open at least this long after a question opens. */
export const MIN_TRADE_MS = 8000;
/** Game-long questions trade for this long, then wait for their resolver. */
export const GAME_TRADE_MS = 30000;
/** Skip candidates that would sit locked longer than this before their answer arrives. */
export const MAX_LOCKED_WAIT_MS = 30000;
/** How long the result screen stays up before the next question opens by itself. */
export const RESULT_HOLD_MS = 5000;
/** Prices stay inside this band so neither side is ever a lock. */
export const PRIOR_MIN = 0.05;
export const PRIOR_MAX = 0.95;

export interface PendingQ {
  key: string;
  templateId: string;
  kind: "moment" | "game";
  text: string;
  short: string;
  hook?: string;
  yesId: string;
  outcomes: Outcome[];
  prior: Record<string, number>;
  /** Model probability of YES at proposal time (clamped). */
  yesPrior: number;
  resolver: ResolverSpec;
  lockOnEvent?: string;
  lockAfterSecs?: number;
  geminiHint?: GeminiHint;
  priority: number;
  rationale: string;
  /** Seq of the event that created it; the engine never locks/resolves from it or anything earlier. */
  seq: number;
  proposedAtMs: number;
  /** Moment questions: when trading closes (replay ms). Game questions: decided at open. */
  lockAtMs: number | null;
  /** When the resolver fires (replay ms), from the script. null = never (would be void). */
  resolveAtMs: number | null;
  /** Set when it opens. */
  openedAtMs?: number;
}

export interface ReplayRun {
  timelineId: string;
  /** Wall-clock ms at replay time 0. null until the host starts question 1. */
  startedAt: number | null;
  /** Number of timeline events folded so far. */
  folded: number;
  state: GameState;
  model?: GameModel;
  memo?: GameMemo;
  pending: PendingQ[];
  /** The question currently in the lobby's market (open or locked), if it came from the engine. */
  current: PendingQ | null;
  asked: number;
  maxQuestions: number;
  /** Pregame question (the Gemini-comparable moneyline), trading before the clock starts. */
  pregame?: PendingQ | null;
  /** The pregame question after it locked: it settles from its resolver (the final whistle) in the background. */
  parked?: PendingQ | null;
  parkedMarket?: Market | null;
}

/** What the lobby lets the replay do. Implemented in lib/lobby.ts. */
export interface ReplayHost {
  /** "open" / "locked" while a question runs; "idle" when the room can take a new one. */
  phase(): "open" | "locked" | "idle";
  /** Wall time the last result came in (for the result hold), or 0. */
  lastResultAt(): number;
  /** Time-based lock of the open market, if due at `wall`. */
  lockIfDue(wall: number): void;
  lock(wall: number): void;
  resolve(outcome: "yes" | "no" | null, reason: string | null, wall: number): void;
  resolveParked?(outcome: "yes" | "no" | null, reason: string | null, wall: number): void;
  open(q: PendingQ, yesPrior: number, lockAtWall: number, resolveAtWall: number | null, wall: number): void;
  gameEvent?(ev: GameEvent, state: GameState): void;
}

// ---------------------------------------------------------------- candidates -> YES/NO questions

function nick(team: TeamRef, sport: GameState["sport"]): string {
  if (sport === "soccer") return team.name;
  const words = team.name.trim().split(/\s+/);
  return words.length > 1 ? words[words.length - 1] : team.name;
}

function ordinal(n: number): string {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

export function clampPrior(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(PRIOR_MAX, Math.max(PRIOR_MIN, p));
}

/** Turn an engine candidate (possibly 3-way) into one YES/NO question about a single outcome. */
export function toYesNo(c: MarketCandidate, state: GameState, ev: GameEvent): Omit<PendingQ, "key" | "seq" | "proposedAtMs" | "lockAtMs" | "resolveAtMs"> {
  const sport = state.sport;
  const home = nick(state.home, sport);
  const away = nick(state.away, sport);
  const offenseSide = (ev.team && ev.team.toUpperCase() === state.home.short.toUpperCase()) ? "home"
    : (ev.team && ev.team.toUpperCase() === state.away.short.toUpperCase()) ? "away" : state.possession;
  const offense = offenseSide ? nick(state[offenseSide], sport) : "offense";
  let yesId = "yes";
  let text = c.question;
  let short = c.question;
  const has = (id: string) => c.outcomes.some((o) => o.id === id);
  switch (c.templateId) {
    case "soccer.winner":
    case "nfl.winner":
    case "nba.winner":
      yesId = "home";
      text = sport !== "soccer" ? `Will the ${home} beat the ${away}?` : `Will ${home} beat ${away}?`;
      short = `${home} win?`;
      break;
    case "soccer.next_goal":
      yesId = "home";
      text = `Will ${home} score the next goal?`;
      short = `${home} next goal?`;
      break;
    case "any.period_winner": {
      yesId = "home";
      const label = String(c.resolver.params.label ?? "period");
      text = sport !== "soccer" ? `Will the ${home} win the ${label}?` : `Will ${home} win the ${label}?`;
      short = `${home} win ${label}?`;
      break;
    }
    case "nba.quarter_winner": {
      yesId = "home";
      const label = String(c.resolver.params.label ?? "quarter");
      text = `Will the ${home} win the ${label}?`;
      short = `${home} win ${label}?`;
      break;
    }
    case "nba.clutch": {
      const leader = c.resolver.params.leader === "away" ? "away" : "home";
      yesId = leader;
      const ln = leader === "home" ? home : away;
      text = c.question.startsWith("All square") ? `All square late: will the ${home} win it?` : `Crunch time: will the ${ln} hold on to win?`;
      short = `${ln} hold on?`;
      break;
    }
    case "nba.total_points":
    case "nba.late_total": {
      yesId = "over";
      const line = c.resolver.params.line;
      text = c.templateId === "nba.late_total" ? `Over ${line} total points by the final buzzer?` : `Over ${line} total points in the game?`;
      short = `Over ${line} points?`;
      break;
    }
    case "nba.ft_trip":
      short = `${ev.player ?? "Shooter"} makes all FTs?`;
      break;
    case "nba.next_score": {
      const ball = String(c.resolver.params.team ?? "").toUpperCase() === state.away.short.toUpperCase() ? away : home;
      text = `Out of the timeout: will the ${ball} score next?`;
      short = `${ball} score next?`;
      break;
    }
    case "nba.three_window":
      short = "A three in 2 minutes?";
      break;
    case "nfl.total_points": {
      yesId = "over";
      const line = c.resolver.params.line;
      text = `Over ${line} total points in the game?`;
      short = `Over ${line} points?`;
      break;
    }
    case "nfl.drive_result":
      yesId = "td";
      text = `Touchdown on this ${offense} drive?`;
      short = `${offense} TD this drive?`;
      break;
    case "nfl.run_pass": {
      yesId = "pass";
      const down = Number(ev.data.down);
      text = `Will the ${offense} pass on ${Number.isFinite(down) ? ordinal(down) : "this"} down?`;
      short = `${offense} pass?`;
      break;
    }
    case "nfl.conversion": {
      const down = Number(ev.data.down);
      short = `${offense} convert ${Number.isFinite(down) ? ordinal(down) : ""} down?`.replace("  ", " ");
      break;
    }
    case "nfl.red_zone_td":
      short = `${offense} red zone TD?`;
      break;
    case "soccer.penalty":
      short = `${ev.player ?? "Penalty"} scores?`;
      break;
    case "soccer.corner_sot":
      short = "Shot on target from corner?";
      break;
    case "soccer.card_before_half":
      short = "Another card before half?";
      break;
    case "soccer.team_goals":
    case "soccer.total_goals":
      short = c.question.replace(/^Will /, "");
      break;
    default:
      if (!has("yes")) {
        yesId = c.outcomes[0]?.id ?? "yes";
        text = `${c.question.replace(/\?$/, "")}: ${c.outcomes[0]?.label ?? "Yes"}?`;
        short = text;
      }
  }
  if (!has(yesId)) yesId = c.outcomes[0]?.id ?? "yes";
  const total = Object.values(c.prior).reduce((a, b) => a + b, 0) || 1;
  const yesPrior = clampPrior((c.prior[yesId] ?? 0.5) / total);
  return {
    templateId: c.templateId, kind: c.kind, text, short: short.slice(0, 40), hook: c.hook, yesId,
    outcomes: c.outcomes, prior: c.prior, yesPrior, resolver: c.resolver, lockOnEvent: c.lockOnEvent,
    lockAfterSecs: c.lockAfterSecs, geminiHint: c.geminiHint, priority: c.priority, rationale: c.rationale,
  };
}

// ---------------------------------------------------------------- engine helpers

function engineFor(run: ReplayRun): HuddleQuestionEngine {
  return new HuddleQuestionEngine().restore(run.timelineId, run.model, run.memo);
}

function asEngineMarket(q: PendingQ, state: EngineMarket["state"]): EngineMarket {
  return { templateId: q.templateId, state, createdAtSeq: q.seq, lock: { onEvent: q.lockOnEvent }, resolver: q.resolver, outcomes: q.outcomes, prior: q.prior };
}

/** Walk the script forward from event index `from` (state = state before that event). */
function walk(t: Timeline, from: number, state: GameState, visit: (ev: GameEvent, atMs: number, s: GameState) => boolean): void {
  let s = state;
  for (let i = from; i < t.events.length; i++) {
    const { atMs, event } = t.events[i];
    s = reduce(s, event);
    if (visit(event, atMs, s)) return;
  }
}

/** When does this question lock if it opens at `openAtMs`? (replay ms) */
function planLock(engine: HuddleQuestionEngine, t: Timeline, q: PendingQ, from: number, state: GameState, openAtMs: number): number {
  const cap = q.kind === "moment" && q.lockAfterSecs ? q.proposedAtMs + q.lockAfterSecs * 1000 : openAtMs + GAME_TRADE_MS;
  let at = cap;
  const m = asEngineMarket(q, "open");
  walk(t, from, state, (ev, atMs, s) => {
    if (atMs >= at) return true;
    if (atMs > openAtMs && engine.shouldLock(m, ev, s)) {
      at = atMs;
      return true;
    }
    return false;
  });
  return at;
}

/** When does the resolver fire (replay ms)? null when it never does or would void. */
function planResolve(engine: HuddleQuestionEngine, t: Timeline, q: PendingQ, from: number, state: GameState): number | null {
  let at: number | null = null;
  const m = asEngineMarket(q, "locked");
  walk(t, from, state, (ev, atMs, s) => {
    const r = engine.evaluate(m, ev, s);
    if (!r) return false;
    at = "outcome" in r ? atMs : null;
    return true;
  });
  return at;
}

function lockFor(engine: HuddleQuestionEngine, t: Timeline, run: ReplayRun, q: PendingQ, nowMs: number): number {
  if (q.kind === "moment" && q.lockAtMs !== null) return q.lockAtMs;
  return planLock(engine, t, q, run.folded, run.state, nowMs);
}

/** Moment questions at or above this priority (3rd/4th downs, red zone, penalties, free throws...) are the headline ones. */
export const BIG_MOMENT_PRIORITY = 70;

/** Replay ms of the next event (not yet folded) that will set up a moment question (of at least `minPriority`), or Infinity. */
function nextMomentAt(run: ReplayRun, t: Timeline, minPriority = 0): number {
  const scout = new HuddleQuestionEngine().restore(run.timelineId, structuredClone(run.model), structuredClone(run.memo));
  let at = Infinity;
  walk(t, run.folded, run.state, (ev, atMs, s) => {
    if (scout.propose(ev, s, []).some((c) => c.kind === "moment" && c.priority >= minPriority)) {
      at = atMs;
      return true;
    }
    return false;
  });
  return at;
}

/** The best question that can open at replay time `nowMs`, with its lock time. */
export function bestCandidate(run: ReplayRun, nowMs: number, engine = engineFor(run)): { q: PendingQ; lockAtMs: number } | null {
  const t = getTimeline(run.timelineId);
  if (!t) return null;
  let best: { q: PendingQ; lockAtMs: number } | null = null;
  let momentAt: number | undefined;
  let bigAt: number | undefined;
  for (const q of run.pending) {
    if (q.resolveAtMs === null || q.resolveAtMs - nowMs < MIN_TRADE_MS) continue;
    const lockAtMs = Math.min(lockFor(engine, t, run, q, nowMs), q.resolveAtMs);
    if (lockAtMs - nowMs < MIN_TRADE_MS) continue;
    if (q.resolveAtMs - lockAtMs > MAX_LOCKED_WAIT_MS) continue;
    // Game-long questions are filler: never let one block the room when a play-by-play moment is coming.
    if (q.kind === "game") {
      momentAt ??= nextMomentAt(run, t);
      if (momentAt <= q.resolveAtMs) continue;
    }
    // Small moments (a drive result, a corner) wait when a headline moment (a 3rd down, a penalty, free throws)
    // would arrive while they are still running.
    if (q.kind === "moment" && q.priority < BIG_MOMENT_PRIORITY) {
      bigAt ??= nextMomentAt(run, t, BIG_MOMENT_PRIORITY);
      if (bigAt <= q.resolveAtMs) continue;
    }
    if (!best || q.priority > best.q.priority || (q.priority === best.q.priority && q.proposedAtMs < best.q.proposedAtMs)) best = { q, lockAtMs };
  }
  return best;
}

/**
 * A host-called moment that the engine also proposed (e.g. "Penalty!" while the engine holds a penalty
 * candidate): take that candidate so the play-by-play resolves it. Returns it marked as asked, or null.
 */
export function takeCandidate(run: ReplayRun, templates: string[], now: number): { q: PendingQ; lockAtMs: number } | null {
  if (run.startedAt === null || !templates.length) return null;
  const t = getTimeline(run.timelineId);
  if (!t) return null;
  const nowMs = now - run.startedAt;
  const engine = engineFor(run);
  const q = [...run.pending].reverse().find((p) => templates.includes(p.templateId) && p.resolveAtMs !== null && p.resolveAtMs - nowMs >= MIN_TRADE_MS);
  if (!q) return null;
  const lockAtMs = Math.min(lockFor(engine, t, run, q, nowMs), q.resolveAtMs!);
  if (lockAtMs - nowMs < MIN_TRADE_MS) return null;
  run.pending = run.pending.filter((p) => p.key !== q.key);
  run.current = { ...q, lockAtMs, openedAtMs: nowMs };
  run.asked++;
  return { q: run.current, lockAtMs };
}

/** Drop candidates that can never open any more. */
function prune(run: ReplayRun, nowMs: number): void {
  run.pending = run.pending.filter((q) => {
    if (q.resolveAtMs === null || q.resolveAtMs - nowMs < MIN_TRADE_MS) return false;
    if (q.kind === "moment" && q.lockAtMs !== null && q.lockAtMs - nowMs < MIN_TRADE_MS) return false;
    return true;
  });
}

// ---------------------------------------------------------------- the run

export function newRun(timelineId: string, maxQuestions: number, model?: GameModel): ReplayRun {
  const t = getTimeline(timelineId);
  if (!t) throw new Error(`Unknown replay ${timelineId}`);
  return {
    timelineId, startedAt: null, folded: 0, state: initialGameState(t.info.id, t.info.sport, t.info.home, t.info.away),
    model, pending: [], current: null, asked: 0, maxQuestions,
  };
}

/** Calibrate the pricing models to Gemini's quotes (moneyline and total), before the game starts. */
export function calibrateRun(run: ReplayRun, quotes: GeminiEventQuote[]): void {
  const t = getTimeline(run.timelineId);
  if (!t || !quotes.length) return;
  const engine = engineFor(run);
  engine.calibrate(t.info, quotes);
  run.model = engine.snapshot(run.timelineId).model;
}

/** Fold one event: lock/resolve the current question from it, then collect new candidates. */
function foldOne(run: ReplayRun, t: Timeline, engine: HuddleQuestionEngine, host: ReplayHost | null): void {
  const { atMs, event } = t.events[run.folded];
  const wall = (run.startedAt ?? 0) + atMs;
  if (host) host.lockIfDue(wall);
  run.state = reduce(run.state, event);
  run.folded++;
  const cur = run.current;
  if (cur && host) {
    const ph = host.phase();
    if (ph === "open" || ph === "locked") {
      const m = asEngineMarket(cur, ph);
      if (ph === "open" && engine.shouldLock(m, event, run.state)) host.lock(wall);
      const r: ResolverResult = engine.evaluate(m, event, run.state);
      if (r) {
        run.current = null;
        if ("outcome" in r) host.resolve(r.outcome === cur.yesId ? "yes" : "no", null, wall);
        else host.resolve(null, r.reason, wall);
      }
    } else {
      run.current = null;
    }
  }
  const parked = run.parked;
  if (parked && host) {
    const r = engine.evaluate(asEngineMarket(parked, "locked"), event, run.state);
    if (r) {
      run.parked = null;
      if ("outcome" in r) host.resolveParked?.(r.outcome === parked.yesId ? "yes" : "no", null, wall);
      else host.resolveParked?.(null, r.reason, wall);
    }
  }
  if (host?.gameEvent) host.gameEvent(event, run.state);
  const live = run.current ? [asEngineMarket(run.current, "open")] : [];
  const cands = engine.propose(event, run.state, live);
  for (const c of cands) {
    const base = toYesNo(c, run.state, event);
    const q: PendingQ = { ...base, key: `${c.templateId}@${event.seq}`, seq: event.seq, proposedAtMs: atMs, lockAtMs: null, resolveAtMs: null };
    q.resolveAtMs = planResolve(engine, t, q, run.folded, run.state);
    if (q.kind === "moment") q.lockAtMs = planLock(engine, t, q, run.folded, run.state, atMs);
    // A newer candidate of the same kind replaces the older one (fresher situation).
    run.pending = run.pending.filter((p) => p.templateId !== q.templateId || p.kind === "game");
    run.pending.push(q);
  }
}

function saveEngine(run: ReplayRun, engine: HuddleQuestionEngine): void {
  const snap = engine.snapshot(run.timelineId);
  run.model = snap.model;
  run.memo = snap.memo;
}

/**
 * Start the game clock (the host's "Start" tap). The clock is placed so the first askable question is
 * on screen right away: events before it are folded instantly (score, clock and captions still show them).
 */
export function startRun(run: ReplayRun, now: number): void {
  if (run.startedAt !== null) return;
  const t = getTimeline(run.timelineId);
  if (!t) throw new Error("Replay missing");
  const engine = engineFor(run);
  run.startedAt = now; // provisional: fold without a host until a candidate is askable
  let startMs = run.folded > 0 ? t.events[run.folded - 1].atMs : t.events[0]?.atMs ?? 0;
  while (run.folded < t.events.length && !(run.folded > 0 && bestCandidate(run, startMs, engine))) {
    const atMs = t.events[run.folded].atMs;
    foldOne(run, t, engine, null);
    startMs = atMs;
    prune(run, atMs);
  }
  run.startedAt = now - startMs;
  saveEngine(run, engine);
}

/**
 * The pregame question: fold up to kickoff and take the engine's match-winner candidate, which Gemini
 * prices too (moneyline). It trades before the clock starts and settles at the final whistle.
 */
export function pregameQuestion(run: ReplayRun): PendingQ | null {
  const t = getTimeline(run.timelineId);
  if (!t || run.startedAt !== null || run.folded > 0) return null;
  const engine = engineFor(run);
  const kickoff = t.events.findIndex((e) => e.event.type === "kickoff");
  if (kickoff < 0) return null;
  while (run.folded <= kickoff) foldOne(run, t, engine, null);
  saveEngine(run, engine);
  const q = run.pending.find((p) => p.templateId === "nfl.winner" || p.templateId === "soccer.winner" || p.templateId === "nba.winner");
  if (!q || q.resolveAtMs === null) return null;
  run.pending = run.pending.filter((p) => p.key !== q.key);
  return { ...q, lockAtMs: null };
}

/** True when advanceReplay would change something at `now`. */
export function replayDue(run: ReplayRun, now: number, host: ReplayHost): boolean {
  if (run.startedAt === null) return false;
  const t = getTimeline(run.timelineId);
  if (!t) return false;
  const nowMs = now - run.startedAt;
  if (run.folded < t.events.length && t.events[run.folded].atMs <= nowMs) return true;
  return canOpenNow(run, host, now) && !!bestCandidate(run, nowMs);
}

function canOpenNow(run: ReplayRun, host: ReplayHost, now: number): boolean {
  if (run.asked >= run.maxQuestions) return false;
  if (host.phase() !== "idle") return false;
  return now - host.lastResultAt() >= RESULT_HOLD_MS;
}

/** Bring the run up to `now`: fold due events, lock/resolve, then open the next question if the room is free. */
export function advanceReplay(run: ReplayRun, now: number, host: ReplayHost, force = false): boolean {
  if (run.startedAt === null) return false;
  const t = getTimeline(run.timelineId);
  if (!t) return false;
  const engine = engineFor(run);
  const nowMs = now - run.startedAt;
  let changed = false;
  while (run.folded < t.events.length && t.events[run.folded].atMs <= nowMs) {
    foldOne(run, t, engine, host);
    changed = true;
  }
  host.lockIfDue(now);
  prune(run, nowMs);
  if (force || canOpenNow(run, host, now)) {
    const best = run.asked < run.maxQuestions && host.phase() === "idle" ? bestCandidate(run, nowMs, engine) : null;
    if (best) {
      const q = best.q;
      let yesPrior = q.yesPrior;
      if (q.kind === "game") {
        // Game-long questions are repriced to the score and clock at the moment they open.
        const live = engine.reprice(asEngineMarket(q, "open"), run.state);
        if (live && live[q.yesId] !== undefined) yesPrior = clampPrior(live[q.yesId]);
      }
      q.openedAtMs = nowMs;
      run.pending = run.pending.filter((p) => p.key !== q.key);
      run.current = { ...q, yesPrior, lockAtMs: best.lockAtMs };
      run.asked++;
      host.open(run.current, yesPrior, run.startedAt + best.lockAtMs, q.resolveAtMs !== null ? run.startedAt + q.resolveAtMs : null, now);
      changed = true;
    }
  }
  saveEngine(run, engine);
  return changed;
}

/** Replay time in ms (0 before the start). */
export function replayMs(run: ReplayRun, now: number): number {
  return run.startedAt === null ? 0 : Math.max(0, now - run.startedAt);
}

/** Simulate a whole game with nobody tapping: the questions it would ask, in order. Used for the kiosk's "of N". */
export function simulate(timelineId: string, opts: { pregame?: boolean; model?: GameModel } = {}): { text: string; short: string; yesPrior: number; templateId: string; atMs: number }[] {
  const t = getTimeline(timelineId);
  if (!t) return [];
  const run = newRun(timelineId, 999, opts.model);
  const pre = opts.pregame ? pregameQuestion(run) : null;
  let phase: "open" | "locked" | "idle" = "idle";
  let lastResult = 0;
  let lockAt = Infinity;
  const asked: { text: string; short: string; yesPrior: number; templateId: string; atMs: number }[] = [];
  const host: ReplayHost = {
    phase: () => phase,
    lastResultAt: () => lastResult,
    lockIfDue: (w) => {
      if (phase === "open" && w >= lockAt) phase = "locked";
    },
    lock: () => {
      phase = "locked";
    },
    resolve: (_o, _r, w) => {
      phase = "idle";
      lastResult = w;
    },
    open: (q, yesPrior, lockWall, _res, w) => {
      phase = "open";
      lockAt = lockWall;
      asked.push({ text: q.text, short: q.short, yesPrior, templateId: q.templateId, atMs: w - (run.startedAt ?? 0) });
    },
  };
  if (pre) asked.push({ text: pre.text, short: pre.short, yesPrior: pre.yesPrior, templateId: pre.templateId, atMs: 0 });
  startRun(run, 0);
  advanceReplay(run, 0, host, true);
  const end = (t.info.durationMs ?? 0) + 5000;
  for (let now = 0; now - (run.startedAt ?? 0) <= end; now += 250) advanceReplay(run, now, host);
  return asked;
}
