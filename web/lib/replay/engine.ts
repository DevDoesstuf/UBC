// Ported from Huddle packages/models/src/engine.ts. Changes for serverless: the engine is stateless
// between requests (the per-game memo and calibrated model live in the lobby JSON and are passed in).
import type {
  EngineMarket as Market,
  GameEvent,
  GameInfo,
  GameState,
  GeminiEventQuote,
  MarketCandidate,
  Outcome,
  ResolverResult,
  TeamRef,
} from './types';
import { clamp, normalInv, normalizePrior, pct } from './math';
import {
  conversionProb,
  defaultNflStrength,
  driveResultProbs,
  nearestHalf,
  NFL_TABLE,
  nflQuarterProbs,
  nflWinProb,
  passProb,
  periodWinnerProbs,
  redZoneProbs,
  totalMeanFromLine,
  totalOverProb,
  type NflStrength,
  type PeriodKey,
} from './nfl';
import {
  cardBeforeHalfProb,
  cornerShotOnTargetProb,
  defaultGoalRates,
  goalRatesFromOdds,
  goalsAtLeastProb,
  matchProbs,
  nextGoalProbs,
  penaltyProb,
  pickGoalLine,
  remainingRates,
  SOCCER_TABLE,
  type GoalRates,
} from './soccer';
import {
  defaultNbaStrength,
  expectedRemainingPoints,
  ftAllProb,
  NBA,
  nbaQuarterProbs,
  nbaTotalOverProb,
  nbaWinProb,
  nearestHalfPoint,
  nextScoreProb,
  threeInWindowProb,
  type NbaStrength,
} from './nba';

/** Template ids (PRD section 6 catalog). */
export const TEMPLATES = {
  soccerPenalty: 'soccer.penalty',
  soccerTeamGoals: 'soccer.team_goals',
  soccerTotalGoals: 'soccer.total_goals',
  soccerNextGoal: 'soccer.next_goal',
  soccerCorner: 'soccer.corner_sot',
  soccerCard: 'soccer.card_before_half',
  soccerWinner: 'soccer.winner',
  nflConversion: 'nfl.conversion',
  nflDrive: 'nfl.drive_result',
  nflRunPass: 'nfl.run_pass',
  nflTotal: 'nfl.total_points',
  nflRedZone: 'nfl.red_zone_td',
  nflQuarter: 'nfl.quarter_winner',
  nflWinner: 'nfl.winner',
  periodWinner: 'any.period_winner',
  nbaWinner: 'nba.winner',
  nbaTotal: 'nba.total_points',
  nbaFreeThrows: 'nba.ft_trip',
  nbaNextScore: 'nba.next_score',
  nbaThree: 'nba.three_window',
  nbaQuarter: 'nba.quarter_winner',
  nbaClutch: 'nba.clutch',
  nbaLateTotal: 'nba.late_total',
} as const;

const YES_NO: Outcome[] = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];

type Side = 'home' | 'away';

function sideOf(teams: { home: TeamRef; away: TeamRef }, team: string | undefined): Side | undefined {
  if (!team) return undefined;
  const t = team.toUpperCase();
  if (t === teams.home.short.toUpperCase() || t === teams.home.name.toUpperCase()) return 'home';
  if (t === teams.away.short.toUpperCase() || t === teams.away.name.toUpperCase()) return 'away';
  return undefined;
}

