import soccerJson from '@/config/models/soccer.json';
import { clamp, poissonAtLeast, poissonMatch, solvePoissonRates } from './math';

/** Shape of `models/soccer.json` (written by ml/train_soccer.py). */
export interface SoccerTable {
  trained: boolean;
  source: string;
  matches: number;
  penalty: {
    base_rate: number;
    attempts: number;
    scored: number;
    shrinkage_k: number;
    takers_in_sample?: Record<string, { attempts: number; scored: number }>;
    career?: Record<string, { attempts: number; scored: number; aliases?: string[] } | string>;
  };
  corner: { shot_on_target_rate: number; corners: number; window_secs: number };
  cards: { per_match_first_half: number; per_match_second_half: number };
  goals: { default_home: number; default_away: number };
}

export const SOCCER_TABLE = soccerJson as unknown as SoccerTable;

export const MATCH_MINUTES = 90;

export interface GoalRates {
  /** Expected goals over a full 90 minutes. */
  home: number;
  away: number;
  source: 'default' | 'odds' | 'gemini';
}

export function defaultGoalRates(t: SoccerTable = SOCCER_TABLE): GoalRates {
  return { home: t.goals.default_home, away: t.goals.default_away, source: 'default' };
}

/** Rates implied by win/draw/loss probabilities (bookmaker-style or Gemini mids). */
export function goalRatesFromOdds(pHome: number, pDraw: number, pAway: number, source: GoalRates['source'] = 'odds'): GoalRates {
  const r = solvePoissonRates(pHome, pDraw, pAway);
  return { home: r.home, away: r.away, source };
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Look up a taker's record: curated career tallies first, then the StatsBomb sample. */
export function takerRecord(player: string | undefined, t: SoccerTable = SOCCER_TABLE): { attempts: number; scored: number; from: 'career' | 'sample' } | undefined {
  if (!player) return undefined;
  const p = norm(player);
  for (const [name, rec] of Object.entries(t.penalty.career ?? {})) {
    if (typeof rec === 'string') continue;
    const names = [name, ...(rec.aliases ?? [])].map(norm);
    if (names.includes(p)) return { attempts: rec.attempts, scored: rec.scored, from: 'career' };
  }
  for (const [name, rec] of Object.entries(t.penalty.takers_in_sample ?? {})) {
    const n = norm(name);
    // Sample names are full legal names ("Cristiano Ronaldo dos Santos Aveiro"): match on whole words.
    if (n === p || (` ${n} `.includes(` ${p} `) && p.length >= 4)) return { attempts: rec.attempts, scored: rec.scored, from: 'sample' };
  }
  return undefined;
}

export interface PenaltyPrice {
  p: number;
  base: number;
  taker?: { attempts: number; scored: number; rate: number; from: 'career' | 'sample' };
}

/**
 * Penalty conversion: league base rate, pulled toward the taker's own record by empirical-Bayes
 * shrinkage: (scored + k * base) / (attempts + k), k = 20 attempts.
 */
export function penaltyProb(player?: string, t: SoccerTable = SOCCER_TABLE): PenaltyPrice {
  const base = t.penalty.base_rate;
  const k = t.penalty.shrinkage_k || 20;
  const rec = takerRecord(player, t);
  if (!rec || rec.attempts <= 0) return { p: base, base };
  const p = (rec.scored + k * base) / (rec.attempts + k);
  return { p: clamp(p, 0.4, 0.97), base, taker: { ...rec, rate: rec.scored / rec.attempts } };
}

/** Expected goals left for each side given the match minute. */
export function remainingRates(rates: GoalRates, minute = 0): { home: number; away: number; frac: number } {
  const frac = clamp((MATCH_MINUTES - minute) / MATCH_MINUTES, 0, 1);
  return { home: rates.home * frac, away: rates.away * frac, frac };
}

/** P(a side, or both together, finishes with at least `n` goals). */
export function goalsAtLeastProb(n: number, scoredSoFar: number, lambdaRemaining: number): number {
  return poissonAtLeast(n - scoredSoFar, lambdaRemaining);
}

/** Next goal: split by the two remaining rates; "none" = P(no more goals). */
export function nextGoalProbs(lhRem: number, laRem: number): { home: number; away: number; none: number } {
  const total = lhRem + laRem;
  if (total <= 0) return { home: 0, away: 0, none: 1 };
  const none = Math.exp(-total);
  return { home: ((1 - none) * lhRem) / total, away: ((1 - none) * laRem) / total, none };
}

/** Win/draw/loss from the current score and remaining rates. */
export function matchProbs(lhRem: number, laRem: number, lead = 0): { home: number; draw: number; away: number } {
  return poissonMatch(lhRem, laRem, lead);
}

/** P(at least one more card before halftime), Poisson with the first-half card rate. */
export function cardBeforeHalfProb(minute: number, t: SoccerTable = SOCCER_TABLE): number {
  const stoppage = 2;
  const left = clamp(45 + stoppage - minute, 0, 47);
  const perMinute = t.cards.per_match_first_half / 47;
  return 1 - Math.exp(-perMinute * left);
}

export function cornerShotOnTargetProb(t: SoccerTable = SOCCER_TABLE): number {
  return t.corner.shot_on_target_rate;
}

/** Smallest N in 1..5 whose "N or more goals" probability lands in the fun zone (25% to 60%), else the closest to 40%. */
export function pickGoalLine(lambda: number, scoredSoFar = 0): { n: number; p: number } {
  let best = { n: scoredSoFar + 1, p: poissonAtLeast(1, lambda) };
  let bestDist = Infinity;
  for (let more = 1; more <= 6; more++) {
    const p = poissonAtLeast(more, lambda);
    if (p >= 0.25 && p <= 0.6) return { n: scoredSoFar + more, p };
    const dist = Math.abs(p - 0.4);
    if (dist < bestDist) {
      bestDist = dist;
      best = { n: scoredSoFar + more, p };
    }
  }
  return best;
}
