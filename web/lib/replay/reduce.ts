// Ported from Huddle packages/sports/src/reduce.ts.
import { initialGameState, type GameEvent, type GameState } from './types';

/**
 * The game-state reducer (PRD section 6, step 1). Pure: never mutates its inputs.
 *
 * Counter names (all optional, missing = 0):
 *   soccer  goals_{home|away|total}, goals_period_{p}_{home|away},
 *           cards_{home|away|total}, yellow_{home|away|total}, red_{home|away|total}, cards_period_{p},
 *           corners_{home|away|total}, penalties_{home|away|total}, penalties_scored_{home|away},
 *           subs_{home|away}
 *   nfl     points_period_{p}_{home|away}, plays_total, drives_{home|away}, first_downs_{home|away},
 *           touchdowns_{home|away}, field_goals_{home|away}, turnovers_{home|away}, punts_{home|away},
 *           third_down_attempts_{home|away}, third_down_conversions_{home|away},
 *           fourth_down_attempts_{home|away}, fourth_down_conversions_{home|away},
 *           red_zone_trips_{home|away}
 *
 * Rewinds: if an event arrives with `seq <= state.lastSeq` (the replay was seeked backwards and is
 * replaying from the top) the state is rebuilt from scratch before the event is applied.
 */
export function reduce(state: GameState, event: GameEvent): GameState {
  const base = event.seq <= state.lastSeq ? initialGameState(state.gameId, state.sport, state.home, state.away) : state;

  const next: GameState = {
    ...base,
    score: { home: num(event.score?.home, base.score.home), away: num(event.score?.away, base.score.away) },
    clock: event.clock ?? base.clock,
    lastSeq: event.seq,
    lastEvent: event,
    counters: { ...base.counters },
    periodScores: [...base.periodScores],
  };
  const c = next.counters;
  const inc = (key: string, by = 1): void => {
    c[key] = (c[key] ?? 0) + by;
  };
  const side = sideOf(base, event.team);
  const period = Number(event.data?.period ?? event.clock?.period ?? base.clock.period) || 0;
  const data = event.data ?? {};

  // ---- status ----
  if (event.type === 'final') next.status = 'final';
  else if (base.status === 'pre') next.status = 'live';

  // ---- clock ----
  if (state.sport === 'soccer') {
    const minute = data.minute;
    if (typeof minute === 'number' && Number.isFinite(minute)) next.minute = minute;
  } else {
    const secs = data.secondsRemaining;
    if (typeof secs === 'number' && Number.isFinite(secs)) next.secondsRemaining = Math.max(0, secs);
    else {
      const parsed = state.sport === 'nba' ? nbaSecondsRemaining(event.clock?.period, event.clock?.display) : nflSecondsRemaining(event.clock?.period, event.clock?.display);
      if (parsed !== undefined) next.secondsRemaining = parsed;
    }
    if (event.type === 'final') next.secondsRemaining = 0;
  }

  // ---- points by period, from score deltas (works for every provider) ----
  const dHome = next.score.home - base.score.home;
  const dAway = next.score.away - base.score.away;
  if (period > 0 && (dHome !== 0 || dAway !== 0)) {
    const prefix = state.sport === 'soccer' ? 'goals_period' : 'points_period';
    if (dHome !== 0) inc(`${prefix}_${period}_home`, dHome);
    if (dAway !== 0) inc(`${prefix}_${period}_away`, dAway);
  }

  switch (event.type) {
    case 'goal':
      inc('goals_total');
      if (side) inc(`goals_${side}`);
      break;

    case 'penalty_awarded':
      inc('penalties_total');
      if (side) inc(`penalties_${side}`);
      break;

    case 'penalty_result':
      if (data.scored === true && side) inc(`penalties_scored_${side}`);
      break;

    case 'card': {
      const color = data.color === 'red' ? 'red' : 'yellow';
      inc('cards_total');
      inc(`${color}_total`);
      if (period > 0) inc(`cards_period_${period}`);
      if (side) {
        inc(`cards_${side}`);
        inc(`${color}_${side}`);
      }
      break;
    }

    case 'corner': {
      // Two-event protocol: the award has no `shotOnTarget`; the outcome event carries it. A provider
      // that sends a single corner event with the flag already set is counted once as well.
      const isOutcome = typeof data.shotOnTarget === 'boolean';
      const pendingKey = `corner_pending_${side ?? 'any'}`;
      if (!isOutcome) {
        inc('corners_total');
        if (side) inc(`corners_${side}`);
        c[pendingKey] = 1;
      } else if ((c[pendingKey] ?? 0) > 0) {
        c[pendingKey] = 0;
      } else {
        inc('corners_total');
        if (side) inc(`corners_${side}`);
      }
      break;
    }

    case 'sub':
      if (side) inc(`subs_${side}`);
      break;

    // ---- basketball ----
    case 'shot':
      if (side) {
        next.possession = side;
        inc(`fga_${side}`);
        if (data.three === true) inc(`threes_attempted_${side}`);
        if (data.made === true) {
          inc(`fgm_${side}`);
          if (data.three === true) inc(`threes_${side}`);
        }
      }
      break;

    case 'free_throw':
      if (side && data.trip !== true) {
        inc(`fta_${side}`);
        if (data.made === true) inc(`ftm_${side}`);
      }
      break;

    case 'turnover':
      if (side) inc(`turnovers_${side}`);
      break;

    case 'timeout':
      if (typeof data.ball === 'string') next.possession = sideOf(base, data.ball) ?? next.possession;
      break;

    case 'drive_start':
      if (side) {
        next.possession = side;
        inc(`drives_${side}`);
      }
      next.down = 1;
      next.distance = 10;
      next.yardline = yard(data.yardline) ?? next.yardline;
      c.red_zone_flag = 0;
      if ((next.yardline ?? 0) >= 80 && side) {
        inc(`red_zone_trips_${side}`);
        c.red_zone_flag = 1;
      }
      break;

    case 'snap': {
      if (side) next.possession = side;
      const down = intIn(data.down, 1, 4);
      if (down !== undefined) next.down = down;
      const distance = intIn(data.distance, 0, 99);
      if (distance !== undefined) next.distance = distance;
      next.yardline = yard(data.yardline) ?? next.yardline;
      break;
    }

    case 'play_result': {
      if (side) next.possession = side;
      if (data.noPlay === true) break;
      inc('plays_total');
      const down = intIn(data.down, 1, 4) ?? base.down;
      const distance = intIn(data.distance, 0, 99) ?? base.distance;
      const start = yard(data.yardline) ?? base.yardline;
      const gained = typeof data.gained === 'number' ? data.gained : 0;
      const touchdown = data.touchdown === true;
      const turnover = data.turnover === true;
      const playType = String(data.playType ?? '');
      const firstDown = data.firstDown === true || touchdown;
      if (side) {
        if (firstDown) inc(`first_downs_${side}`);
        if (touchdown) inc(`touchdowns_${side}`);
        if (turnover) inc(`turnovers_${side}`);
        if (playType === 'punt') inc(`punts_${side}`);
        if (playType === 'kick' && data.good === true) inc(`field_goals_${side}`);
        if ((down === 3 || down === 4) && (playType === 'run' || playType === 'pass')) {
          const name = down === 3 ? 'third' : 'fourth';
          inc(`${name}_down_attempts_${side}`);
          if (firstDown) inc(`${name}_down_conversions_${side}`);
        }
      }
      const kicked = playType === 'punt' || playType === 'kick';
      if (touchdown || turnover || kicked) {
        next.down = undefined;
        next.distance = undefined;
        next.yardline = undefined;
      } else if (start !== undefined) {
        const spot = clamp(start + gained, 1, 99);
        next.yardline = spot;
        if (firstDown) {
          next.down = 1;
          next.distance = Math.min(10, 100 - spot);
        } else if (down !== undefined && distance !== undefined) {
          if (down >= 4) {
            // Turnover on downs.
            next.down = undefined;
            next.distance = undefined;
            next.yardline = undefined;
            if (side) inc(`turnovers_${side}`);
          } else {
            next.down = down + 1;
            next.distance = Math.max(1, distance - gained);
          }
        }
        if (side && start < 80 && spot >= 80 && (c.red_zone_flag ?? 0) === 0) {
          inc(`red_zone_trips_${side}`);
          c.red_zone_flag = 1;
        }
      }
      break;
    }

    case 'drive_end':
      next.down = undefined;
      next.distance = undefined;
      next.yardline = undefined;
      c.red_zone_flag = 0;
      if (side && data.result === 'fg' && !(String(base.lastEvent?.data?.playType) === 'kick' && base.lastEvent?.data?.good === true)) {
        inc(`field_goals_${side}`);
      }
      break;

    case 'period_end': {
      const p = Number(data.period ?? event.clock?.period ?? 0);
      if (p > 0 && !next.periodScores.some((s) => s.period === p)) {
        next.periodScores.push({ period: p, home: next.score.home, away: next.score.away });
      }
      next.down = undefined;
      next.distance = undefined;
      break;
    }

    case 'final': {
      const p = base.clock.period || period;
      if (p > 0 && !next.periodScores.some((s) => s.period === p)) {
        next.periodScores.push({ period: p, home: next.score.home, away: next.score.away });
      }
      next.down = undefined;
      next.distance = undefined;
      break;
    }

    default:
      break;
  }

  return next;
}

