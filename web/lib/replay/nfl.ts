import nflJson from '@/config/models/nfl.json';
import { clamp, normalCdf, normalInv, sigmoid, softmax } from './math';

interface Bucket {
  name: string;
  min: number;
  max: number;
}
interface Rate {
  p: number;
  n: number;
}
interface Tri {
  td: number;
  fg: number;
  none: number;
  n: number;
}
interface Logit {
  features: string[];
  intercept: number;
  coef: number[];
  n: number;
  base_rate?: number;
}
interface Multinomial {
  features: string[];
  classes: string[];
  intercept: number[];
  coef: number[][];
  n: number;
}
interface PeriodRates {
  home: number;
  tie: number;
  away: number;
  n: number;
  mean_points: number;
}

/** Shape of `models/nfl.json` (written by ml/train_nfl.py). */
export interface NflTable {
  trained: boolean;
  source: string;
  seasons: number[];
  dist_buckets: Bucket[];
  field_buckets: Bucket[];
  red_zone_buckets: Bucket[];
  go_zones: Bucket[];
  conversion: Record<string, Record<string, Rate>>;
  fourth_go: Record<string, Record<string, Rate>>;
  pass_rate: Record<string, Record<string, Rate>>;
  drive_result: Record<string, Tri>;
  drive_result_overall: Tri;
  red_zone: Record<string, Tri>;
  period_winner: Record<string, PeriodRates>;
  points: { mean_total: number; sd_total: number; mean_home: number; mean_away: number; sd_margin: number; home_win: number; n_games: number };
  logit_conversion?: Logit;
  logit_pass?: Logit;
  multinomial_drive?: Multinomial;
}

export const NFL_TABLE = nflJson as unknown as NflTable;

export const GAME_SECONDS = 3600;

function bucketOf(value: number, buckets: Bucket[]): string | undefined {
  const v = Math.round(value);
  return buckets.find((b) => v >= b.min && v <= b.max)?.name;
}

export function distBucket(distance: number, t: NflTable = NFL_TABLE): string {
  return bucketOf(clamp(distance, 1, 99), t.dist_buckets) ?? '7-10';
}

export interface Situation {
  down: number;
  distance: number;
  /** Yards from the offense's own goal line, 1..99. */
  yardline: number;
  /** Offense score minus defense score. */
  scoreDiff?: number;
  secondsRemaining?: number;
}

function features(names: string[], s: Situation): number[] {
  const vals: Record<string, number> = {
    down2: s.down === 2 ? 1 : 0,
    down3: s.down === 3 ? 1 : 0,
    down4: s.down === 4 ? 1 : 0,
    ln_ydstogo: Math.log(Math.max(1, s.distance)),
    yardline_frac: clamp(s.yardline, 1, 99) / 100,
    score_diff_10: clamp(s.scoreDiff ?? 0, -30, 30) / 10,
    secs_remaining_frac: clamp(s.secondsRemaining ?? GAME_SECONDS / 2, 0, GAME_SECONDS) / GAME_SECONDS,
  };
  return names.map((n) => vals[n] ?? 0);
}

function evalLogit(m: Logit, s: Situation): number {
  const x = features(m.features, s);
  return sigmoid(m.intercept + m.coef.reduce((a, c, i) => a + c * x[i]!, 0));
}

/** Empirical conversion rate for the down and distance bucket (the P0 lookup table). */
export function conversionTableRate(down: number, distance: number, t: NflTable = NFL_TABLE): Rate {
  const byDown = t.conversion[String(down)] ?? t.conversion['3'] ?? {};
  return byDown[distBucket(distance, t)] ?? { p: 0.4, n: 0 };
}

export interface ConversionPrice {
  /** Probability the offense gains the first down (or scores) on this down. */
  p: number;
  /** Lookup-table rate for the bucket, when the offense runs a play. */
  tableRate: number;
  tableN: number;
  /** Trained-model rate when the offense runs a play (same as tableRate if no model is loaded). */
  playRate: number;
  /** 4th down only: probability the offense goes for it. 1 when the feed says they are going. */
  goRate: number;
  model: 'logit' | 'table';
}

/**
 * 3rd / 4th down conversion. Uses the trained logistic regression when the JSON has one, else the
 * lookup table. On 4th down the price is P(go for it) x P(convert | go), unless the feed already
 * says the offense is going for it.
 */
export function conversionProb(s: Situation & { goForIt?: boolean }, t: NflTable = NFL_TABLE): ConversionPrice {
  const table = conversionTableRate(s.down, s.distance, t);
  const playRate = t.logit_conversion ? evalLogit(t.logit_conversion, s) : table.p;
  let goRate = 1;
  if (s.down === 4 && s.goForIt !== true) {
    const zone = bucketOf(s.yardline, t.go_zones) ?? 'own_41_opp_41';
    goRate = t.fourth_go[zone]?.[distBucket(s.distance, t)]?.p ?? 0.2;
  }
  return {
    p: clamp(playRate * goRate, 0.01, 0.99),
    tableRate: table.p,
    tableN: table.n,
    playRate,
    goRate,
    model: t.logit_conversion ? 'logit' : 'table',
  };
}

export interface DrivePrice {
  td: number;
  fg: number;
  none: number;
  bucket: string;
  n: number;
  model: 'multinomial' | 'table';
}

