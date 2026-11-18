// What the kiosk touchscreen shows. The ESP32 firmware (and the /kiosk web page) draw exactly this JSON
// and send back the id of whatever was touched. Change labels/flow here; no reflashing needed.
//
// Contract (keep in sync with firmware/kiosk_screen and README "Kiosk API"):
//   screen    one of select | lobby | market | locked | result | ended | message (unknown -> draw title/subtitle/buttons)
//   title, subtitle, color (blue|amber|red|green|gray), footer
//   tiles     [{id,label,sub,enabled}]                       select screen, up to 4
//   code, joinUrl, qr {size, rows:["0101..."]}, players[]    lobby screen
//   question, yes, no (cents 1-99), move (-1|0|1), history[] (cents), traded, lockIn (seconds)   market/locked
//   result ("YES"|"NO"), lines[]                              result / ended
//   buttons   [{id,label,style}]  style: primary|yes|no|plain, drawn as a row along the bottom
//
// v2 (optional, additive; old firmware ignores them, the new firmware copes when any is missing):
//   v: 2, palette {canvas,card,well,rule,ink,ink2,muted,accent,accentDeep,accentLight,yes,no,hot,gold} (hex)
//   game {id,title,league,sport,kind,mode}, score {home,away,homeShort,awayShort,homeColor,awayColor,
//     homeScore,awayScore,clock,period,status,swapped}, caption {id,text}
//     score is in drawing order (home* left, away* right): for "Away at Home" games (US leagues) the real away
//     team is in home* and swapped is true, so the box draws away first without a firmware change.
//   cards [{id,title,sub,enabled,league,kind,date,color,gemini,home?,away?}]   select: EVERY game (tiles = first 4)
//   roster [{name,cents,deposited}], pot (cents), calls [{id,label,enabled}]    lobby/result ("Call it!" moments)
//   volume (cents), lockInMs, lockTotal (s), model (cents|null), gemini {cents,label,live}|null,
//     trades [{name,side,cents,price}] newest first, moment, mode              market/locked
//   winners [{name,cents,profit}], losers [{name,cents}], lockYes (cents)      result
//   leaderboard [{name,cents,pnl,rank,lead}], scorecard {room,model,gemini,n,verdict}     ended
//     (rank shared on a tie, lead only for a sole leader; the firmware reads name, cents, pnl)
//
// v2 "pages" (optional, additive): market, locked and result scroll down to more sections on the box.
//   chart {room[], gemini[]?, model, span, lock, outcome, x0, x1}     market/locked/result: the odds graph.
//     room / gemini = YES price 0-100 sampled evenly in time from the open (<= 60 points, gemini null where
//     Gemini had no price), drawn from x 0 to x `span` (0-100) of the time axis; lock = x of the lock (0-100)
//     or null; model = the model's YES price (cents) or null; outcome "YES" | "NO" | null; x0/x1 axis labels.
//   odds [{label, p, hist[]?, source}]   "Odds right now": the room's open question (source "room") and the
//     game's Gemini markets (source "gemini": moneyline, total, period winners; p 0-100, hist <= 30 points)
//   oddsNote   one sentence on where the Gemini prices come from
//   standings [{name,cents,pnl,rank,lead}]   who is ahead right now (worth = balance + cashed out + open)
//   trades     also on result now (newest first)
//   pay {name, cents, qr {size, rows}, until (ms epoch), leftMs, paid}   any screen, only while lobby.boxPay is
//     live: the box draws a Solana Pay card on top (QR at ECC L) with a Close button (touch id "pay:close").
import QRCode from "qrcode";
import { allGames, getGame } from "./games";
import { getTimeline } from "./replay/timeline";
import { bestCandidate, replayMs } from "./replay/run";
import { buildScorecard } from "./scorecard";
import {
  ApiError, createLobby, endSession, getKioskCode, getKioskLobby, getLobby, lockMarket, mutate, openMarket,
  releaseKiosk, resolveMarket, usd,
} from "./lobby";
import * as lobbyModule from "./lobby";
import * as lmsr from "./lmsr";
import { boxName, boxSafe } from "./boxText";
import { friendlyLabel, type LabelTeam } from "./gemini";
import { awayFirst } from "./matchup";
import { losersOf, openValues, standings } from "./standings";
import type { Game, Lobby } from "./types";

// ---------------------------------------------------------------- "Call it!" moments
// The room slams these on the box when something happens on TV; each opens a quick market on that moment.
// `momentsFor(l)` and `openMoment(l, kind, now)` come from lib/lobby.ts (backend). Read them through the module
// object so this file still builds where they do not exist yet.
type MomentButton = { id: string; label: string };
const backend = lobbyModule as unknown as {
  momentsFor?: (l: Lobby) => MomentButton[];
  openMoment?: (l: Lobby, kind: string, now: number) => void;
};
/** Used only when the backend can open moments but does not list them. */
const FALLBACK_MOMENTS: MomentButton[] = [
  { id: "moment:score", label: "Score!" },
  { id: "moment:turnover", label: "Turnover!" },
];
/**
 * Bottom-row budget (firmware ui.cpp drawButtons): w = (768 - (n-1)*16) / n, label cut to w - 20 px in
 * helvB24 (about 13 px a character). 4 buttons = 180 px each, labels up to about 11 characters. The firmware
 * also keeps at most 8 hit areas. So: at most 2 moments next to 2 host buttons, labels at most 11 characters.
 */