/** Which side a team short code belongs to. */
export function sideOf(state: Pick<GameState, 'home' | 'away'>, team: string | undefined): 'home' | 'away' | undefined {
  if (!team) return undefined;
  const t = team.toUpperCase();
  if (t === state.home.short.toUpperCase() || t === state.home.name.toUpperCase()) return 'home';
  if (t === state.away.short.toUpperCase() || t === state.away.name.toUpperCase()) return 'away';
  return undefined;
}

/** Seconds left in a 4 x 12:00 NBA game from the period and a "MM:SS" clock. Overtime counts its own 5:00. */
export function nbaSecondsRemaining(period: number | undefined, display: string | undefined): number | undefined {
  if (!period || !display) return undefined;
  // ESPN shows "4:21" above a minute and "32.3" (seconds) below it.
  const m = /^(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(display.trim());
  const s = /^(\d{1,2})(?:\.\d+)?$/.exec(display.trim());
  if (!m && !s) return undefined;
  const inPeriod = m ? Number(m[1]) * 60 + Number(m[2]) : Number(s![1]);
  if (period > 4) return Math.min(300, inPeriod);
  return (4 - period) * 720 + Math.min(720, inPeriod);
}

/** Seconds left in a 4 x 15:00 NFL game from the period and a "MM:SS" clock. Overtime counts as 0. */
export function nflSecondsRemaining(period: number | undefined, display: string | undefined): number | undefined {
  if (!period || !display) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(display.trim());
  if (!m) return undefined;
  const inPeriod = Number(m[1]) * 60 + Number(m[2]);
  if (period > 4) return 0;
  return (4 - period) * 900 + Math.min(900, inPeriod);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function intIn(v: unknown, lo: number, hi: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;
}

function yard(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), 1, 99) : undefined;
}