/** How a drive ends, from its starting field position (plus score and clock in the trained model). */
export function driveResultProbs(s: Pick<Situation, 'yardline' | 'scoreDiff' | 'secondsRemaining'>, t: NflTable = NFL_TABLE): DrivePrice {
  const bucket = bucketOf(s.yardline, t.field_buckets) ?? 'own_21_30';
  const row = t.drive_result[bucket] ?? t.drive_result_overall;
  if (t.multinomial_drive) {
    const m = t.multinomial_drive;
    const x = features(m.features, { down: 1, distance: 10, ...s });
    const probs = softmax(m.intercept.map((b, i) => b + m.coef[i]!.reduce((a, c, j) => a + c * x[j]!, 0)));
    const by: Record<string, number> = {};
    m.classes.forEach((c, i) => (by[c] = probs[i]!));
    return { td: by.td ?? row.td, fg: by.fg ?? row.fg, none: by.none ?? row.none, bucket, n: row.n, model: 'multinomial' };
  }
  return { td: row.td, fg: row.fg, none: row.none, bucket, n: row.n, model: 'table' };
}

/** Drive outcome given a first snap inside the opponent 20. */
export function redZoneProbs(yardline: number, t: NflTable = NFL_TABLE): Tri & { bucket: string } {
  const bucket = bucketOf(clamp(yardline, 80, 99), t.red_zone_buckets) ?? 'all';
  const row = t.red_zone[bucket] ?? t.red_zone.all ?? { td: 0.56, fg: 0.3, none: 0.14, n: 0 };
  return { ...row, bucket };
}

/** P(pass) on this snap. */
export function passProb(s: Situation, t: NflTable = NFL_TABLE): { p: number; tableRate: number; model: 'logit' | 'table' } {
  const tableRate = t.pass_rate[String(s.down)]?.[distBucket(s.distance, t)]?.p ?? 0.58;
  if (t.logit_pass) return { p: clamp(evalLogit(t.logit_pass, s), 0.03, 0.97), tableRate, model: 'logit' };
  return { p: clamp(tableRate, 0.03, 0.97), tableRate, model: 'table' };
}

/** Per-game strength, optionally calibrated to Gemini. */
export interface NflStrength {
  /** Pre-game P(home wins). */
  pHome: number;
  /** Pre-game expected total points. */
  totalMean: number;
  /** Total line to quote (x.5), e.g. Gemini's main line. */
  totalLine: number;
  source: 'default' | 'gemini';
}

export function defaultNflStrength(t: NflTable = NFL_TABLE): NflStrength {
  return { pHome: clamp(t.points.home_win, 0.4, 0.65), totalMean: t.points.mean_total, totalLine: nearestHalf(t.points.mean_total), source: 'default' };
}

/** The x.5 line closest to a number (44.7 -> 44.5, 45.2 -> 45.5). */
export function nearestHalf(x: number): number {
  return Math.round(x - 0.5) + 0.5;
}

/** Expected final margin (home minus away) implied by a win probability. */
export function marginFromWinProb(pHome: number, t: NflTable = NFL_TABLE): number {
  return t.points.sd_margin * normalInv(clamp(pHome, 0.02, 0.98));
}

/** Live P(home wins): final margin ~ Normal(lead + m * f, sd * sqrt(f)), f = fraction of the game left. */
export function nflWinProb(strength: NflStrength, lead: number, secondsRemaining: number, t: NflTable = NFL_TABLE): number {
  const f = clamp(secondsRemaining / GAME_SECONDS, 0, 1);
  if (f <= 0) return lead > 0 ? 1 : lead < 0 ? 0 : 0.5;
  const m = marginFromWinProb(strength.pHome, t);
  return normalCdf((lead + m * f) / (t.points.sd_margin * Math.sqrt(f)));
}

/** Live P(total points > line): remaining points ~ Normal(mean * f, sd * sqrt(f)). */
export function totalOverProb(strength: NflStrength, line: number, pointsSoFar: number, secondsRemaining: number, t: NflTable = NFL_TABLE): number {
  if (pointsSoFar > line) return 1;
  const f = clamp(secondsRemaining / GAME_SECONDS, 0, 1);
  if (f <= 0) return 0;
  const mean = strength.totalMean * f;
  const sd = t.points.sd_total * Math.sqrt(f);
  return clamp(1 - normalCdf((line - pointsSoFar - mean) / sd), 0, 1);
}

/** Expected-total that makes P(total > line) equal `pOver` (used for Gemini calibration). */
export function totalMeanFromLine(line: number, pOver: number, t: NflTable = NFL_TABLE): number {
  return line - t.points.sd_total * normalInv(clamp(1 - pOver, 0.02, 0.98));
}

export type PeriodKey = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'H1' | 'H2';

/**
 * Who outscores whom in a quarter or half. Starts from the league rates and tilts them by team
 * strength: period margin ~ Normal(m * share, sd * sqrt(share)); the tie rate is kept from the table.
 */
export function periodWinnerProbs(period: PeriodKey, strength: NflStrength, t: NflTable = NFL_TABLE): { home: number; tie: number; away: number; n: number } {
  const row = t.period_winner[period] ?? { home: 0.44, tie: 0.16, away: 0.4, n: 0, mean_points: 11 };
  const share = period.startsWith('H') ? 0.5 : 0.25;
  const sd = t.points.sd_margin * Math.sqrt(share);
  const baseSplit = row.home / (row.home + row.away);
  // Shift in standard-normal units relative to the league-average home edge.
  const shift = (marginFromWinProb(strength.pHome, t) - marginFromWinProb(clamp(t.points.home_win, 0.4, 0.65), t)) * share / sd;
  const split = normalCdf(normalInv(baseSplit) + shift);
  return { home: (1 - row.tie) * split, tie: row.tie, away: (1 - row.tie) * (1 - split), n: row.n };
}