const MAX_MOMENTS = 2;
const MOMENT_LABEL = 11;
function moments(l: Lobby): KioskButton[] {
  if (typeof backend.openMoment !== "function") return [];
  let list: MomentButton[] = [];
  try {
    list = typeof backend.momentsFor === "function" ? backend.momentsFor(l) ?? [] : FALLBACK_MOMENTS;
  } catch {
    list = [];
  }
  return list
    .filter((b) => b && typeof b.id === "string" && b.id.startsWith("moment:") && typeof b.label === "string")
    .slice(0, MAX_MOMENTS)
    // Longer labels still draw: the firmware (and KioskView) end them with "...". Keep backend labels short.
    .map((b) => ({ id: b.id, label: k(b.label).trim().slice(0, MOMENT_LABEL + 9), style: "yes" as const }));
}

export interface KioskButton {
  id: string;
  label: string;
  style?: "primary" | "yes" | "no" | "plain";
}

export interface KioskScreen {
  screen: "select" | "lobby" | "market" | "locked" | "result" | "ended" | "message";
  kiosk: string;
  title: string;
  subtitle: string;
  color: "blue" | "amber" | "red" | "green" | "gray";
  footer: string;
  tiles?: { id: string; label: string; sub: string; enabled: boolean }[];
  code?: string;
  joinUrl?: string;
  qr?: { size: number; rows: string[] };
  players?: string[];
  question?: string;
  yes?: number;
  no?: number;
  move?: number;
  history?: number[];
  traded?: string;
  lockIn?: number;
  result?: "YES" | "NO";
  lines?: string[];
  buttons: KioskButton[];
  /** v2 fields (optional, see the contract at the top). */
  v?: 2;
  palette?: Record<string, string>;
  game?: { id: string; title: string; league?: string; sport?: string; kind?: string; mode?: string };
  score?: KioskScore;
  caption?: { id: number; text: string } | null;
  cards?: KioskCard[];
  roster?: { name: string; cents: number; deposited: number }[];
  pot?: number;
  calls?: { id: string; label: string; enabled: boolean }[];
  volume?: number;
  lockInMs?: number;
  lockTotal?: number;
  model?: number | null;
  gemini?: { cents: number; label: string; live: boolean } | null;
  trades?: { name: string; side: "yes" | "no"; cents: number; price: number }[];
  moment?: string | null;
  mode?: string;
  winners?: { name: string; cents: number; profit: number }[];
  losers?: { name: string; cents: number }[];
  lockYes?: number | null;
  /** Best first (lib/standings.ts). rank is shared on a tie; lead is true only for a sole leader. */
  leaderboard?: { name: string; cents: number; pnl: number; rank?: number; lead?: boolean }[];
  scorecard?: { room: number | null; model: number | null; gemini: number | null; n: number; verdict: string };
  /** Pages (market, locked, result): the odds graph, the odds board, standings. See the contract at the top. */
  chart?: KioskChart;
  odds?: KioskOdds[];
  oddsNote?: string;
  standings?: { name: string; cents: number; pnl: number; rank: number; lead: boolean }[];
  /** A Solana Pay request drawn on top of any screen (lobby.boxPay). */
  pay?: KioskPay;
}

export interface KioskChart {
  /** Room YES price (0-100) sampled evenly in time from the open, <= 60 points. */
  room: number[];
  /** Gemini's YES price at the same instants (null = no price then). Missing when Gemini never priced it. */
  gemini?: (number | null)[];
  model: number | null;
  /** x (0-100) of the time axis where the samples end ("now", or the result). */
  span: number;
  /** x (0-100) of the lock, or null. */
  lock: number | null;
  outcome: "YES" | "NO" | null;
  x0: string;
  x1: string;
}

export interface KioskOdds {
  label: string;
  /** Probability 0-100. */
  p: number;
  /** Earlier values (0-100), oldest first, <= 30 points. */
  hist?: number[];
  source: "room" | "gemini";
}

export interface KioskPay {
  name: string;
  cents: number;
  /** Missing when the URL does not fit a QR the box can draw. */
  qr?: { size: number; rows: string[] };
  until: number;
  /** ms to `until` when this JSON was built (the box has no wall clock). */
  leftMs: number;
  paid: boolean;
}

export interface KioskTeam {
  name: string;
  /** What fans call the team ("49ers", "Thunder"): short enough for a game card. */
  nick?: string;
  short?: string;
  color?: string;
}

export interface KioskCard {
  id: string;
  title: string;
  sub: string;
  enabled: boolean;
  league?: string;
  kind?: string;
  date?: string;
  color?: string;
  gemini?: boolean;
  home?: KioskTeam;
  away?: KioskTeam;
  /** true = US style "Away at Home" (draw away first); false = "Home v Away". */
  at?: boolean;
}