/** "Dallas Cowboys" -> "Cowboys" for NFL and NBA; soccer names are used as they are. */
function nick(team: TeamRef, sport: GameState['sport']): string {
  if (sport === 'soccer') return team.name;
  const words = team.name.trim().split(/\s+/);
  return words.length > 1 ? words[words.length - 1]! : team.name;
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function normalInvSafe(p: number): number {
  return normalInv(clamp(p, 0.02, 0.98));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isLive(m: Market): boolean {
  return m.state === 'draft' || m.state === 'open' || m.state === 'locked';
}

export interface GameModel {
  soccer: GoalRates;
  nfl: NflStrength;
  /** Optional: lobbies saved before NBA support have no `nba` (filled with defaults on read). */
  nba?: NbaStrength;
}

export interface GameMemo {
  lastSeq: number;
  fired: string[];
}

/**
 * The real question engine: deterministic trigger rules + priced candidates + resolvers.
 * The LLM never touches a number in here.
 */
export class HuddleQuestionEngine {
  private models = new Map<string, GameModel>();
  private memo = new Map<string, GameMemo>();

  /** Restore per-game state saved in the lobby (serverless: nothing survives between requests). */
  restore(gameId: string, model: GameModel | undefined, memo: GameMemo | undefined): this {
    if (model) this.models.set(gameId, model);
    if (memo) this.memo.set(gameId, memo);
    return this;
  }

  snapshot(gameId: string): { model: GameModel; memo: GameMemo } {
    return { model: this.model(gameId), memo: this.memo.get(gameId) ?? { lastSeq: 0, fired: [] } };
  }

  /** Per-game strength parameters (defaults until `calibrate` is called). */
  model(gameId: string): GameModel {
    let m = this.models.get(gameId);
    if (!m) {
      m = { soccer: defaultGoalRates(), nfl: defaultNflStrength(), nba: defaultNbaStrength() };
      this.models.set(gameId, m);
    }
    m.nba ??= defaultNbaStrength();
    return m;
  }

  /** Supply bookmaker-style win/draw/loss probabilities for a soccer game (solves the Poisson rates). */
  setSoccerOdds(gameId: string, pHome: number, pDraw: number, pAway: number): GoalRates {
    const rates = goalRatesFromOdds(pHome, pDraw, pAway, 'odds');
    this.model(gameId).soccer = rates;
    return rates;
  }

  // ───────────────────────── propose ─────────────────────────

  propose(event: GameEvent, state: GameState, open: Market[]): MarketCandidate[] {
    // Catch-up events (replay seek, live backlog) describe moments that have already passed.
    if (event.data?.catchUp === true) return [];
    if (event.type === 'final' || state.status === 'final') return [];

    const memo = this.touch(event);
    const blocked = new Set(open.filter(isLive).map((m) => m.templateId));
    const all =
      state.sport === 'soccer' ? this.proposeSoccer(event, state, memo) : state.sport === 'nba' ? this.proposeNba(event, state, memo) : this.proposeNfl(event, state, memo);
    return all.filter((c) => !blocked.has(c.templateId)).sort((a, b) => b.priority - a.priority);
  }

  private touch(event: GameEvent): GameMemo {
    let memo = this.memo.get(event.gameId);
    if (!memo || event.seq <= memo.lastSeq || event.type === 'kickoff') {
      memo = { lastSeq: 0, fired: [] };
      this.memo.set(event.gameId, memo);
    }
    memo.lastSeq = event.seq;
    return memo;
  }

  private proposeSoccer(event: GameEvent, state: GameState, memo: GameMemo): MarketCandidate[] {
    const out: MarketCandidate[] = [];
    const { home, away } = state;
    const rates = this.model(event.gameId).soccer;
    const minute = num(event.data.minute) ?? state.minute ?? 0;
    const score = event.score ?? state.score;
    const side = sideOf(state, event.team);
    const period = event.clock?.period ?? state.clock.period;
    const ratesNote = rates.source === 'default' ? 'default rates' : rates.source === 'gemini' ? 'rates fitted to Gemini' : 'rates fitted to the win odds';

    if (event.type === 'kickoff') {
      const rem = remainingRates(rates, minute);
      const w = matchProbs(rem.home, rem.away, score.home - score.away);
      const prior = normalizePrior({ home: w.home, draw: w.draw, away: w.away });
      const rationale = `Poisson goal model, ${rates.home.toFixed(2)} expected goals for ${home.name} and ${rates.away.toFixed(2)} for ${away.name} (${ratesNote}): ${home.name} ${pct(prior.home!)}, draw ${pct(prior.draw!)}, ${away.name} ${pct(prior.away!)}.`;
      out.push({
        templateId: TEMPLATES.soccerWinner,
        kind: 'game',
        question: `Who wins: ${home.name} or ${away.name}?`,
        hook: `${home.name} against ${away.name}. Pick your winner before the 80th minute.`,
        outcomes: [
          { id: 'home', label: home.name },
          { id: 'draw', label: 'Draw' },
          { id: 'away', label: away.name },
        ],
        prior,
        lockOnEvent: 'minute:80',
        resolver: { type: 'match_winner', params: { rationale } },
        geminiHint: { kind: 'moneyline' },
        priority: 30,
        rationale,
      });

      const line = pickGoalLine(rem.home, score.home);
      const teamRationale = `${home.name} are expected to score ${rates.home.toFixed(2)} goals (${ratesNote}); a Poisson model gives ${pct(line.p)} for ${line.n} or more.`;
      out.push({
        templateId: TEMPLATES.soccerTeamGoals,
        kind: 'game',
        question: `Will ${home.name} score ${line.n}+ goals?`,
        hook: `${line.n} or more for ${home.name} tonight? The model says ${pct(line.p)}.`,
        outcomes: YES_NO,
        prior: normalizePrior({ yes: line.p, no: 1 - line.p }),
        lockOnEvent: 'minute:80',
        resolver: { type: 'total_goals', params: { n: line.n, side: 'home', team: home.short, rationale: teamRationale } },
        priority: 28,
        rationale: teamRationale,
      });

      const total = pickGoalLine(rem.home + rem.away, score.home + score.away);
      const totalRationale = `The two teams are expected to share ${(rates.home + rates.away).toFixed(2)} goals; a Poisson model gives ${pct(total.p)} for ${total.n} or more in the match.`;
      out.push({
        templateId: TEMPLATES.soccerTotalGoals,
        kind: 'game',
        question: `Will there be ${total.n}+ goals in the match?`,
        hook: `Goals, goals, goals. ${total.n} or more tonight?`,
        outcomes: YES_NO,
        prior: normalizePrior({ yes: total.p, no: 1 - total.p }),
        lockOnEvent: 'minute:80',
        resolver: { type: 'total_goals', params: { n: total.n, rationale: totalRationale } },
        geminiHint: { kind: 'total', line: total.n - 0.5 },
        priority: 25,
        rationale: totalRationale,
      });
    }

    if (event.type === 'penalty_awarded') {
      const player = event.player ?? 'the taker';
      const price = penaltyProb(event.player);
      const t = SOCCER_TABLE.penalty;
      const sample = t.attempts > 0 ? `${t.scored} of ${t.attempts} in-play penalties in StatsBomb open data` : 'published league rates';
      const rationale = price.taker
        ? `Penalties are scored ${pct(price.base)} of the time (${sample}). ${player}'s record is ${price.taker.scored} of ${price.taker.attempts} (${pct(price.taker.rate)}), which moves the price to ${pct(price.p)}.`
        : `Penalties are scored ${pct(price.base)} of the time (${sample}). No record for ${player}, so the base rate stands.`;
      out.push({
        templateId: TEMPLATES.soccerPenalty,
        kind: 'moment',
        question: `Will ${player} score this penalty?`,
        hook: `Penalty! ${player} steps up. The model says ${pct(price.p)}.`,
        outcomes: YES_NO,
        prior: normalizePrior({ yes: price.p, no: 1 - price.p }),
        lockAfterSecs: 20,
        lockOnEvent: 'penalty_result',
        resolver: { type: 'penalty_result', params: { team: event.team, player: event.player, rationale } },
        priority: 100,
        rationale,
      });
    }

    if (event.type === 'corner' && typeof event.data.shotOnTarget !== 'boolean') {
      const p = cornerShotOnTargetProb();
      const teamName = side ? state[side].name : 'them';
      const c = SOCCER_TABLE.corner;
      const rationale = `About ${pct(p)} of corners lead to a shot on target within ${c.window_secs} seconds${c.corners > 0 ? ` (${c.corners.toLocaleString('en-US')} corners in StatsBomb open data)` : ''}.`;
      out.push({
        templateId: TEMPLATES.soccerCorner,
        kind: 'moment',
        question: `Shot on target from this ${teamName} corner?`,
        hook: `Corner to ${teamName}. Only ${pct(p)} of these end with a shot on target.`,
        outcomes: YES_NO,
        prior: normalizePrior({ yes: p, no: 1 - p }),
        lockAfterSecs: 20,
        resolver: { type: 'corner_outcome', params: { team: event.team, rationale } },
        priority: 40,
        rationale,
      });
    }

    if (event.type === 'card' && period === 1 && minute <= 38) {
      const p = cardBeforeHalfProb(minute);
      const perHalf = SOCCER_TABLE.cards.per_match_first_half;
      const rationale = `First halves average ${perHalf.toFixed(1)} cards. With ${Math.max(0, 45 - minute)} minutes to the break, a Poisson model gives ${pct(p)} for at least one more.`;
      out.push({
        templateId: TEMPLATES.soccerCard,
        kind: 'moment',
        question: 'Another card before halftime?',
        hook: `${event.player ?? 'Someone'} is in the book. Does the referee go to his pocket again before the break?`,
        outcomes: YES_NO,
        prior: normalizePrior({ yes: p, no: 1 - p }),
        lockAfterSecs: 30,
        lockOnEvent: 'card|period_end:1',
        resolver: { type: 'card_count', params: { period: 1, rationale } },
        priority: 35,
        rationale,
      });
    }

    if (period >= 2 && minute >= 60 && minute < 85 && !memo.fired.includes(TEMPLATES.soccerNextGoal)) {
      memo.fired.push(TEMPLATES.soccerNextGoal);
      const rem = remainingRates(rates, minute);
      const ng = nextGoalProbs(rem.home, rem.away);
      const prior = normalizePrior({ home: ng.home, away: ng.away, none: ng.none });
      const rationale = `With ${90 - minute} minutes left the model expects ${(rem.home + rem.away).toFixed(2)} more goals: ${pct(prior.none!)} there are none, otherwise split ${home.name} ${pct(prior.home!)}, ${away.name} ${pct(prior.away!)} by scoring rate.`;
      out.push({
        templateId: TEMPLATES.soccerNextGoal,
        kind: 'game',
        question: `Next goal: ${home.name}, ${away.name} or none?`,
        hook: `${minute} minutes gone at ${score.home}-${score.away}. Who gets the next one?`,
        outcomes: [
          { id: 'home', label: home.name },
          { id: 'away', label: away.name },
          { id: 'none', label: 'No more goals' },
        ],
        prior,
        lockOnEvent: 'goal|minute:85',
        resolver: { type: 'next_goal', params: { startHome: score.home, startAway: score.away, rationale } },
        priority: 60,
        rationale,
      });
    }

    if (event.type === 'period_start' && Number(event.data.period ?? period) === 2) {
      const w = matchProbs(rates.home / 2, rates.away / 2);
      const prior = normalizePrior({ home: w.home, draw: w.draw, away: w.away });
      const rationale = `Half a match of the Poisson goal model (${(rates.home / 2).toFixed(2)} and ${(rates.away / 2).toFixed(2)} expected goals): ${home.name} ${pct(prior.home!)}, level ${pct(prior.draw!)}, ${away.name} ${pct(prior.away!)}.`;
      out.push({
        templateId: TEMPLATES.periodWinner,
        kind: 'game',
        question: 'Who wins the second half?',
        hook: 'Fresh 45 minutes. Only second-half goals count for this one.',
        outcomes: [
          { id: 'home', label: home.name },
          { id: 'draw', label: 'Level' },
          { id: 'away', label: away.name },
        ],
        prior,
        lockAfterSecs: 30,
        lockOnEvent: 'period_end:2',
        resolver: { type: 'period_winner', params: { periods: [2], label: 'second half', startHome: score.home, startAway: score.away, rationale } },
        geminiHint: { kind: 'period_winner', period: '2H' },
        priority: 22,
        rationale,
      });
    }

    return out;
  }

  private proposeNfl(event: GameEvent, state: GameState, memo?: GameMemo): MarketCandidate[] {
    const out: MarketCandidate[] = [];
    const { home, away } = state;
    const strength = this.model(event.gameId).nfl;
    const score = event.score ?? state.score;
    const side = sideOf(state, event.team) ?? state.possession;
    const offense = side ? state[side] : undefined;
    const offenseNick = offense ? nick(offense, 'nfl') : 'offense';
    const scoreDiff = side ? (side === 'home' ? score.home - score.away : score.away - score.home) : 0;
    const secondsRemaining = num(event.data.secondsRemaining) ?? state.secondsRemaining ?? 1800;
    const seasons = NFL_TABLE.seasons?.length ? `nflverse ${NFL_TABLE.seasons[0]} to ${NFL_TABLE.seasons[NFL_TABLE.seasons.length - 1]}` : 'published league rates';
    const strengthNote = strength.source === 'gemini' ? 'calibrated to Gemini' : 'league-average teams';

    const periodCandidate = (key: PeriodKey, periods: number[], label: string, hintPeriod: string): MarketCandidate => {
      const p = periodWinnerProbs(key, strength);
      const prior = normalizePrior({ home: p.home, tie: p.tie, away: p.away });
      const rationale = `Home teams have won the ${label} ${pct(NFL_TABLE.period_winner[key]?.home ?? p.home)} of the time and tied it ${pct(p.tie)} (${seasons}); ${strengthNote}: ${nick(home, 'nfl')} ${pct(prior.home!)}, tie ${pct(prior.tie!)}, ${nick(away, 'nfl')} ${pct(prior.away!)}.`;
      return {
        templateId: TEMPLATES.periodWinner,
        kind: 'game',
        question: `Who wins the ${label}?`,
        hook: `New ${label.includes('half') ? 'half' : 'quarter'}, clean slate. Only points in the ${label} count.`,
        outcomes: [
          { id: 'home', label: nick(home, 'nfl') },
          { id: 'tie', label: 'Tie' },
          { id: 'away', label: nick(away, 'nfl') },
        ],
        prior,
        lockAfterSecs: 30,
        lockOnEvent: `period_end:${periods[periods.length - 1]}`,
        resolver: { type: 'period_winner', params: { periods, label, startHome: score.home, startAway: score.away, rationale } },
        geminiHint: { kind: 'period_winner', period: hintPeriod },
        priority: 22,
        rationale,
      };
    };

    if (event.type === 'kickoff') {
      const pHome = nflWinProb(strength, score.home - score.away, secondsRemaining);
      const winRationale =
        strength.source === 'gemini'
          ? `Opening price calibrated to Gemini's moneyline: ${nick(home, 'nfl')} ${pct(pHome)}.`
          : `No market to calibrate to, so this is the league home-win rate (${seasons}): ${nick(home, 'nfl')} ${pct(pHome)}.`;
      out.push({
        templateId: TEMPLATES.nflWinner,
        kind: 'game',
        question: `Who wins: ${nick(away, 'nfl')} or ${nick(home, 'nfl')}?`,
        hook: `${nick(away, 'nfl')} at ${nick(home, 'nfl')}. Pick your winner before the fourth quarter.`,
        outcomes: [
          { id: 'home', label: nick(home, 'nfl') },
          { id: 'away', label: nick(away, 'nfl') },
        ],
        prior: normalizePrior({ home: pHome, away: 1 - pHome }),
        lockOnEvent: 'period_end:3',
        resolver: { type: 'match_winner', params: { rationale: winRationale } },
        geminiHint: { kind: 'moneyline' },
        priority: 30,
        rationale: winRationale,
      });

      const line = strength.totalLine;
      const pOver = totalOverProb(strength, line, score.home + score.away, secondsRemaining);
      const totalRationale = `Games average ${NFL_TABLE.points.mean_total.toFixed(1)} points with a spread of ${NFL_TABLE.points.sd_total.toFixed(1)} (${seasons}); expected total here is ${strength.totalMean.toFixed(1)} (${strengthNote}), so over ${line} is ${pct(pOver)}.`;
      out.push({
        templateId: TEMPLATES.nflTotal,
        kind: 'game',
        question: `Total points: over or under ${line}?`,
        hook: `Shootout or slugfest? The line is ${line}.`,
        outcomes: [
          { id: 'over', label: `Over ${line}` },
          { id: 'under', label: `Under ${line}` },
        ],
        prior: normalizePrior({ over: pOver, under: 1 - pOver }),
        lockOnEvent: 'period_end:3',
        resolver: { type: 'total_points', params: { line, rationale: totalRationale } },
        geminiHint: { kind: 'total', line },
        priority: 25,
        rationale: totalRationale,
      });

      out.push(periodCandidate('Q1', [1], '1st quarter', '1Q'));
    }

    if (event.type === 'period_start') {
      const p = Number(event.data.period ?? event.clock?.period);
      if (p === 2) out.push(periodCandidate('Q2', [2], '2nd quarter', '2Q'));
      if (p === 3) out.push(periodCandidate('H2', [3, 4], '2nd half', '2H'));
      if (p === 4) out.push(periodCandidate('Q4', [4], '4th quarter', '4Q'));
    }

    if (event.type === 'drive_start' && offense) {
      const yardline = clamp(num(event.data.yardline) ?? 25, 1, 99);
      const d = driveResultProbs({ yardline, scoreDiff, secondsRemaining });
      const prior = normalizePrior({ td: d.td, fg: d.fg, none: d.none });
      const where = yardline <= 50 ? `their own ${yardline}` : `the opponent's ${100 - yardline}`;
      const rationale = `Drives starting at ${where} end in a touchdown ${pct(prior.td!)}, a field goal ${pct(prior.fg!)} and no points ${pct(prior.none!)} of the time (${seasons}, ${d.model === 'multinomial' ? 'regression on field position, score and clock' : `${d.n.toLocaleString('en-US')} drives`}).`;
      out.push({
        templateId: TEMPLATES.nflDrive,
        kind: 'moment',
        question: `${offenseNick} drive: touchdown, field goal or no score?`,
        hook: `${offenseNick} ball at ${where}. How does this drive end?`,
        outcomes: [
          { id: 'td', label: 'Touchdown' },
          { id: 'fg', label: 'Field goal' },
          { id: 'none', label: 'No score' },
        ],
        prior,
        lockAfterSecs: 20,
        resolver: { type: 'drive_result', params: { team: event.team, startHome: score.home, startAway: score.away, rationale } },
        priority: 50,
        rationale,
      });
      if (yardline >= 80) out.push(this.redZoneCandidate(event.team, offenseNick, yardline, score, seasons));
    }

    if (event.type === 'snap' && offense) {
      const down = num(event.data.down);
      const distance = num(event.data.distance);
      const yardline = clamp(num(event.data.yardline) ?? state.yardline ?? 50, 1, 99);
      if (down !== undefined && distance !== undefined) {
        const toGo = distance >= 100 - yardline ? 'goal' : String(distance);
        if (down === 3 || down === 4) {
          const goForIt = event.data.goForIt === true;
          const kicking = event.data.kick === true || event.data.punt === true;
          const price = conversionProb({ down, distance, yardline, scoreDiff, secondsRemaining, goForIt });
          // On 4th down only ask when a real attempt is plausible.
          if (!kicking && (down === 3 || goForIt || price.p >= 0.1)) {
            const table = `Teams that run a play convert ${ordinal(down)} and ${toGo} ${pct(price.tableRate)} of the time (${seasons}${price.tableN ? `, ${price.tableN.toLocaleString('en-US')} plays` : ''})`;
            const adj = price.model === 'logit' ? `; the trained model, which also sees field position, score and clock, says ${pct(price.playRate)}` : '';
            const go = down === 4 && !goForIt ? `. They only go for it ${pct(price.goRate)} of the time from here, so the price is ${pct(price.p)}` : '';
            const rationale = `${table}${adj}${go}.`;
            out.push({
              templateId: TEMPLATES.nflConversion,
              kind: 'moment',
              question: `Do the ${offenseNick} convert on ${ordinal(down)} & ${toGo}?`,
              hook: `${ordinal(down)} and ${toGo} for the ${offenseNick}. The model says ${pct(price.p)}.`,
              outcomes: YES_NO,
              prior: normalizePrior({ yes: price.p, no: 1 - price.p }),
              lockAfterSecs: 15,
              lockOnEvent: 'play_result',
              resolver: { type: 'first_down_result', params: { team: event.team, down, distance, rationale } },
              priority: (down === 4 ? 78 : 70) + Math.round(5 * (1 - Math.abs(price.p - 0.5) * 2)),
              rationale,
            });
          }
        } else if (down === 1 || down === 2) {
          const price = passProb({ down, distance, yardline, scoreDiff, secondsRemaining });
          const rationale = `Offenses throw on ${ordinal(down)} and ${toGo} ${pct(price.tableRate)} of the time (${seasons})${price.model === 'logit' ? `; with field position, score and clock the trained model says ${pct(price.p)}` : ''}.`;
          out.push({
            templateId: TEMPLATES.nflRunPass,
            kind: 'moment',
            question: `Run or pass on ${ordinal(down)} & ${toGo}?`,
            hook: `${offenseNick} at the line. Run or pass?`,
            outcomes: [
              { id: 'run', label: 'Run' },
              { id: 'pass', label: 'Pass' },
            ],
            prior: normalizePrior({ run: 1 - price.p, pass: price.p }),
            lockAfterSecs: 15,
            lockOnEvent: 'play_result',
            resolver: { type: 'play_type', params: { team: event.team, rationale } },
            priority: 20,
            rationale,
          });
        }
      }
    }

    if (event.type === 'play_result' && offense && event.data.noPlay !== true) {
      const start = num(event.data.yardline);
      const gained = num(event.data.gained) ?? 0;
      const down = num(event.data.down) ?? 1;
      const firstDown = event.data.firstDown === true;
      const over = event.data.touchdown === true || event.data.turnover === true;
      const kicked = event.data.playType === 'kick' || event.data.playType === 'punt';
      // Red zone entry: this play moved the ball inside the 20 and the offense keeps a real chance.
      if (start !== undefined && start < 80 && start + gained >= 80 && !over && !kicked && (firstDown || down <= 2)) {
        out.push(this.redZoneCandidate(event.team, offenseNick, clamp(start + gained, 80, 99), score, seasons));
      }
    }

    // Late in a quarter (2:30 to 0:30 left) and still in doubt: who wins the quarter? Gemini trades quarter
    // moneylines, so in a replayed real game this shows Gemini's real in-game price beside the room's.
    const period = event.clock?.period ?? state.clock.period;
    const inPeriod = period >= 1 && period <= 4 ? secondsRemaining - (4 - period) * 900 : -1;
    if (memo && (event.type === 'play_result' || event.type === 'snap' || event.type === 'drive_start') && inPeriod <= 150 && inPeriod >= 30 && !memo.fired.includes(`nfl.q${period}`)) {
      const prev = state.periodScores.filter((x) => x.period < period).sort((a, b) => b.period - a.period)[0];
      const startHome = prev?.home ?? 0;
      const startAway = prev?.away ?? 0;
      const lead = score.home - startHome - (score.away - startAway);
      const q = nflQuarterProbs(lead, inPeriod, strength.pHome);
      if (Math.max(q.home, q.away, q.tie) <= 0.8) {
        memo.fired.push(`nfl.q${period}`);
        const prior = normalizePrior({ home: q.home, tie: q.tie, away: q.away });
        const label = `${ordinal(period)} quarter`;
        const hn = nick(home, 'nfl');
        const an = nick(away, 'nfl');
        const clockText = `${Math.floor(inPeriod / 60)}:${String(Math.round(inPeriod % 60)).padStart(2, '0')}`;
        const rationale = `${lead === 0 ? 'Level' : `${lead > 0 ? hn : an} up ${Math.abs(lead)}`} in the ${label} with ${clockText} left. Scores arrive at the league rate (about one every ${Math.round(4.7 / ((NFL_TABLE.points.mean_total || 44) / 2) * 60)} minutes per team, 35% field goals): ${hn} ${pct(prior.home!)}, tie ${pct(prior.tie!)}, ${an} ${pct(prior.away!)}.`;
        out.push({
          templateId: TEMPLATES.nflQuarter, kind: 'moment', question: `Who wins the ${label}?`, hook: `${clockText} left in the ${label}.`,
          outcomes: [{ id: 'home', label: hn }, { id: 'tie', label: 'Tie' }, { id: 'away', label: an }], prior,
          lockAfterSecs: 15, lockOnEvent: `period_end:${period}`,
          resolver: { type: 'period_winner', params: { periods: [period], label, startHome, startAway, rationale } },
          geminiHint: { kind: 'period_winner', period: `${period}Q` }, priority: 72, rationale,
        });
      }
    }

    return out;
  }

  private proposeNba(event: GameEvent, state: GameState, memo: GameMemo): MarketCandidate[] {
    const out: MarketCandidate[] = [];
    const { home, away } = state;
    const s = this.model(event.gameId).nba!;
    const score = event.score ?? state.score;
    const secs = num(event.data.secondsRemaining) ?? state.secondsRemaining ?? NBA.gameSeconds;
    const period = event.clock?.period ?? state.clock.period;
    const inPeriod = period > 4 ? secs : secs - (4 - period) * 720;
    const hn = nick(home, 'nba');
    const an = nick(away, 'nba');
    const src = s.source === 'gemini' ? 'calibrated to Gemini' : NBA.source;
    const fire = (key: string): boolean => {
      if (memo.fired.includes(key)) return false;
      memo.fired.push(key);
      return true;
    };

    if (event.type === 'kickoff') {
      const pHome = nbaWinProb(s, 0, NBA.gameSeconds);
      const rationale = s.source === 'gemini' ? `Opening price calibrated to Gemini's moneyline: ${hn} ${pct(pHome)}.` : `No market to calibrate to, so this is the NBA home-win rate: ${hn} ${pct(pHome)}.`;
      out.push({
        templateId: TEMPLATES.nbaWinner, kind: 'game', question: `Who wins: ${an} or ${hn}?`, hook: `${an} at ${hn}. Pick your winner.`,
        outcomes: [{ id: 'home', label: hn }, { id: 'away', label: an }], prior: normalizePrior({ home: pHome, away: 1 - pHome }),
        lockOnEvent: 'period_end:3', resolver: { type: 'match_winner', params: { rationale } }, geminiHint: { kind: 'moneyline' }, priority: 30, rationale,
      });
      const line = s.totalLine;
      const pOver = nbaTotalOverProb(s, line, 0, NBA.gameSeconds);
      const tr = `NBA games average about ${NBA.meanTotal} points (sd ${NBA.totalSd}); expected total here is ${s.totalMean.toFixed(1)} (${src}), so over ${line} is ${pct(pOver)}.`;
      out.push({
        templateId: TEMPLATES.nbaTotal, kind: 'game', question: `Total points: over or under ${line}?`, hook: `The line is ${line}.`,
        outcomes: [{ id: 'over', label: `Over ${line}` }, { id: 'under', label: `Under ${line}` }], prior: normalizePrior({ over: pOver, under: 1 - pOver }),
        lockOnEvent: 'period_end:3', resolver: { type: 'total_points', params: { line, rationale: tr } }, geminiHint: { kind: 'total', line }, priority: 25, rationale: tr,
      });
    }

    // Free throws: does the shooter make them all?
    if (event.type === 'free_throw' && event.data.trip === true) {
      const n = clamp(num(event.data.attempts) ?? 2, 1, 3);
      const p = ftAllProb(n);
      const who = event.player ?? `the ${nick(sideOf(state, event.team) === 'away' ? away : home, 'nba')} shooter`;
      const rationale = `NBA players make about ${pct(NBA.ftPct)} of free throws, so ${n === 3 ? 'three' : 'two'} in a row is ${pct(p)} (league rate; no per-player data in this replay).`;
      out.push({
        templateId: TEMPLATES.nbaFreeThrows, kind: 'moment', question: `Will ${who} make ${n === 3 ? 'all three' : 'both'} free throws?`,
        hook: `${who} at the line. The model says ${pct(p)}.`, outcomes: YES_NO, prior: normalizePrior({ yes: p, no: 1 - p }),
        lockAfterSecs: 15, lockOnEvent: 'free_throw', resolver: { type: 'ft_trip', params: { player: event.player, team: event.team, attempts: n, rationale } },
        priority: 90, rationale,
      });
    }

    // After a timeout: does the team with the ball score next?
    if (event.type === 'timeout' && typeof event.data.ball === 'string') {
      const side = sideOf(state, event.data.ball);
      if (side) {
        const team = nick(state[side], 'nba');
        const p = nextScoreProb();
        const rationale = `NBA possessions score about ${pct(NBA.possessionScore)} of the time; with the ball first, the ${team} score next ${pct(p)} of the time.`;
        out.push({
          templateId: TEMPLATES.nbaNextScore, kind: 'moment', question: `Out of the timeout: do the ${team} score next?`, hook: `Timeout. ${team} ball.`,
          outcomes: YES_NO, prior: normalizePrior({ yes: p, no: 1 - p }), lockAfterSecs: 15, lockOnEvent: 'shot|free_throw|turnover',
          resolver: { type: 'next_score', params: { team: event.data.ball, rationale } }, priority: 75, rationale,
        });
      }
    }

    // Start of quarters 2-4: a made three in the first two minutes?
    if (event.type === 'period_start' && period >= 2 && period <= 4) {
      const p = threeInWindowProb(120);
      const rationale = `NBA teams combine for about ${Math.round(NBA.threesPerMinute * 48)} made threes a game, so at least one in any two minutes is about ${pct(p)} (Poisson).`;
      out.push({
        templateId: TEMPLATES.nbaThree, kind: 'moment', question: `A made three in the first 2 minutes of the ${ordinal(period)} quarter?`, hook: 'Fresh quarter. Anyone hot from deep?',
        outcomes: YES_NO, prior: normalizePrior({ yes: p, no: 1 - p }), lockAfterSecs: 12,
        resolver: { type: 'three_window', params: { period, untilSecs: 600, rationale } }, priority: 45, rationale,
      });
    }

    // Late in a quarter: who wins it? (asked with about 2:30 left so it settles quickly)
    // Only while the quarter is still in doubt (neither side above 80%): a 95% question is no fun.
    const prev = state.periodScores.filter((x) => x.period < period).sort((a, b) => b.period - a.period)[0];
    const startHome = prev?.home ?? 0;
    const startAway = prev?.away ?? 0;
    const lead = score.home - startHome - (score.away - startAway);
    const q = nbaQuarterProbs(s, lead, Math.max(1, inPeriod));
    if (period >= 1 && period <= 4 && inPeriod <= 150 && inPeriod > 30 && Math.max(q.home, q.away) <= 0.8 && fire(`nba.q${period}`)) {
      const prior = normalizePrior({ home: q.home, tie: q.tie, away: q.away });
      const label = `${ordinal(period)} quarter`;
      const rationale = `${hn} ${lead >= 0 ? 'lead' : 'trail'} the ${label} ${Math.abs(lead)} with ${Math.floor(inPeriod / 60)}:${String(Math.round(inPeriod % 60)).padStart(2, '0')} left; a normal model of scoring margin (sd ${NBA.marginSd} over a game) gives ${hn} ${pct(prior.home!)}, tie ${pct(prior.tie!)}, ${an} ${pct(prior.away!)}.`;
      out.push({
        templateId: TEMPLATES.nbaQuarter, kind: 'moment', question: `Who wins the ${label}?`, hook: `Under three minutes left in the ${label}.`,
        outcomes: [{ id: 'home', label: hn }, { id: 'tie', label: 'Tie' }, { id: 'away', label: an }], prior,
        lockAfterSecs: 15, lockOnEvent: `period_end:${period}`,
        resolver: { type: 'period_winner', params: { periods: [period], label, startHome, startAway, rationale } },
        geminiHint: { kind: 'period_winner', period: `${period}Q` }, priority: 72, rationale,
      });
    }

    // Crunch time: can the leader hold on? Proposed on every play of the last 75 seconds of a close game (the
    // freshest one replaces the last), so whichever fits the room is asked.
    const margin = score.home - score.away;
    const play = event.type === 'shot' || event.type === 'turnover' || event.type === 'timeout' || (event.type === 'free_throw' && event.data.trip !== true);
    if (period >= 4 && secs <= 75 && secs > 8 && Math.abs(margin) <= 5 && play) {
      const pHome = nbaWinProb(s, margin, secs);
      const leader: 'home' | 'away' = margin >= 0 ? 'home' : 'away';
      const ln = nick(state[leader], 'nba');
      const rationale = `${margin === 0 ? 'Level' : `Up ${Math.abs(margin)}`} with ${Math.round(secs)} seconds left, a normal model of the remaining margin gives the ${ln} ${pct(leader === 'home' ? pHome : 1 - pHome)}.`;
      out.push({
        templateId: TEMPLATES.nbaClutch, kind: 'moment', question: margin === 0 ? `All square late: do the ${hn} win it?` : `Crunch time: do the ${ln} hold on?`,
        hook: 'Crunch time.', outcomes: [{ id: 'home', label: hn }, { id: 'away', label: an }], prior: normalizePrior({ home: pHome, away: 1 - pHome }),
        lockAfterSecs: 20, resolver: { type: 'match_winner', params: { leader, rationale } }, geminiHint: { kind: 'moneyline' }, priority: 85, rationale,
      });
    }

    // Late total: the line is set at the projected total, so it is a coin flip on pace.
    if (period >= 4 && secs <= 270 && secs > 60 && fire('nba.late_total')) {
      const so = score.home + score.away;
      const line = nearestHalfPoint(so + expectedRemainingPoints(s, so, secs));
      const p = nbaTotalOverProb(s, line, so, secs);
      const rationale = `${so} points so far; at this pace and the pregame expectation about ${(line - so).toFixed(0)} more are coming in the last ${Math.round(secs / 60)} minutes, so over ${line} is ${pct(p)}.`;
      out.push({
        templateId: TEMPLATES.nbaLateTotal, kind: 'moment', question: `Over ${line} total points by the final buzzer?`, hook: 'Pace check.',
        outcomes: [{ id: 'over', label: `Over ${line}` }, { id: 'under', label: `Under ${line}` }], prior: normalizePrior({ over: p, under: 1 - p }),
        lockAfterSecs: 20, resolver: { type: 'total_points', params: { line, rationale } }, priority: 60, rationale,
      });
    }
    return out;
  }

  private redZoneCandidate(team: string | undefined, offenseNick: string, yardline: number, score: { home: number; away: number }, seasons: string): MarketCandidate {
    const rz = redZoneProbs(yardline);
    const rationale = `Drives that reach the ${100 - yardline}-yard line end in a touchdown ${pct(rz.td)} of the time and a field goal ${pct(rz.fg)} (${seasons}${rz.n ? `, ${rz.n.toLocaleString('en-US')} red-zone trips` : ''}).`;
    return {
      templateId: TEMPLATES.nflRedZone,
      kind: 'moment',
      question: `Touchdown for the ${offenseNick} on this possession?`,
      hook: `${offenseNick} are in the red zone. Six, or do they settle?`,
      outcomes: YES_NO,
      prior: normalizePrior({ yes: rz.td, no: 1 - rz.td }),
      lockAfterSecs: 20,
      resolver: { type: 'drive_result', params: { team, binary: true, startHome: score.home, startAway: score.away, rationale } },
      priority: 80,
      rationale,
    };
  }

  // ───────────────────────── lock ─────────────────────────

  /**
   * `lock.onEvent` grammar: alternatives separated by `|`; each is an event type, optionally
   * qualified: `period_end:2` (that period or later), `minute:80` (match minute reached).
   * `final` always locks.
   */
  shouldLock(market: Market, event: GameEvent, state: GameState): boolean {
    if (market.createdAtSeq !== undefined && event.seq <= market.createdAtSeq) return false;
    if (event.type === 'final') return true;
    const on = market.lock?.onEvent;
    if (!on) return false;
    for (const alt of on.split('|')) {
      const [type, arg] = alt.trim().split(':');
      if (!type) continue;
      if (type === 'minute') {
        const minute = Math.max(state.minute ?? 0, num(event.data?.minute) ?? 0);
        if (arg !== undefined && minute >= Number(arg)) return true;
        continue;
      }
      if (event.type !== type) continue;
      if (arg === undefined) return true;
      const period = Number(event.data?.period ?? event.clock?.period);
      if (type === 'period_end' ? period >= Number(arg) : period === Number(arg)) return true;
    }
    return false;
  }

  // ───────────────────────── resolve ─────────────────────────

  evaluate(market: Market, event: GameEvent, state: GameState): ResolverResult {
    // Never resolve from the event that created the market, or anything before it.
    if (market.createdAtSeq !== undefined && event.seq <= market.createdAtSeq) return null;
    if (event.data?.catchUp === true && market.createdAtSeq === undefined) return null;

    const params = market.resolver?.params ?? {};
    const type = market.resolver?.type;
    const score = event.score ?? state.score;
    const isFinal = event.type === 'final';
    const has = (id: string): boolean => market.outcomes.some((o) => o.id === id);
    const pick = (id: string): ResolverResult => (has(id) ? { outcome: id } : { void: true, reason: `outcome "${id}" is not on this market` });
    const evSide = sideOf(state, event.team);
    const mSide = sideOf(state, typeof params.team === 'string' ? params.team : undefined);
    const sameTeam = !mSide || !evSide || mSide === evSide;

    switch (type) {
      case 'penalty_result': {
        if (event.type === 'penalty_result' && sameTeam) {
          if (typeof event.data.scored !== 'boolean') return { void: true, reason: 'penalty result was ambiguous in the feed' };
          return pick(event.data.scored ? 'yes' : 'no');
        }
        if (event.type === 'period_end' || isFinal) return { void: true, reason: 'no penalty result arrived from the feed' };
        return null;
      }

      case 'total_goals': {
        const n = Number(params.n);
        if (!Number.isFinite(n)) return { void: true, reason: 'market has no goal threshold' };
        const side = params.side === 'home' || params.side === 'away' ? params.side : undefined;
        const goals = side ? score[side] : score.home + score.away;
        if (goals >= n) return pick('yes');
        if (isFinal) return pick('no');
        return null;
      }

      case 'total_points': {
        const line = Number(params.line);
        if (!Number.isFinite(line)) return { void: true, reason: 'market has no points line' };
        const total = score.home + score.away;
        if (total > line) return pick('over');
        if (isFinal) return total === line ? { void: true, reason: 'total landed exactly on the line' } : pick('under');
        return null;
      }

      case 'next_goal': {
        const startHome = num(params.startHome) ?? 0;
        const startAway = num(params.startAway) ?? 0;
        const dHome = score.home - startHome;
        const dAway = score.away - startAway;
        if (dHome > 0 && dAway > 0) return { void: true, reason: 'both teams scored between updates; order unknown' };
        if (dHome > 0) return pick('home');
        if (dAway > 0) return pick('away');
        if (event.type === 'goal') return evSide ? pick(evSide) : { void: true, reason: 'goal had no team in the feed' };
        if (isFinal) return pick('none');
        return null;
      }

      case 'corner_outcome': {
        if (event.type === 'corner' && sameTeam && typeof event.data.shotOnTarget === 'boolean') return pick(event.data.shotOnTarget ? 'yes' : 'no');
        if (event.type === 'goal' && mSide && evSide === mSide) return pick('yes');
        if (event.type === 'corner' && typeof event.data.shotOnTarget !== 'boolean') return { void: true, reason: 'a new corner was awarded before this one was settled' };
        if (event.type === 'period_end' || isFinal) return { void: true, reason: 'the feed never reported how the corner ended' };
        return null;
      }

      case 'card_count': {
        const period = Number(params.period ?? 1);
        const evPeriod = Number(event.data?.period ?? event.clock?.period ?? state.clock.period);
        if (event.type === 'card' && evPeriod <= period) return pick('yes');
        if ((event.type === 'period_end' && evPeriod >= period) || evPeriod > period || isFinal) return pick('no');
        return null;
      }

      case 'first_down_result': {
        if (event.type === 'play_result' && sameTeam) {
          if (event.data.noPlay === true) return { void: true, reason: 'penalty on the play; the down is replayed' };
          return pick(event.data.firstDown === true || (event.data.touchdown === true && event.data.turnover !== true) ? 'yes' : 'no');
        }
        if (event.type === 'drive_end' || event.type === 'drive_start' || event.type === 'period_end' || isFinal) {
          return { void: true, reason: 'the play result never arrived from the feed' };
        }
        return null;
      }

      case 'play_type': {
        if (event.type === 'play_result' && sameTeam) {
          if (event.data.noPlay === true) return { void: true, reason: 'penalty on the play; no play' };
          const pt = event.data.playType;
          if (pt === 'run' || pt === 'pass') return pick(pt);
          return { void: true, reason: `the play was a ${String(pt ?? 'unknown play')}, neither run nor pass` };
        }
        if (event.type === 'drive_end' || event.type === 'drive_start' || event.type === 'period_end' || isFinal) {
          return { void: true, reason: 'the play result never arrived from the feed' };
        }
        return null;
      }

      case 'drive_result': {
        const binary = params.binary === true;
        const done = (r: 'td' | 'fg' | 'none'): ResolverResult => (binary ? pick(r === 'td' ? 'yes' : 'no') : pick(r));
        if (event.type === 'play_result' && sameTeam && event.data.noPlay !== true) {
          if (event.data.turnover === true) return done('none');
          if (event.data.touchdown === true) return done('td');
          if (event.data.playType === 'kick') return done(event.data.good === true ? 'fg' : 'none');
          if (event.data.playType === 'punt') return done('none');
          return null;
        }
        if (event.type === 'drive_end' && sameTeam) {
          const r = String(event.data.result ?? '').toLowerCase();
          if (r === 'td' || r === 'touchdown') return done('td');
          if (r === 'fg' || r === 'field_goal' || r === 'field goal') return done('fg');
          return done('none');
        }
        if (event.type === 'drive_start' || event.type === 'drive_end' || isFinal) {
          // The drive ended without a drive_end for this team: infer from the scoreboard.
          const side = mSide;
          if (!side) return isFinal ? done('none') : { void: true, reason: 'drive ended without a result in the feed' };
          const start = num(side === 'home' ? params.startHome : params.startAway);
          if (start === undefined) return done('none');
          const delta = score[side] - start;
          if (delta >= 6) return done('td');
          if (delta === 3) return done('fg');
          return done('none');
        }
        return null;
      }

      case 'period_winner': {
        const periods = Array.isArray(params.periods) ? (params.periods as unknown[]).map(Number).filter(Number.isFinite) : [Number(params.period)];
        const last = Math.max(...periods);
        if (!Number.isFinite(last)) return isFinal ? { void: true, reason: 'market has no period' } : null;
        const endsNow = event.type === 'period_end' && Number(event.data?.period ?? event.clock?.period) >= last;
        if (!endsNow && !isFinal) return null;
        const h = score.home - (num(params.startHome) ?? 0);
        const a = score.away - (num(params.startAway) ?? 0);
        if (h > a) return pick('home');
        if (a > h) return pick('away');
        return has('tie') ? pick('tie') : pick('draw');
      }

      // ---- basketball ----
      case 'ft_trip': {
        if (event.type === 'free_throw' && event.data.trip !== true && event.data.technical !== true) {
          const samePlayer = typeof params.player === 'string' ? event.player === params.player : sameTeam;
          if (!samePlayer) return null;
          if (event.data.made !== true) return pick('no');
          const n = num(event.data.n);
          const of = num(event.data.of) ?? num(params.attempts);
          if (n !== undefined && of !== undefined && n >= of) return pick('yes');
          return null;
        }
        if (event.type === 'period_end' || isFinal) return { void: true, reason: 'the free throws never arrived from the feed' };
        return null;
      }

      case 'next_score': {
        const pts = num(event.data.points) ?? 0;
        const scored = (event.type === 'shot' || event.type === 'free_throw') && event.data.made === true && pts > 0;
        if (scored) return mSide && evSide ? pick(evSide === mSide ? 'yes' : 'no') : { void: true, reason: 'the basket had no team in the feed' };
        if (event.type === 'period_end' || isFinal) return { void: true, reason: 'nobody scored before the end of the quarter' };
        return null;
      }

      case 'three_window': {
        const p = Number(params.period);
        const until = num(params.untilSecs) ?? 600;
        const evPeriod = Number(event.data?.period ?? event.clock?.period ?? state.clock.period);
        const secs = num(event.data.secondsRemaining) ?? state.secondsRemaining;
        const inPeriod = secs !== undefined ? secs - Math.max(0, 4 - evPeriod) * 720 : undefined;
        if (event.type === 'shot' && event.data.made === true && event.data.three === true && evPeriod === p && (inPeriod === undefined || inPeriod >= until)) return pick('yes');
        if (evPeriod > p || isFinal || (event.type === 'period_end' && evPeriod >= p) || (evPeriod === p && inPeriod !== undefined && inPeriod < until)) return pick('no');
        return null;
      }

      case 'match_winner': {
        if (!isFinal) return null;
        if (score.home > score.away) return pick('home');
        if (score.away > score.home) return pick('away');
        if (has('draw')) return pick('draw');
        if (has('tie')) return pick('tie');
        return { void: true, reason: 'the game ended level and this market has no draw outcome' };
      }

      default:
        return isFinal ? { void: true, reason: `unknown resolver "${String(type)}"` } : null;
    }
  }

  // ───────────────────────── live price ─────────────────────────

  reprice(market: Market, state: GameState): Record<string, number> | null {
    if (state.status === 'final') return null;
    const params = market.resolver?.params ?? {};
    const score = state.score;
    const model = this.model(state.gameId);

    if (state.sport === 'soccer') {
      const rem = remainingRates(model.soccer, state.minute ?? 0);
      switch (market.resolver?.type) {
        case 'match_winner': {
          const w = matchProbs(rem.home, rem.away, score.home - score.away);
          return this.fit(market, { home: w.home, draw: w.draw, away: w.away });
        }
        case 'total_goals': {
          const n = Number(params.n);
          const side = params.side === 'home' || params.side === 'away' ? params.side : undefined;
          const p = side ? goalsAtLeastProb(n, score[side], rem[side]) : goalsAtLeastProb(n, score.home + score.away, rem.home + rem.away);
          return this.fit(market, { yes: p, no: 1 - p });
        }
        case 'next_goal': {
          const ng = nextGoalProbs(rem.home, rem.away);
          return this.fit(market, { home: ng.home, away: ng.away, none: ng.none });
        }
        case 'period_winner': {
          if (state.clock.period < 2) return null;
          const w = matchProbs(rem.home, rem.away, score.home - (num(params.startHome) ?? 0) - (score.away - (num(params.startAway) ?? 0)));
          return this.fit(market, { home: w.home, draw: w.draw, away: w.away });
        }
        case 'card_count': {
          if (state.clock.period > 1) return null;
          const p = cardBeforeHalfProb(state.minute ?? 0);
          return this.fit(market, { yes: p, no: 1 - p });
        }
        default:
          return null;
      }
    }

    if (state.sport === 'nba') {
      const nba = model.nba!;
      const secs = state.secondsRemaining ?? NBA.gameSeconds;
      switch (market.resolver?.type) {
        case 'match_winner': {
          const p = nbaWinProb(nba, score.home - score.away, secs);
          return this.fit(market, { home: p, away: 1 - p });
        }
        case 'total_points': {
          const line = Number(params.line);
          if (!Number.isFinite(line)) return null;
          const p = nbaTotalOverProb(nba, line, score.home + score.away, secs);
          return this.fit(market, { over: p, under: 1 - p });
        }
        default:
          return null;
      }
    }

    const secs = state.secondsRemaining ?? 3600;
    switch (market.resolver?.type) {
      case 'match_winner': {
        const p = nflWinProb(model.nfl, score.home - score.away, secs);
        return this.fit(market, { home: p, away: 1 - p });
      }
      case 'total_points': {
        const line = Number(params.line);
        if (!Number.isFinite(line)) return null;
        const p = totalOverProb(model.nfl, line, score.home + score.away, secs);
        return this.fit(market, { over: p, under: 1 - p });
      }
      default:
        return null;
    }
  }

  /** Keep only this market's outcomes and normalize. */
  private fit(market: Market, raw: Record<string, number>): Record<string, number> | null {
    const picked: Record<string, number> = {};
    for (const o of market.outcomes) {
      const v = raw[o.id];
      if (v === undefined) return null;
      picked[o.id] = v;
    }
    return normalizePrior(picked, 0.01);
  }

  // ───────────────────────── Gemini calibration (P1) ─────────────────────────

  /**
   * Fit team strength to Gemini: moneyline mids set the win probability (NFL) or the Poisson rates
   * (soccer, when a three-way market exists); the total closest to 50% sets the expected total and
   * the line we quote. Unusable quotes are ignored and the defaults stay.
   */
  calibrate(game: GameInfo, quotes: GeminiEventQuote[]): void {
    const model = this.model(game.id);
    const sideOfContract = (label: string, ticker: string): Side | 'draw' | undefined => {
      const l = label.toLowerCase();
      if (/\b(tie|draw)\b/.test(l) || ticker.toUpperCase() === 'D') return 'draw';
      const hit = (team: TeamRef): boolean =>
        ticker.toUpperCase() === team.short.toUpperCase() ||
        ticker.toUpperCase().endsWith(`-${team.short.toUpperCase()}`) ||
        team.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length >= 3 && l.includes(w));
      const h = hit(game.home);
      const a = hit(game.away);
      if (h && !a) return 'home';
      if (a && !h) return 'away';
      return undefined;
    };

    const moneyline = quotes.find((q) => q.kind === 'moneyline' && !q.period);
    if (moneyline) {
      const probs: Partial<Record<Side | 'draw', number>> = {};
      for (const c of moneyline.contracts) {
        if (c.prob === null) continue;
        const s = sideOfContract(c.label, c.contractTicker);
        if (s) probs[s] = c.prob;
      }
      if (game.sport === 'nfl' || game.sport === 'nba') {
        const h = probs.home ?? (probs.away !== undefined ? 1 - probs.away : undefined);
        const a = probs.away ?? (probs.home !== undefined ? 1 - probs.home : undefined);
        if (h !== undefined && a !== undefined && h + a > 0) {
          if (game.sport === 'nfl') model.nfl = { ...model.nfl, pHome: clamp(h / (h + a), 0.03, 0.97), source: 'gemini' };
          else model.nba = { ...model.nba!, pHome: clamp(h / (h + a), 0.03, 0.97), source: 'gemini' };
        }
      } else if (probs.home !== undefined && probs.away !== undefined) {
        const draw = probs.draw ?? Math.max(0.05, 1 - probs.home - probs.away);
        model.soccer = goalRatesFromOdds(probs.home, draw, probs.away, 'gemini');
      }
    }

    if (game.sport === 'nfl') {
      const total = quotes.find((q) => q.kind === 'total' && !q.period);
      let best: { line: number; prob: number } | undefined;
      for (const c of total?.contracts ?? []) {
        if (c.prob === null) continue;
        const m = /more than\s+(\d+(?:\.\d+)?)\s+points/i.exec(c.label);
        if (!m) continue;
        const line = Number(m[1]);
        if (!best || Math.abs(c.prob - 0.5) < Math.abs(best.prob - 0.5)) best = { line, prob: c.prob };
      }
      if (best && best.prob > 0.1 && best.prob < 0.9) {
        model.nfl = { ...model.nfl, totalMean: totalMeanFromLine(best.line, best.prob), totalLine: Number.isInteger(best.line) ? nearestHalf(best.line) : best.line, source: 'gemini' };
      }
    }

    if (game.sport === 'nba') {
      const total = quotes.find((q) => q.kind === 'total' && !q.period);
      let best: { line: number; prob: number } | undefined;
      for (const c of total?.contracts ?? []) {
        if (c.prob === null) continue;
        const m = /more than\s+(\d+(?:\.\d+)?)\s+points/i.exec(c.label);
        if (!m) continue;
        const line = Number(m[1]);
        if (!best || Math.abs(c.prob - 0.5) < Math.abs(best.prob - 0.5)) best = { line, prob: c.prob };
      }
      if (best && best.prob > 0.1 && best.prob < 0.9) {
        // Mean that puts P(over line) at Gemini's price under the normal total model.
        const mean = best.line + NBA.totalSd * normalInvSafe(best.prob);
        model.nba = { ...model.nba!, totalMean: mean, totalLine: Number.isInteger(best.line) ? best.line + 0.5 : best.line, source: 'gemini' };
      }
    }
  }
}
