// NBA pricing models for replay games. Pure functions, no dependencies beyond math.ts.
//
// League constants (NBA regular season, recent seasons; rounded, published league averages):
//   home teams win about 57% of games; final margin standard deviation about 13.5 points;
//   about 226 total points a game with a standard deviation of about 19;
//   free throws go in about 78% of the time; about 26 threes are made per game (both teams);
//   a possession scores about 52% of the time.
// Game-level priors are calibrated to Gemini's moneyline and total when the game has them.
import { clamp, normalCdf, normalInv } from './math';

export const NBA = {
  homeWin: 0.57,
  marginSd: 13.5,
  meanTotal: 226,
  totalSd: 19,
  ftPct: 0.78,
  threesPerMinute: 26 / 48,
  possessionScore: 0.52,
  gameSeconds: 2880,
  source: 'NBA league averages, recent regular seasons',
} as const;

export interface NbaStrength {
  /** Pregame home win probability. */
  pHome: number;
  /** Expected total points and the line we quote. */
  totalMean: number;
  totalLine: number;
  source: 'default' | 'gemini';
}

export function defaultNbaStrength(): NbaStrength {
  return { pHome: NBA.homeWin, totalMean: NBA.meanTotal, totalLine: NBA.meanTotal - 0.5, source: 'default' };
}

const frac = (secondsRemaining: number) => clamp(secondsRemaining / NBA.gameSeconds, 0, 1);

/** Expected final home margin implied by a pregame win probability. */
export function nbaMarginFromWinProb(pHome: number): number {
  return NBA.marginSd * normalInv(clamp(pHome, 0.02, 0.98));
}

/** Home win probability with `lead` (home minus away) and `secondsRemaining` left. */
export function nbaWinProb(s: NbaStrength, lead: number, secondsRemaining: number): number {
  if (secondsRemaining <= 0) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;
  const f = frac(secondsRemaining);
  const mu = nbaMarginFromWinProb(s.pHome) * f;
  const sd = Math.max(1.2, NBA.marginSd * Math.sqrt(f));
  return clamp(normalCdf((lead + mu) / sd), 0.005, 0.995);
}

/** Expected points still to come: the pregame expectation, blended with the game's own pace once it has one. */
export function expectedRemainingPoints(s: NbaStrength, pointsSoFar: number, secondsRemaining: number): number {
  const f = frac(secondsRemaining);
  const prior = s.totalMean * f;
  const elapsed = 1 - f;
  if (elapsed < 0.2) return prior;
  const pace = (pointsSoFar / elapsed) * f;
  return 0.5 * prior + 0.5 * pace;
}

/** P(total points > line). */
export function nbaTotalOverProb(s: NbaStrength, line: number, pointsSoFar: number, secondsRemaining: number): number {
  if (pointsSoFar > line) return 1;
  if (secondsRemaining <= 0) return 0;
  const f = frac(secondsRemaining);
  const mean = pointsSoFar + expectedRemainingPoints(s, pointsSoFar, secondsRemaining);
  const sd = Math.max(1.5, NBA.totalSd * Math.sqrt(f));
  return clamp(1 - normalCdf((line - mean) / sd), 0.005, 0.995);
}

/** Who wins a quarter: `lead` is the home lead within the quarter so far, `secondsLeft` in the quarter. */
export function nbaQuarterProbs(s: NbaStrength, lead: number, secondsLeft: number): { home: number; tie: number; away: number } {
  if (secondsLeft <= 0) return lead > 0 ? { home: 1, tie: 0, away: 0 } : lead < 0 ? { home: 0, tie: 0, away: 1 } : { home: 0, tie: 1, away: 0 };
  const f = frac(secondsLeft);
  const mu = nbaMarginFromWinProb(s.pHome) * f;
  const sd = Math.max(1.2, NBA.marginSd * Math.sqrt(f));
  const home = 1 - normalCdf((0.5 - lead - mu) / sd);
  const away = normalCdf((-0.5 - lead - mu) / sd);
  return { home, tie: Math.max(0.01, 1 - home - away), away };
}

/** P(every free throw of a trip goes in), at the league rate. */
export function ftAllProb(attempts: number): number {
  return Math.pow(NBA.ftPct, Math.max(1, attempts));
}

/** P(the team with the ball scores next): possessions alternate, each scoring with probability p. */
export function nextScoreProb(p: number = NBA.possessionScore): number {
  return p / (1 - (1 - p) * (1 - p));
}

/** P(at least one made three in the next `seconds` of game clock), Poisson at the league rate. */
export function threeInWindowProb(seconds: number): number {
  return 1 - Math.exp(-NBA.threesPerMinute * (seconds / 60));
}

export function nearestHalfPoint(x: number): number {
  return Math.floor(x) + 0.5;
}