export interface KioskScore {
  home: string;
  away: string;
  homeShort: string;
  awayShort: string;
  homeColor?: string;
  awayColor?: string;
  homeScore: number;
  awayScore: number;
  clock: string;
  period: string;
  status: string;
  /** true: the teams are in drawing order for an "Away at Home" game, so `home*` holds the real away team. */
  swapped?: boolean;
}

/**
 * The shared Huddle design tokens (green + ivory, app/globals.css). The firmware has the same defaults built
 * in and takes these as overrides, so a token changed here reaches the box without reflashing: muted is
 * #616D64 (4.9:1 on canvas, 5.3:1 on card, 4.5:1 on well; the firmware's built-in #6C7A70 is 4.07:1).
 */
export const KIOSK_PALETTE = {
  canvas: "#F6F3EA", card: "#FFFDF8", well: "#EEEAE0", rule: "#E2DDD0", ink: "#10261C", ink2: "#3E5247",
  muted: "#616D64", accent: "#12A150", accentDeep: "#0B7A3E", accentLight: "#7CCB4E", yes: "#1468FF",
  no: "#FF6B00", hot: "#E5484D", gold: "#E8A33D",
} as const;

/** The firmware uses Latin-1 fonts: swap typographic characters, transliterate, drop what it cannot draw. */
const k = boxSafe;
/** A player's name on the box: Latin-1 and never blank. */
const kn = boxName;

function qrRows(text: string, level: "L" | "M" = "M"): { size: number; rows: string[] } {
  const qr = QRCode.create(text, { errorCorrectionLevel: level });
  const size = qr.modules.size;
  const rows: string[] = [];
  for (let r = 0; r < size; r++) {
    let row = "";
    for (let c = 0; c < size; c++) row += qr.modules.get(r, c) ? "1" : "0";
    rows.push(row);
  }
  return { size, rows };
}

const HEX = /^#?[0-9a-f]{6}$/i;
const hex = (c: unknown): string | undefined => (typeof c === "string" && HEX.test(c) ? (c.startsWith("#") ? c : `#${c}`) : undefined);
const LEAGUE: Record<string, string> = { nfl: "NFL", soccer: "Soccer", nba: "NBA", mlb: "MLB", nhl: "NHL", tennis: "Tennis" };
/** League names that do not fit the card chip, as fans write them. */
const LEAGUE_SHORT: Record<string, string> = { "premier league": "EPL", "champions league": "UCL", "major league soccer": "MLS" };
const leagueChip = (s: string) => LEAGUE_SHORT[s.toLowerCase()] ?? s.slice(0, 12);

/** Team from the config: a string, {name, short, color}, or the replay timeline's team. */
function team(v: unknown): KioskTeam | undefined {
  if (typeof v === "string" && v.trim()) return { name: k(v).slice(0, 30), nick: nickOf(k(v)) };
  if (v && typeof v === "object") {
    const t = v as { name?: unknown; nick?: unknown; short?: unknown; abbr?: unknown; color?: unknown };
    if (typeof t.name !== "string" || !t.name.trim()) return undefined;
    const short = typeof t.short === "string" ? t.short : typeof t.abbr === "string" ? t.abbr : undefined;
    const name = k(t.name).slice(0, 30);
    const nick = typeof t.nick === "string" && t.nick.trim() ? k(t.nick).trim().slice(0, 16) : nickOf(name);
    return { name, nick, short: short ? k(short).slice(0, 5) : undefined, color: hex(t.color) };
  }
  return undefined;
}

/** A name short enough for one game-card line: the full name when short, else its last word ("Tennessee Titans" -> "Titans"). */
function nickOf(name: string): string {
  const n = name.trim();
  if (n.length <= 14) return n;
  const words = n.split(/\s+/);
  return words.length > 1 ? words[words.length - 1] : n.slice(0, 16);
}

