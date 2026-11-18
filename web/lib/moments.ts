// "Call it" moments: the host taps a moment on the kiosk ("Penalty!", "3rd down") the instant it happens,
// and a market opens right away with a model-priced question and a short trading window.
//
// Each moment has a short Latin-1 label (<= 12 chars, the kiosk fonts are Latin-1), a question written from
// the game situation when we know it (replay games), and a prior from the same models the question engine
// uses (nflverse / StatsBomb tables in config/models). Pure module apart from the model tables.
import { conversionProb, driveResultProbs, NFL_TABLE, redZoneProbs } from "./replay/nfl";
import { cornerShotOnTargetProb, defaultGoalRates, penaltyProb, SOCCER_TABLE } from "./replay/soccer";
import { ftAllProb, NBA, nextScoreProb, threeInWindowProb } from "./replay/nba";
import type { GameState, TeamRef } from "./replay/types";

export type MomentSport = "nfl" | "soccer" | "nba";

export interface MomentKind {
  kind: string;
  /** Kiosk button label, Latin-1, <= 11 chars (the box fits 4 buttons of 180 px). */
  label: string;
  /** Caption opener, e.g. "Penalty called!" */
  call: string;
  /** Trading window in seconds. */
  lockSecs: number;
  /** Engine templates that ask the same thing (replay games resolve those from the play-by-play). */
  templates: string[];
  /** The question and its model prior, from the game situation when there is one. */
  write(ctx: MomentContext): { text: string; short: string; prior: number; rationale: string };
}