/** "2026-11-22T18:00:00Z" -> "Sun, Nov 22"; anything else passes through (Latin-1, short). */
function prettyDate(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T12:00:00Z` : v);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }
  return k(v).slice(0, 26);
}

/** A game picker card from whatever the config provides (league, date, teams are optional). */
function gameCard(g: Game): KioskCard {
  const x = g as Game & Record<string, unknown>;
  const enabled = g.live && g.questions.length > 0;
  const tl = g.kind === "replay" && g.replay ? getTimeline(g.replay) : undefined;
  const teams = Array.isArray(x.teams) ? (x.teams as unknown[]) : [];
  const home = team(x.home) ?? team(teams[0]) ?? (tl ? team(tl.info.home) : undefined);
  const away = team(x.away) ?? team(teams[1]) ?? (tl ? team(tl.info.away) : undefined);
  const sport = typeof x.sport === "string" ? x.sport : tl?.info.sport;
  const league = typeof x.league === "string" && x.league.trim() ? leagueChip(k(x.league.trim())) : sport ? LEAGUE[sport] : undefined;
  // Real replayed games carry the real date. Hand-written demo replays have no real date (their startsAt is a
  // made-up kickoff), so the card says what they are instead of showing a date or repeating the subtitle.
  const date = prettyDate(x.date ?? x.kickoff ?? x.played ?? x.when ?? (tl?.meta.real ? tl.meta.date ?? tl.info.startsAt : undefined))
    ?? (tl && !tl.meta.real ? "Demo game" : undefined);
  return {
    id: `game:${g.id}`, title: k(g.title), sub: k(enabled ? g.subtitle || "Live" : "Coming soon"), enabled,
    league, kind: g.kind ?? "clip", date, color: hex(g.color), gemini: !!g.gemini?.event,
    // US leagues (MLS too) write "Away at Home"; soccer elsewhere writes "Home v Away" (lib/matchup.ts).
    ...(home && away ? { home, away, at: awayFirst(sport, typeof x.league === "string" ? x.league : league) } : {}),
  };
}

/**
 * The scorebug. The firmware (ui.cpp scorebug) draws the `home*` fields on the left and the `away*` fields on
 * the right, so for "Away at Home" games (US leagues, lib/matchup.ts) the two teams are swapped here: the real
 * away team goes in `home*` and is drawn first, like the game card and the phone and TV scorebugs. `swapped`
 * says so (true = `home*` holds the real away team); the firmware does not read it.
 */
function scoreOf(l: Lobby): KioskScore | undefined {
  const run = l.replay;
  if (!run) return undefined;
  const st = run.state;
  const game = getGame(l.gameId);
  const left = { name: k(st.home.name), short: k(st.home.short), color: hex(st.home.color), score: st.score.home };
  const right = { name: k(st.away.name), short: k(st.away.short), color: hex(st.away.color), score: st.score.away };
  const swapped = awayFirst(st.sport ?? game?.sport, game?.league);
  const [a, b] = swapped ? [right, left] : [left, right];
  return {
    home: a.name, away: b.name, homeShort: a.short, awayShort: b.short,
    homeColor: a.color, awayColor: b.color,
    homeScore: a.score, awayScore: b.score, clock: k(st.clock.display),
    period: periodLabel(st.sport, st.clock.period), status: String(st.status ?? ""),
    swapped,
  };
}

export function periodLabel(sport: string, period: number | undefined): string {
  if (!period) return "";
  if (sport === "soccer") return period === 1 ? "1st half" : period === 2 ? "2nd half" : "ET";
  // NFL, NBA and every other sport played in quarters
  return period === 5 ? "OT" : period > 5 ? `${period - 4}OT` : `Q${period}`;
}

/** Everything the v2 firmware can use on every screen. */
function common(l: Lobby | null): Partial<KioskScreen> {
  const game = l ? getGame(l.gameId) : undefined;
  const sport = game?.sport;
  const last = l?.captions?.[l.captions.length - 1];
  const score = l ? scoreOf(l) : undefined;
  return {
    v: 2,
    palette: { ...KIOSK_PALETTE },
    ...(game ? { game: { id: game.id, title: k(game.title), league: sport ? LEAGUE[sport] : undefined, sport, kind: game.kind ?? "clip", mode: l?.mode } } : {}),
    ...(score ? { score } : {}),
    caption: last ? { id: last.id, text: k(last.text).slice(0, 180) } : null,
  };
}

function callsOf(l: Lobby): { id: string; label: string; enabled: boolean }[] {
  if (typeof backend.openMoment !== "function" || typeof backend.momentsFor !== "function") return [];
  try {
    const open = l.phase === "lobby" || l.phase === "result";
    return (backend.momentsFor(l) ?? [])
      .filter((b) => b && typeof b.id === "string" && b.id.startsWith("moment:"))
      .slice(0, 6)
      .map((b) => ({ id: b.id, label: k(b.label).trim().slice(0, 14), enabled: open }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- pages: odds graph, odds board, standings

/** At most this many chart samples (the firmware keeps 64). */
export const CHART_POINTS = 60;
/** At most this many points in an odds row's mini line. */
export const ODDS_POINTS = 30;
/** At most this many rows on the odds board (the room's question + the game's Gemini markets). */
export const MAX_ODDS = 8;
const pct = (p: number) => Math.min(100, Math.max(0, Math.round(p * 100)));

/** Evenly spaced picks of `xs`, first and last kept, at most `max`. */
export function downsample<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return [...xs];
  if (max <= 1) return xs.length ? [xs[xs.length - 1]] : [];
  return Array.from({ length: max }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (max - 1))]);
}

/** The value of a step series [{at, v}] at time t (the first value before it starts). */
function stepAt<T>(pts: readonly { at: number; v: T }[], t: number): T {
  let lo = 0;
  let hi = pts.length - 1;
  if (t <= pts[0].at) return pts[0].v;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid].at <= t) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo].v;
}

/**
 * The odds graph: the room's YES price (and Gemini's, when it priced the question) over the question's life, as
 * integers 0-100 sampled evenly in time. Open: the axis runs from the open to the lock and the line grows toward
 * it. Locked: open to now. Result: open to the result, plus the outcome.
 */
export function chartOf(l: Lobby, now: number = Date.now()): KioskChart | undefined {
  const m = l.market;
  if (!m || (l.phase !== "open" && l.phase !== "locked" && l.phase !== "result")) return undefined;
  const t0 = m.openedAt;
  const settledAt = l.phase === "result" ? m.resolvedAt ?? now : null;
  const tEnd = Math.max(t0 + 1000, settledAt ?? now);
  // Open: the whole trading window is the axis (if it is a sane length); after that the axis ends at the last sample.
  const window = m.lockAt - t0;
  const axisEnd = l.phase === "open" && window > 0 && window <= 30 * 60_000 ? Math.max(m.lockAt, tEnd) : tEnd;
  const xOf = (t: number) => Math.min(100, Math.max(0, Math.round(((t - t0) / Math.max(1, axisEnd - t0)) * 100)));
  const span = xOf(tEnd);
  const model = typeof m.model === "number" ? lmsr.toCents(m.model) : null;
  const outcome = l.phase === "result" && m.outcome && !m.voided ? (m.outcome === "yes" ? "YES" : "NO") : null;
  const lock = l.phase === "open" ? (axisEnd === m.lockAt ? 100 : null) : xOf(Math.min(m.lockAt, tEnd));
  const labels = { x0: "Open", x1: l.phase === "open" ? (lock === 100 ? "Lock" : "Now") : l.phase === "locked" ? "Now" : "Result" };
  const trail = (m.trail ?? []).filter((p) => Number.isFinite(p.at) && Number.isFinite(p.room)).sort((a, b) => a.at - b.at);
  if (!trail.length) {
    // Older lobbies: the per-trade history, evenly spaced.
    const room = downsample(m.history.length ? m.history : [yesNow(m)], CHART_POINTS).map(lmsr.toCents);
    return { room: room.length > 1 ? room : [room[0], room[0]], model, span: 100, lock: l.phase === "open" ? null : 100, outcome, ...labels };
  }
  // Points every few seconds of the question so far (more as it runs), never more than CHART_POINTS.
  const n = Math.min(CHART_POINTS, Math.max(2, Math.round(((tEnd - t0) / 1000) * 2) + 1));
  const roomPts = trail.map((p) => ({ at: p.at, v: p.room }));
  // The live price can be ahead of the trail's last point (a trade lands between two polls): end on it.
  const live = l.phase === "open" ? yesNow(m) : null;
  const room: number[] = [];
  const gem: (number | null)[] = [];
  const gemPts = trail.map((p) => ({ at: p.at, v: p.gemini }));
  for (let i = 0; i < n; i++) {
    const t = t0 + ((tEnd - t0) * i) / (n - 1);
    room.push(lmsr.toCents(i === n - 1 && live !== null ? live : stepAt(roomPts, t)));
    const g = stepAt(gemPts, t);
    gem.push(typeof g === "number" && Number.isFinite(g) ? pct(g) : null);
  }
  return { room, ...(gem.some((g) => g !== null) ? { gemini: gem } : {}), model, span, lock, outcome, ...labels };
}

const yesNow = (m: NonNullable<Lobby["market"]>) => lmsr.priceYes(m.yes, m.no, m.b);

/** Our names for the game's teams keyed by Gemini contract code (lib/lobby.ts labelTeams, kept in step). */
function labelTeamsOf(l: Lobby): LabelTeam[] {
  const st = l.replay?.state;
  if (!st) return [];
  const cfg = getGame(l.gameId)?.gemini;
  const say = (name: string) => (st.sport === "soccer" ? name : name.trim().split(/\s+/).pop() ?? name);
  return [{ code: cfg?.home ?? st.home.short, name: say(st.home.name) }, { code: cfg?.away ?? st.away.short, name: say(st.away.name) }];
}

const PERIOD_ORDER = ["1Q", "2Q", "1H", "3Q", "4Q", "2H"];
const periodRank = (p?: string) => {
  const i = PERIOD_ORDER.indexOf((p ?? "").toUpperCase());
  return i < 0 ? 99 : i;
};

/**
 * "Odds right now": the room's open question first, then the game's Gemini markets as our screens name them
 * (moneyline per team, the total line nearest 50%, the favourite in each period winner market), each with
 * Gemini's real price history so far on replayed real games.
 */
export function oddsOf(l: Lobby, chart: KioskChart | undefined, now: number = Date.now()): { odds: KioskOdds[]; note: string } {
  const out: KioskOdds[] = [];
  const m = l.market;
  if (m && (l.phase === "open" || l.phase === "locked")) {
    out.push({ label: k(m.text || m.short).slice(0, 80), p: lmsr.toCents(yesNow(m)), ...(chart ? { hist: downsample(chart.room, ODDS_POINTS) } : {}), source: "room" });
  }
  const s = l.gemini;
  const game = getGame(l.gameId);
  const tl = game?.replay ? getTimeline(game.replay) : undefined;
  const track = tl?.gemini?.track;
  const atMs = l.replay && l.replay.startedAt !== null ? replayMs(l.replay, now) : null;
  const histOf = (event: string, contract: string): number[] | undefined => {
    if (!track || atMs === null) return undefined;
    const pts = track[event]?.[contract]?.filter(([t, p]) => t <= atMs && Number.isFinite(p));
    if (!pts || pts.length < 2) return undefined;
    return downsample(pts, ODDS_POINTS).map(([, p]) => pct(p));
  };
  const teams = labelTeamsOf(l);
  const rows: { order: number; row: KioskOdds }[] = [];
  for (const ev of s?.events ?? []) {
    const priced = ev.contracts.filter((c) => typeof c.prob === "number");
    if (!priced.length) continue;
    const row = (c: (typeof priced)[number], label: string, order: number) =>
      rows.push({ order, row: { label: k(label).slice(0, 60), p: pct(c.prob as number), ...(histOf(ev.ticker, c.ticker) ? { hist: histOf(ev.ticker, c.ticker) } : {}), source: "gemini" } });
    if (ev.kind === "moneyline" && !ev.period) {
      priced.forEach((c, i) => {
        const name = friendlyLabel(ev, c, teams);
        row(c, /^(tie|draw)$/i.test(name) ? name : `${name} to win`, i);
      });
    } else if (ev.kind === "total") {
      const c = [...priced].sort((a, b) => Math.abs((a.prob as number) - 0.5) - Math.abs((b.prob as number) - 0.5))[0];
      const per = ev.period ? ` (${ev.period.toUpperCase()})` : "";
      row(c, `${friendlyLabel(ev, c, teams)}${per}`, ev.period ? 40 + periodRank(ev.period) : 10);
    } else if (ev.kind === "period_winner") {
      const c = [...priced].sort((a, b) => (b.prob as number) - (a.prob as number))[0];
      row(c, friendlyLabel(ev, c, teams), 20 + periodRank(ev.period));
    }
  }
  rows.sort((a, b) => a.order - b.order);
  for (const r of rows) if (out.length < MAX_ODDS) out.push(r.row);
  const note = s ? k(s.note ?? (s.live ? "Live from Gemini Prediction Markets." : "Last prices seen on Gemini.")).slice(0, 140) : "Gemini has no market for this game.";
  return { odds: out, note };
}

/** Who is ahead right now (lib/standings.ts), best first. */
function standingsOf(l: Lobby): NonNullable<KioskScreen["standings"]> {
  const players = l.order.map((id) => l.players[id]).filter(Boolean);
  const open = openValues(l);
  return standings(players.map((p) => ({ ...p, open: open[p.id] ?? 0 })))
    .slice(0, 10)
    .map((p) => ({ name: kn(p.name), cents: p.worth, pnl: p.worth - p.deposited, rank: p.rank, lead: p.lead }));
}

/** The page sections under the market / locked / result view. */
function pageOf(l: Lobby, now: number): Partial<KioskScreen> {
  const chart = chartOf(l, now);
  const { odds, note } = oddsOf(l, chart, now);
  return { ...(chart ? { chart } : {}), odds, oddsNote: note, standings: standingsOf(l) };
}

// ---------------------------------------------------------------- Solana Pay on the box

/** How long the box keeps the "Paid" card up after the payment landed. */
export const PAY_PAID_MS = 12_000;
/** The firmware's pay QR buffer holds up to 96 modules (version 19). */
export const PAY_QR_MAX = 96;

/** The pay card while lobby.boxPay is live (open and not expired, or paid in the last PAY_PAID_MS). */
export function payOf(l: Lobby, now: number = Date.now()): KioskPay | undefined {
  const bp = l.boxPay;
  if (!bp || typeof bp.url !== "string" || !bp.url || bp.url.length > 1200) return undefined;
  const until = Number(bp.until);
  const paidAt = typeof bp.paidAt === "number" && Number.isFinite(bp.paidAt) ? bp.paidAt : null;
  if (paidAt === null && !(until > now)) return undefined;
  if (paidAt !== null && now - paidAt > PAY_PAID_MS) return undefined;
  let qr: KioskPay["qr"];
  try {
    const q = qrRows(bp.url, "L");
    if (q.size <= PAY_QR_MAX) qr = q;
  } catch {
    qr = undefined;
  }
  const cents = Math.max(0, Math.min(10_000_000, Math.round(Number(bp.cents) || 0)));
  return { name: kn(String(bp.name ?? "")).slice(0, 23), cents, ...(qr ? { qr } : {}), until: Number.isFinite(until) ? until : now, leftMs: Math.max(0, Math.min(86_400_000, Math.round(until - now) || 0)), paid: paidAt !== null };
}

/** v2 additions per screen. */
function extras(l: Lobby | null): Partial<KioskScreen> {
  const base = extrasCore(l);
  const pay = l ? payOf(l) : undefined;
  return pay ? { ...base, pay } : base;
}

function extrasCore(l: Lobby | null): Partial<KioskScreen> {
  const base = common(l);
  if (!l) return { ...base, cards: allGames().map(gameCard) };
  const players = l.order.map((id) => l.players[id]).filter(Boolean);
  const m = l.market;
  if (l.phase === "lobby") {
    return {
      ...base,
      roster: players.map((p) => ({ name: kn(p.name), cents: p.balance, deposited: p.deposited })),
      pot: players.reduce((a, p) => a + p.deposited, 0),
      calls: players.length ? callsOf(l) : [],
    };
  }
  if ((l.phase === "open" || l.phase === "locked") && m) {
    const g = m.gemini;
    return {
      ...base,
      volume: m.volume,
      lockInMs: Math.max(0, m.lockAt - Date.now()),
      lockTotal: Math.max(0, Math.round((m.lockAt - m.openedAt) / 1000)),
      model: typeof m.model === "number" ? Math.round(m.model * 100) : null,
      gemini: g && typeof g.prob === "number" ? { cents: Math.round(g.prob * 100), label: k(g.label ?? "Gemini").slice(0, 40), live: !!g.live } : null,
      trades: m.trades.slice(-8).reverse().map((t) => ({ name: kn(t.name), side: t.side, cents: t.cents, price: lmsr.toCents(t.priceAfter) })),
      moment: m.source?.kind === "moment" ? m.source.moment : null,
      mode: m.mode ?? "market",
      ...pageOf(l, Date.now()),
    };
  }
  if (l.phase === "result" && m) {
    const winners = Object.entries(m.payouts)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, c]) => ({ name: kn(l.players[id]?.name ?? "?"), cents: c, profit: c - (m.positions[id]?.spent ?? 0) }));
    const losers = losersOf(m).map((x) => ({ name: kn(l.players[x.id]?.name ?? "?"), cents: x.cents }));
    return {
      ...base,
      winners, losers, volume: m.volume,
      lockYes: typeof m.priceAtLock === "number" ? lmsr.toCents(m.priceAtLock) : null,
      calls: callsOf(l),
      trades: m.trades.slice(-8).reverse().map((t) => ({ name: kn(t.name), side: t.side, cents: t.cents, price: lmsr.toCents(t.priceAfter) })),
      ...pageOf(l, Date.now()),
    };
  }
  const open = openValues(l);
  const board = standings(players.map((p) => ({ ...p, open: open[p.id] ?? 0 })))
    .map((p) => ({ name: kn(p.name), cents: p.worth, pnl: p.worth - p.deposited, rank: p.rank, lead: p.lead }));
  const sc = buildScorecard(l.scoreEntries ?? []);
  return { ...base, leaderboard: board, scorecard: { room: sc.room, model: sc.model, gemini: sc.gemini, n: sc.n, verdict: k(sc.verdict) } };
}

export async function kioskScreen(kioskId: string, baseUrl: string): Promise<KioskScreen> {
  const l = await getKioskLobby(kioskId);
  return { ...(await kioskScreenV1(kioskId, baseUrl, l)), ...extras(l) };
}

/** The original screen (every field the old firmware reads), unchanged. */
async function kioskScreenV1(kioskId: string, baseUrl: string, l: Lobby | null): Promise<KioskScreen> {
  // Look (firmware palette only): header green while a lobby or question is live and when YES wins, gray for
  // calm screens. Main actions use the "yes" style (the firmware's green) instead of "primary" (blue).
  // Copy stays short and Latin-1 (the firmware truncates titles at 560 px and subtitles at 750 px).
  const footer = `Huddle · Kiosk ${kioskId}`;

  if (!l) {
    return {
      screen: "select", kiosk: kioskId, color: "gray", footer,
      title: "Pick a game",
      subtitle: "Then everyone taps a phone here to join",
      tiles: allGames().slice(0, 4).map((g) => {
        const enabled = g.live && g.questions.length > 0;
        return { id: `game:${g.id}`, label: k(g.title), sub: k(enabled ? g.subtitle || "Live" : "Coming soon"), enabled };
      }),
      buttons: [],
    };
  }

  const game = getGame(l.gameId);
  const total = game?.questions.length ?? 0;
  const footerL = `Huddle · ${l.code}`;
  const m = l.market;
  const players = l.order.map((id) => l.players[id]);

  if (l.phase === "lobby") {
    const joinUrl = `${baseUrl}/l/${l.code}`;
    // Once someone is in, the box becomes the controller: "Call it!" moments sit next to the host buttons.
    const calls = players.length ? moments(l) : [];
    return {
      screen: "lobby", kiosk: kioskId, color: "green", footer: footerL,
      title: k(game?.title ?? "Lobby"),
      subtitle: calls.length
        ? `${players.length} in  ·  See a play coming? Slam a green button to call it`
        : `Tap your phone or scan to join  ·  ${players.length} in`,
      code: l.code,
      joinUrl: joinUrl.replace(/^https?:\/\//, ""),
      qr: qrRows(joinUrl),
      players: players.map((p) => k(`${kn(p.name)}  ${p.deposited > 0 ? usd(p.balance) : "adding money..."}`)),
      question: k(game?.questions[l.qIndex]?.text ?? ""),
      buttons: calls.length
        ? [{ id: "start", label: `Start Q${l.qIndex + 1}`, style: "plain" }, ...calls, { id: "cancel", label: "Cancel", style: "plain" }]
        : [
            { id: "start", label: `Start question ${l.qIndex + 1}`, style: "yes" },
            { id: "cancel", label: "Cancel", style: "plain" },
          ],
    };
  }

  if ((l.phase === "open" || l.phase === "locked") && m) {
    const py = lmsr.priceYes(m.yes, m.no, m.b);
    const yes = lmsr.toCents(py);
    const base = {
      kiosk: kioskId, footer: footerL,
      question: k(m.text),
      yes, no: 100 - yes, move: m.lastMove,
      history: m.history.slice(-40).map((p) => lmsr.toCents(p)),
      traded: `${usd(m.volume)} traded`,
    };
    if (l.phase === "open") {
      return {
        ...base, screen: "market", color: "green",
        title: String(m.questionId).startsWith("moment") ? "Called it!" : l.replay ? `Question ${m.qIndex + 1}` : `Question ${m.qIndex + 1} of ${total}`,
        subtitle: "Buy YES or NO on your phone. A winning share pays $1",
        lockIn: Math.max(0, Math.ceil((m.lockAt - Date.now()) / 1000)),
        buttons: [{ id: "lock", label: "Lock now", style: "plain" }],
      };
    }
    return {
      ...base, screen: "locked", color: "gray",
      title: "Trading closed",
      subtitle: m.resolveAt ? "Watch the play. The result comes in by itself" : "Watch the play, then tap what happened",
      lockIn: 0,
      buttons: [
        { id: "resolve:yes", label: "It was YES", style: "yes" },
        { id: "resolve:no", label: "It was NO", style: "no" },
      ],
    };
  }

  if (l.phase === "result" && m && m.outcome) {
    const winners = Object.entries(m.payouts).sort((a, b) => b[1] - a[1]);
    // Replay games open the next question by themselves; offer Next only when one could open right now.
    const run = l.replay;
    const more = run
      ? run.asked < run.maxQuestions && (run.startedAt === null || !!bestCandidate(run, replayMs(run, Date.now())))
      : l.qIndex < total;
    const calls = moments(l);
    const end = { id: "end", label: calls.length ? "End" : "End session", style: "plain" as const };
    return {
      screen: "result", kiosk: kioskId, color: m.outcome === "yes" ? "green" : "gray", footer: footerL,
      title: m.outcome === "yes" ? "It was YES" : "It was NO",
      subtitle: `${winners.length ? `${winners.length} ${winners.length === 1 ? "winner" : "winners"}` : "No winners"}  ·  ${usd(m.volume)} traded  ·  winning shares pay $1`,
      result: m.outcome === "yes" ? "YES" : "NO",
      question: k(m.text),
      lines: winners.length
        ? winners.slice(0, 6).map(([id, c]) => k(`${kn(l.players[id]?.name ?? "?")}  +${usd(c)}`))
        : ["Nobody called it this time"],
      buttons: calls.length
        ? [...(more ? [{ id: "next", label: `Start Q${l.qIndex + 1}`, style: "plain" as const }] : []), ...calls, end]
        : more
          ? [{ id: "next", label: `Start question ${l.qIndex + 1}`, style: "yes" }, end]
          : [{ ...end, style: "yes" }],
    };
  }

  // ended
  const open = openValues(l);
  const board = standings(players.map((p) => ({ ...p, open: open[p.id] ?? 0 })));
  return {
    screen: "ended", kiosk: kioskId, color: "gray", footer: footerL,
    title: "Session over",
    subtitle: "Thanks for playing. Cash out on your phone",
    lines: board.slice(0, 6).map((p) => k(`${p.rank}.  ${kn(p.name)}  ${usd(p.worth)}`)),
    buttons: [{ id: "new", label: "New game", style: "yes" }],
  };
}

/** A touch on the kiosk. `id` is a button or tile id from kioskScreen. Returns the new screen. */
export async function kioskTouch(kioskId: string, id: string, baseUrl: string): Promise<KioskScreen> {
  const [action, arg] = String(id || "").split(":");
  const code = await getKioskCode(kioskId);

  if (action === "game") {
    const current = code ? await getLobby(code) : null;
    if (current && current.phase !== "ended") throw new ApiError(400, "A game is already running");
    await createLobby(kioskId, arg);
    return kioskScreen(kioskId, baseUrl);
  }
  if (!code) throw new ApiError(400, "Pick a game first");

  switch (action) {
    case "start":
    case "next":
      await mutate(code, (l, now) => openMarket(l, now));
      break;
    case "lock":
      await mutate(code, (l) => lockMarket(l));
      break;
    case "resolve":
      if (arg !== "yes" && arg !== "no") throw new ApiError(400, "Bad result");
      await mutate(code, (l, now) => resolveMarket(l, arg, now));
      break;
    case "end":
      await mutate(code, (l) => endSession(l));
      break;
    case "cancel":
    case "new":
      await releaseKiosk(kioskId, code);
      break;
    case "pay":
      // The box's Solana Pay card: Close (also after "Paid") clears the request.
      if (arg !== "close") throw new ApiError(400, "Unknown button");
      await mutate(code, (l) => {
        l.boxPay = null;
      });
      break;
    case "moment": {
      // "Call it!": the room slammed a moment button. The backend opens a quick market on it.
      const open = backend.openMoment;
      const kind = String(arg || "").replace(/[^\w-]/g, "").slice(0, 32);
      if (typeof open !== "function") throw new ApiError(400, "Calls are not switched on yet");
      if (!kind) throw new ApiError(400, "Unknown call");
      await mutate(code, (l, now) => open(l, kind, now));
      break;
    }
    default:
      throw new ApiError(400, "Unknown button");
  }
  return kioskScreen(kioskId, baseUrl);
}