export interface MomentContext {
  state?: GameState | null;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function nick(team: TeamRef | undefined, sport: MomentSport): string | null {
  if (!team) return null;
  if (sport !== "nfl") return team.name;
  const w = team.name.trim().split(/\s+/);
  return w.length > 1 ? w[w.length - 1] : team.name;
}

function offense(s: GameState | null | undefined): string | null {
  if (!s?.possession) return null;
  return nick(s[s.possession], "nfl");
}

const SEASONS = NFL_TABLE.seasons?.length ? `nflverse ${NFL_TABLE.seasons[0]}-${NFL_TABLE.seasons[NFL_TABLE.seasons.length - 1]}` : "league averages";

export const MOMENT_KINDS: Record<MomentSport, MomentKind[]> = {
  nfl: [
    {
      kind: "third_down", label: "3rd down", call: "Third down!", lockSecs: 20, templates: ["nfl.conversion"],
      write: ({ state }) => {
        const down = state?.down === 3 || state?.down === 4 ? state.down : 3;
        const distance = state?.distance ?? 5;
        const yardline = state?.yardline ?? 50;
        const p = conversionProb({ down, distance, yardline, scoreDiff: 0, secondsRemaining: state?.secondsRemaining ?? 1800 }).p;
        const team = offense(state);
        const togo = state?.distance !== undefined ? ` & ${distance}` : "";
        return {
          text: team ? `Do the ${team} convert on ${down === 4 ? "4th" : "3rd"}${togo}?` : "Do they convert this 3rd down?",
          short: "Convert 3rd down?", prior: p,
          rationale: `Teams convert ${down === 4 ? "4th" : "3rd"} and ${distance} about ${pct(p)} of the time (${SEASONS}).`,
        };
      },
    },
    {
      kind: "red_zone", label: "Red zone", call: "Red zone!", lockSecs: 25, templates: ["nfl.red_zone_td"],
      write: ({ state }) => {
        const yl = state?.yardline && state.yardline >= 80 ? state.yardline : 85;
        const rz = redZoneProbs(yl);
        const team = offense(state);
        return {
          text: team ? `Touchdown for the ${team} on this trip?` : "Touchdown on this red-zone trip?",
          short: "Red zone TD?", prior: rz.td,
          rationale: `Red-zone trips end in a touchdown ${pct(rz.td)} of the time (${SEASONS}).`,
        };
      },
    },
    {
      kind: "big_play", label: "Big play", call: "Big play watch!", lockSecs: 15, templates: [],
      write: () => ({
        text: "20+ yard gain on this snap?", short: "20+ yard play?", prior: 0.08,
        rationale: "Roughly 1 snap in 12 gains 20 yards or more in the NFL (league-wide estimate).",
      }),
    },
    {
      kind: "next_score", label: "Next score", call: "Who scores next?", lockSecs: 25, templates: [],
      write: ({ state }) => {
        const d = driveResultProbs({ yardline: state?.yardline ?? 25, scoreDiff: 0, secondsRemaining: state?.secondsRemaining ?? 1800 });
        const p = d.td / Math.max(0.01, d.td + d.fg);
        return {
          text: "Is the next score a touchdown (not a field goal)?", short: "Next score a TD?", prior: p,
          rationale: `Of drives that score, ${pct(p)} end in a touchdown (${SEASONS}).`,
        };
      },
    },
  ],
  soccer: [
    {
      kind: "penalty", label: "Penalty!", call: "Penalty called!", lockSecs: 20, templates: ["soccer.penalty"],
      write: ({ state }) => {
        const player = state?.lastEvent?.type === "penalty_awarded" ? state.lastEvent.player : undefined;
        const pr = penaltyProb(player);
        return {
          text: player ? `Will ${player} score this penalty?` : "Will the penalty be scored?",
          short: "Pen scored?", prior: pr.p,
          rationale: `Penalties are scored ${pct(pr.base)} of the time (StatsBomb open data)${pr.taker ? `; ${player}'s record moves it to ${pct(pr.p)}` : ""}.`,
        };
      },
    },
    {
      kind: "corner", label: "Corner", call: "Corner kick!", lockSecs: 15, templates: ["soccer.corner_sot"],
      write: () => {
        const p = cornerShotOnTargetProb();
        return { text: "Shot on target from this corner?", short: "Corner: on target?", prior: p, rationale: `About ${pct(p)} of corners lead to a shot on target (StatsBomb open data).` };
      },
    },
    {
      kind: "free_kick", label: "Free kick", call: "Free kick!", lockSecs: 20, templates: [],
      write: () => ({
        text: "Shot on target from this free kick?", short: "FK on target?", prior: 0.25,
        rationale: "About a quarter of attacking free kicks near the box test the keeper (estimate).",
      }),
    },
    {
      kind: "next_goal", label: "Next goal", call: "Goal watch!", lockSecs: 20, templates: [],
      write: () => {
        const r = defaultGoalRates(SOCCER_TABLE);
        const p = 1 - Math.exp(-((r.home + r.away) * 5) / 90);
        return {
          text: "Goal in the next 5 minutes?", short: "Goal in 5 min?", prior: p,
          rationale: `Matches average ${(r.home + r.away).toFixed(1)} goals, so a goal in any 5 minutes is about ${pct(p)} (Poisson).`,
        };
      },
    },
  ],
  nba: [
    {
      kind: "free_throws", label: "Free throws", call: "To the line!", lockSecs: 15, templates: ["nba.ft_trip"],
      write: ({ state }) => {
        const ev = state?.lastEvent;
        const player = ev?.type === "free_throw" ? ev.player : undefined;
        const p = ftAllProb(2);
        return {
          text: player ? `Will ${player} make both free throws?` : "Both free throws made?", short: "Both FTs?", prior: p,
          rationale: `NBA players make about ${pct(NBA.ftPct)} of free throws, so two in a row is ${pct(p)}.`,
        };
      },
    },
    {
      kind: "timeout", label: "Timeout", call: "Timeout!", lockSecs: 15, templates: ["nba.next_score"],
      write: ({ state }) => {
        const team = state?.possession ? nick(state[state.possession], "nfl") : null;
        const p = nextScoreProb();
        return {
          text: team ? `Out of the timeout: will the ${team} score next?` : "Does the team with the ball score next?", short: "Ball team scores next?", prior: p,
          rationale: `Possessions score about ${pct(NBA.possessionScore)} of the time, so the team with the ball scores next ${pct(p)} of the time.`,
        };
      },
    },
    {
      kind: "three", label: "From deep", call: "Three-point watch!", lockSecs: 15, templates: ["nba.three_window"],
      write: () => {
        const p = threeInWindowProb(60);
        return { text: "A made three in the next minute?", short: "Three in a minute?", prior: p, rationale: `About ${Math.round(NBA.threesPerMinute * 48)} threes go in per game, so one in any minute is ${pct(p)} (Poisson).` };
      },
    },
  ],
};

export function findMoment(sport: MomentSport, kind: string): MomentKind | undefined {
  return MOMENT_KINDS[sport].find((m) => m.kind === kind);
}

/** Latin-1 only (kiosk fonts). */
export function kioskSafe(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}
