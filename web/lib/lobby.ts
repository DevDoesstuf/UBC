// The lobby: one shared state per watch party. Every device (kiosk, phones, watch page) is a view of it.
// All game logic lives here, so the kiosk firmware only displays state and sends taps.
//
// Additions on top of Dev's state machine (all stored in the lobby JSON, all advanced inside tick()):
//  - markets open at the model's prior (question `prior`, or the question engine for replay games)
//  - three trading modes: market (LMSR), pool (pari-mutuel) and h2h (offers between players)
//  - Gemini Prediction Markets quotes for comparable questions, and a room/model/Gemini Brier scorecard
//  - announcer captions for every lobby event
//  - replay games: a game clock started by the host, events folded on every read, engine-written questions
import { randomBytes } from "crypto";
import { kvDel, kvGet, kvSet, withLock } from "./store";
import { getGame, hasVideo, isReplay } from "./games";
import * as lmsr from "./lmsr";
import { captionLine, isBigTrade, speechLine, toSpeech, type CaptionEvent, type Persona } from "./announcer";
import { geminiForGame, isSettled, refForContract, refForHint, replayMoneylineTrack, replaySnapshotAt, sourceOf, toEngineQuotes, type GeminiGameConfig, type GeminiSnapshot, type LabelTeam } from "./gemini";
import { buildScorecard } from "./scorecard";
import { losersOf, openValues, standings } from "./standings";
import { fillOffer, impliedYes, poolYesShare, refundPairs, roundOdds, settlePairs, settlePool, takerStakeFor, MAX_ODDS, MIN_ODDS } from "./modes";
import { advanceReplay, bestCandidate, calibrateRun, clampPrior, newRun, pregameQuestion, replayDue, replayMs, startRun, takeCandidate, RESULT_HOLD_MS, type PendingQ, type ReplayHost } from "./replay/run";
import { findMoment, kioskSafe, MOMENT_KINDS, type MomentKind, type MomentSport } from "./moments";
import { getTimeline, wallAt } from "./replay/timeline";
import { chainView } from "./chain";
import type { Game, Lobby, LobbyEvent, Market, MarketMode, Offer, Player, Side, WithdrawalRecord } from "./types";
import { MARKET_MODES } from "./types";
import { acceptHotseat, HwError, interludeHold, onJoin, onResult, onVoid, pendingFor, placePending, takePending, tickHw } from "./hw";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const MAX_PLAYERS = 12;
/** Replay games: how long a host-called moment waits for It was YES/NO after it locks before it is refunded. */
const HOST_RESULT_MS = 45_000;
export const BUY_OPTIONS = [100, 200, 500]; // cents, the quick buttons on phones
export const MIN_BUY = 25;
export const MAX_BUY = 5000;
const MAX_CAPTIONS = 10;
/** Pregame question of a replay game (the Gemini-comparable moneyline) trades this long before kickoff. */
export const PREGAME_TRADE_MS = 20_000;
/** The "last call" tick (sounds/lastcall.wav, about 3.5 s of ticks) fires this long before a market locks... */
export const LAST_CALL_MS = 4500;
/** ...on markets that trade at least this long (shorter windows are all announcement anyway). */
export const LAST_CALL_MIN_WINDOW_MS = 10_000;
/** "Pay on the box" (lobby.boxPay): the QR stays up this long unpaid, and this long once paid. */
export const BOX_PAY_MS = 90_000;
export const BOX_PAID_SHOW_MS = 4000;
/** The lobby read path checks an open box payment on chain at most this often. */
export const BOX_CHECK_MS = 3000;

const lobbyKey = (code: string) => `lobby:${code}`;
const kioskKey = (id: string) => `kiosk:${id}`;
const rid = (bytes: number) => randomBytes(bytes).toString("hex");

export function normCode(code: string): string {
  return String(code || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
}

export function normKiosk(id: string | null | undefined): string {
  return String(id || "1").replace(/[^\w-]/g, "").slice(0, 16) || "1";
}

export function cleanName(name: unknown): string {
  return String(name ?? "")
    .replace(/[^\p{L}\p{N} ._'-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14);
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function parseMode(v: unknown): MarketMode | null {
  return typeof v === "string" && (MARKET_MODES as string[]).includes(v) ? (v as MarketMode) : null;
}

async function read(code: string): Promise<Lobby | null> {
  const s = await kvGet(lobbyKey(code));
  return s ? (JSON.parse(s) as Lobby) : null;
}

async function write(l: Lobby): Promise<void> {
  await kvSet(lobbyKey(l.code), JSON.stringify(l), { px: LOBBY_TTL_MS });
}

function addEvent(l: Lobby, kind: LobbyEvent["kind"], text: string, sound?: LobbyEvent["sound"]) {
  // Ids are increasing millisecond timestamps, so they keep increasing across lobbies too (the speaker
  // ESP32 remembers the last id it played and never has to reset when a new game starts).
  const id = Math.max(l.eventSeq + 1, Date.now());
  l.eventSeq = id;
  l.events.push({ id, at: Date.now(), kind, text, sound });
  if (l.events.length > 40) l.events.splice(0, l.events.length - 40);
}

// ---------------------------------------------------------------- captions

export function personaOf(l: Lobby): Persona {
  const g = getGame(l.gameId);
  if (g?.persona) return g.persona;
  const t = g?.replay ? getTimeline(g.replay) : undefined;
  return t?.info.sport === "soccer" ? "soccer" : "nfl";
}

function caption(l: Lobby, ev: CaptionEvent, now: number, seed = ""): void {
  const persona = personaOf(l);
  const s = `${l.code}|${seed}|${(l.captions?.length ?? 0)}`;
  const text = captionLine(ev, persona, s);
  if (!text) return;
  // The spoken version (speaker and TV voice): shorter, numbers in words. Same variant as the caption.
  const say = speechLine(ev, persona, s) || toSpeech(text);
  const caps = (l.captions ??= []);
  const last = caps.length ? caps[caps.length - 1].id : 0;
  // Captions share the event id counter, so the speaker's audio stream (events + captions) never repeats an id.
  const id = Math.max(last + 1, l.eventSeq + 1, now);
  l.eventSeq = id;
  caps.push({ id, at: now, text, kind: ev.type, say });
  if (caps.length > MAX_CAPTIONS) caps.splice(0, caps.length - MAX_CAPTIONS);
}

// ---------------------------------------------------------------- market helpers

function modeOf(m: Market | null | undefined): MarketMode {
  return m?.mode ?? "market";
}

export function lobbyMode(l: Lobby): MarketMode {
  return l.mode ?? getGame(l.gameId)?.mode ?? "market";
}

/** YES probability shown for a market, in any mode. */
export function yesPrice(m: Market): number {
  return lmsr.priceYes(m.yes, m.no, m.b);
}

/**
 * Pool and h2h markets have no LMSR shares; we store "display shares" so priceYes(yes, no, b) = p and
 * every existing view (kiosk, history sparkline) keeps working unchanged.
 */
function setDisplayPrice(m: Market, p: number): void {
  const q = Math.min(0.99, Math.max(0.01, p));
  m.yes = m.b * Math.log(q);
  m.no = m.b * Math.log(1 - q);
}

function pushHistory(m: Market, before: number): void {
  const after = yesPrice(m);
  m.history.push(after);
  if (m.history.length > 120) m.history.splice(1, m.history.length - 120);
  const a = lmsr.toCents(after);
  const b = lmsr.toCents(before);
  m.lastMove = a > b ? 1 : a < b ? -1 : 0;
}

function geminiConfigFor(game: Game | undefined): GeminiGameConfig | undefined {
  if (!game) return undefined;
  if (game.gemini?.event) return game.gemini;
  const q = game.questions.find((x) => x.gemini?.event);
  if (!q?.gemini) return undefined;
  const t = q.gemini.event;
  const i = t.lastIndexOf("-");
  return { event: i > 0 ? t.slice(0, i) : t };
}

/** Our names for the game's teams, keyed by Gemini contract code, so Gemini's "Los Angeles C" reads "Chargers". */
function labelTeams(l: Lobby): LabelTeam[] {
  const st = l.replay?.state;
  if (!st) return [];
  const cfg = getGame(l.gameId)?.gemini;
  const say = (name: string) => (st.sport === "soccer" ? name : name.trim().split(/\s+/).pop() ?? name);
  return [{ code: cfg?.home ?? st.home.short, name: say(st.home.name) }, { code: cfg?.away ?? st.away.short, name: say(st.away.name) }];
}

function refreshMarketGemini(l: Lobby, now: number = Date.now()): void {
  const m = l.market;
  if (!m || !m.geminiKey || l.phase !== "open") return;
  const k = m.geminiKey;
  const teams = labelTeams(l);
  const ref = k.event && k.contract ? refForContract(l.gemini ?? null, k.event, k.contract, teams) : refForHint(l.gemini ?? null, k.hint, k.yesTeam, teams);
  if (ref) {
    m.gemini = ref;
    noteTrail(m, now);
  }
}

/** The replayed real game's Gemini track for this game, if it has one (Gemini's real prices, by replay time). */
function replayGeminiOf(l: Lobby) {
  const g = getGame(l.gameId);
  const t = g?.replay ? getTimeline(g.replay) : undefined;
  return t?.gemini?.track && Object.keys(t.gemini.track).length ? { t, g: t.gemini } : null;
}

/**
 * Replayed real games: Gemini's prices follow the replay. At replay time T the lobby holds Gemini's real
 * prices at the moment of the real game that T shows (before the clock starts: just before kickoff).
 */
function syncReplayGemini(l: Lobby, now: number): void {
  const rg = l.replay ? replayGeminiOf(l) : null;
  if (!rg || !l.replay) return;
  const atMs = replayMs(l.replay, now);
  const snap = replaySnapshotAt(rg.g, atMs, l.replay.startedAt === null ? null : wallAt(rg.t, atMs));
  if (snap && (!l.gemini || l.gemini.asOf !== snap.asOf || l.gemini.source !== "replay")) l.gemini = snap;
}

/** Room vs Gemini over time: adds a point when either price moved (always at open and lock). */
function noteTrail(m: Market, now: number, force = false): void {
  const trail = (m.trail ??= []);
  const room = Math.round(yesPrice(m) * 1000) / 1000;
  const gemini = m.gemini ? Math.round(m.gemini.prob * 1000) / 1000 : null;
  const last = trail[trail.length - 1];
  if (!force && last && last.room === room && last.gemini === gemini) return;
  trail.push({ at: now, room, gemini });
  if (trail.length > 120) trail.splice(1, trail.length - 120);
}

/** Called right after a market opens: the Gemini price at open and the first trail point. */
function markOpen(l: Lobby, now: number): void {
  const m = l.market;
  if (!m) return;
  refreshMarketGemini(l, now);
  m.geminiAtOpen = m.gemini?.prob ?? null;
  noteTrail(m, now, true);
}

/** Shared by clip and replay questions: a fresh market opened at prior `p` (null = 50/50, no model). */
function newMarket(l: Lobby, now: number, o: {
  qIndex: number; questionId: string; text: string; short: string; b: number; prior: number | null; startAt: number;
  lockAt: number; lockAtVideo: number; resolveAt: number | null; source: Market["source"]; geminiKey?: Market["geminiKey"];
}): Market {
  const mode = lobbyMode(l);
  const p = o.prior === null ? 0.5 : clampPrior(o.prior);
  const m: Market = {
    qIndex: o.qIndex, questionId: o.questionId, text: o.text, short: o.short, b: o.b,
    yes: 0, no: 0, volume: 0,
    openedAt: now, startAt: o.startAt, lockAt: o.lockAt, lockAtVideo: o.lockAtVideo, resolveAt: o.resolveAt,
    history: [p], lastMove: 0, positions: {}, trades: [], outcome: null, payouts: {}, resolvedAt: null,
    mode, model: o.prior === null ? null : p, gemini: null, geminiKey: o.geminiKey ?? null, priceAtLock: null, source: o.source,
  };
  // LMSR opening at prior p: YES shares b*ln(p), NO shares b*ln(1-p) gives priceYes = p (and C = 0).
  if (o.prior !== null) setDisplayPrice(m, p);
  if (mode === "pool") {
    m.pool = { yes: 0, no: 0 };
    m.stakes = {};
  }
  if (mode === "h2h") {
    m.offers = [];
    m.pairs = [];
  }
  return m;
}

function announceOpen(l: Lobby, m: Market, now: number, moment?: MomentKind): void {
  // A host-called moment ("Call it!") gets the siren; every other market opens with the whoosh.
  addEvent(l, "start", moment ? `${moment.call} ${m.text}` : `Trading open: ${m.text}`, moment ? "siren" : "start");
  caption(l, {
    type: "start", call: moment?.call ?? null, text: m.text, yesPct: yesPrice(m) * 100, modelPct: m.model == null ? null : m.model * 100,
    gemini: m.gemini ? { label: m.gemini.label, pct: m.gemini.prob * 100 } : null,
    lockIn: Math.max(0, Math.round((m.lockAt - now) / 1000)), mode: modeOf(m),
  }, now, m.questionId);
}

// ---------------------------------------------------------------- replay glue

function replayHost(l: Lobby): ReplayHost {
  return {
    phase: () => {
      if (l.phase === "open") return "open";
      if (l.phase === "locked") return "locked";
      if (l.phase === "ended") return "locked"; // nothing new opens after the session ends
      return "idle";
    },
    // A standings break (lib/hw.ts) holds the next question until it is over.
    lastResultAt: () => (l.phase === "result" || l.phase === "lobby" ? Math.max(l.market?.resolvedAt ?? 0, interludeHold(l) - RESULT_HOLD_MS) : 0),
    lockIfDue: (wall) => {
      if (l.phase === "open" && l.market && wall >= l.market.lockAt) lockMarket(l, l.market.lockAt);
    },
    lock: (wall) => {
      if (l.phase === "open" && l.market) {
        l.market.lockAt = Math.min(l.market.lockAt, wall);
        lockMarket(l, wall);
      }
    },
    resolve: (outcome, reason, wall) => {
      if (!l.market || (l.phase !== "open" && l.phase !== "locked")) return;
      if (outcome) resolveMarket(l, outcome, wall);
      else voidMarket(l, reason, wall);
    },
    resolveParked: (outcome, reason, wall) => settleParked(l, outcome, reason, wall),
    open: (q, yesPrior, lockAtWall, resolveAtWall, wall) => openReplayMarket(l, q, yesPrior, lockAtWall, resolveAtWall, wall),
    gameEvent: (ev) => {
      const kind = ev.type === "goal" ? "goal" : ev.type === "final" ? "final" : ev.type === "play_result" && ev.data.touchdown === true ? "touchdown" : ev.type === "drive_end" && ev.data.result === "fg" ? "fg" : null;
      if (!kind) return;
      const team = teamName(l, ev.team);
      const score = scoreLine(l, ev.score);
      // A score in a replay game: the crowd cheers (speaker and TV), then the announcer calls it.
      const what = kind === "final" ? `Final${score ? `: ${score}` : ""}` : `${kind === "fg" ? "Field goal" : kind === "goal" ? "Goal" : "Touchdown"}${team ? `, ${team}` : ""}!`;
      addEvent(l, "play", what, "cheer");
      if (ev.text) caption(l, { type: "play", text: ev.text, kind, team, score }, Date.now(), `ev${ev.seq}`);
    },
  };
}

/** "Cowboys" (NFL: the nickname) or "Aston Villa" (soccer) for a team short code in a replay game. */
function teamName(l: Lobby, short: string | undefined): string | null {
  const st = l.replay?.state;
  if (!short || !st) return null;
  const [home, away] = labelTeams(l);
  if (st.home.short === short || home?.code === short) return home?.name ?? null;
  if (st.away.short === short || away?.code === short) return away?.name ?? null;
  return null;
}

/** "Cowboys 24, 49ers 17" (leader first) from a replay event's score ({home, away} or [home, away]). */
function scoreLine(l: Lobby, score: unknown): string | null {
  if (!l.replay?.state || !score) return null;
  const s = score as { home?: number; away?: number } | number[];
  const h = Array.isArray(s) ? s[0] : s.home;
  const a = Array.isArray(s) ? s[1] : s.away;
  if (typeof h !== "number" || typeof a !== "number") return null;
  const [home, away] = labelTeams(l);
  if (!home || !away) return null;
  return h >= a ? `${home.name} ${h}, ${away.name} ${a}` : `${away.name} ${a}, ${home.name} ${h}`;
}

function openReplayMarket(l: Lobby, q: PendingQ, yesPrior: number, lockAtWall: number, resolveAtWall: number | null, now: number, moment?: MomentKind): void {
  const game = getGame(l.gameId);
  const run = l.replay;
  const yesTeam = q.yesId === "home" ? (game?.gemini?.home ?? run?.state.home.short) : q.yesId === "away" ? (game?.gemini?.away ?? run?.state.away.short) : undefined;
  const qIndex = Math.max(0, (run?.asked ?? 1) - 1);
  l.market = newMarket(l, now, {
    qIndex, questionId: q.key, text: q.text, short: q.short, b: game?.b ?? 10, prior: yesPrior,
    startAt: run ? Math.round(replayMs(run, now) / 1000) : 0, lockAt: lockAtWall, lockAtVideo: Math.round((lockAtWall - (run?.startedAt ?? now)) / 1000),
    resolveAt: resolveAtWall,
    source: { kind: "replay", templateId: q.templateId, key: q.key, rationale: q.rationale, moment: moment?.kind },
    geminiKey: q.geminiHint ? { hint: q.geminiHint, yesTeam } : null,
  });
  l.qIndex = qIndex;
  l.phase = "open";
  syncReplayGemini(l, now);
  markOpen(l, now);
  announceOpen(l, l.market, now, moment);
}

/** Moves a locked pregame market aside (it settles at the final whistle) so the live questions can run. */
function parkPregame(l: Lobby, now: number): void {
  const run = l.replay;
  if (!run || !run.pregame || !l.market || l.phase !== "locked") return;
  run.parked = run.pregame;
  run.pregame = null;
  run.parkedMarket = l.market;
  l.market = null;
  l.phase = "lobby";
  startRun(run, now);
  advanceReplay(run, now, replayHost(l), true);
}

function tickReplay(l: Lobby, now: number, dryRun: boolean): boolean {
  const run = l.replay;
  if (!run) return false;
  const host = replayHost(l);
  if (run.pregame) {
    // Pregame: the clock starts when the pregame question locks.
    if (l.phase === "open" && l.market && now >= l.market.lockAt) {
      if (!dryRun) {
        lockMarket(l, l.market.lockAt);
        parkPregame(l, now);
      }
      return true;
    }
    if (l.phase === "locked") {
      if (!dryRun) parkPregame(l, now);
      return true;
    }
    return false;
  }
  if (run.startedAt === null) return false;
  if (dryRun) return replayDue(run, now, host) || (l.phase === "open" && !!l.market && now >= l.market.lockAt);
  return advanceReplay(run, now, host);
}

// ---------------------------------------------------------------- time-based transitions

/** Applies (or, with dryRun, only detects) the transitions that happen on a timer: auto-lock and auto-resolve. */
function tick(l: Lobby, now: number, dryRun = false): boolean {
  let changed = false;
  // "Pay on the box": gone ~4 s after it was paid, or when it timed out unpaid.
  const bp = l.boxPay;
  if (bp && ((bp.paidAt && now >= bp.paidAt + BOX_PAID_SHOW_MS) || (!bp.paidAt && now > bp.until))) {
    if (dryRun) return true;
    l.boxPay = null;
    changed = true;
  }
  if (l.replay && l.phase !== "ended") {
    if (tickReplay(l, now, dryRun)) {
      if (dryRun) return true;
      changed = true;
    }
  }
  if (tickHw(l, now, dryRun)) {
    if (dryRun) return true;
    changed = true;
  }
  const m = l.market;
  if (!m) return changed;
  if (l.phase === "open" && now >= m.lockAt) {
    if (dryRun) return true;
    lockMarket(l, m.lockAt);
    if (l.replay?.pregame) parkPregame(l, now);
    return true;
  }
  // Last call: once per market, a few seconds before it locks (the speaker ticks down to the lock clunk).
  if (l.phase === "open" && !m.lastCall && now >= m.lockAt - LAST_CALL_MS && m.lockAt - m.openedAt >= LAST_CALL_MIN_WINDOW_MS) {
    if (dryRun) return true;
    m.lastCall = true;
    addEvent(l, "lastcall", `Last call: ${Math.max(1, Math.ceil((m.lockAt - now) / 1000))} seconds!`, "lastcall");
    changed = true;
  }
  // Replay games keep playing: a host-called moment the plays cannot settle is refunded if nobody taps
  // the result within HOST_RESULT_MS of the lock, so the automatic questions start again.
  if (l.phase === "locked" && l.replay && m.resolveAt === null && m.source?.kind === "moment" && now >= m.lockAt + HOST_RESULT_MS) {
    if (dryRun) return true;
    voidMarket(l, "nobody tapped the result", now);
    return true;
  }
  if (l.phase === "locked" && !l.replay && m.resolveAt !== null && now >= m.resolveAt) {
    const q = getGame(l.gameId)?.questions[m.qIndex];
    if (q?.answer) {
      if (!dryRun) resolveMarket(l, q.answer, now);
      return true;
    }
  }
  if (!dryRun) syncReplayGemini(l, now);
  if (!dryRun && l.phase === "open") refreshMarketGemini(l, now);
  return changed;
}

// ---------------------------------------------------------------- reading and changing a lobby

/** Load, change and save a lobby under a lock. `fn` throws ApiError to refuse the change. */
export async function mutate(code: string, fn: (l: Lobby, now: number) => void, gemini?: GeminiSnapshot | null): Promise<Lobby> {
  code = normCode(code);
  return withLock(`lobby:${code}`, async () => {
    const l = await read(code);
    if (!l) throw new ApiError(404, "Lobby not found. Pick a game on the kiosk to start a new one.");
    const now = Date.now();
    if (gemini && (!l.gemini || gemini.at !== l.gemini.at || gemini.live !== l.gemini.live)) l.gemini = gemini;
    tick(l, now);
    fn(l, now);
    tick(l, now);
    l.v++;
    l.updatedAt = now;
    await write(l);
    return l;
  });
}

/** Latest Gemini quotes for the lobby's game (30 s cache; never throws, never waits more than ~3 s). */
async function geminiFor(l: Lobby): Promise<GeminiSnapshot | null> {
  // Replayed real games follow Gemini's price history instead (syncReplayGemini, inside tick).
  if (replayGeminiOf(l)) return null;
  const cfg = geminiConfigFor(getGame(l.gameId));
  if (!cfg) return null;
  return geminiForGame(cfg).catch(() => null);
}

/** Read a lobby, applying any timer transition that is due. Returns null when it does not exist. */
export async function getLobby(code: string, opts: { gemini?: boolean } = {}): Promise<Lobby | null> {
  code = normCode(code);
  if (!code) return null;
  let l = await read(code);
  if (!l) return null;
  // An open "Pay on the box" QR: look for the payment on chain, at most every 3 s per lobby (checkBoxPay throttles).
  const bp = l.boxPay;
  if (bp && !bp.paidAt && Date.now() <= bp.until) {
    const { checkBoxPay } = await import("./solana-lobby");
    if (await checkBoxPay(l).catch((e) => (console.error("[boxPay]", e instanceof Error ? e.message : e), false))) {
      l = (await read(code)) ?? l;
    }
  }
  // gemini: false (the speaker's audio poll) never waits on a Gemini quote; the timers still run.
  const g = opts.gemini !== false && (l.phase === "open" || l.phase === "lobby") ? await geminiFor(l) : null;
  const stale = !!g && (!l.gemini || g.at !== l.gemini.at || g.live !== l.gemini.live);
  if (stale || tick(l, Date.now(), true)) return mutate(code, () => {}, g);
  return l;
}

export async function getKioskLobby(kioskId: string, opts: { gemini?: boolean } = {}): Promise<Lobby | null> {
  const code = await kvGet(kioskKey(kioskId));
  if (!code) return null;
  const l = await getLobby(code, opts);
  if (!l) await kvDel(kioskKey(kioskId));
  return l;
}

export async function getKioskCode(kioskId: string): Promise<string | null> {
  return kvGet(kioskKey(kioskId));
}

export async function releaseKiosk(kioskId: string, code: string): Promise<void> {
  if ((await kvGet(kioskKey(kioskId))) === code) await kvDel(kioskKey(kioskId));
}

export async function createLobby(kioskId: string, gameId: string, mode?: MarketMode | null): Promise<Lobby> {
  const game = getGame(gameId);
  if (!game) throw new ApiError(404, "Unknown game");
  if (!game.live || game.questions.length === 0) throw new ApiError(400, `${game.title} is coming soon`);
  const now = Date.now();
  // A replayed real game starts from Gemini's prices just before its kickoff; other games ask Gemini now.
  const track = isReplay(game) && game.replay ? getTimeline(game.replay)?.gemini : null;
  const gemini = track?.track && Object.keys(track.track).length
    ? replaySnapshotAt(track, 0, null)
    : await geminiForGame(geminiConfigFor(game) as GeminiGameConfig).catch(() => null);
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from(randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
    const l: Lobby = {
      code, kioskId, gameId, createdAt: now, updatedAt: now, v: 1, phase: "lobby", qIndex: 0,
      players: {}, order: [], market: null, results: [], events: [], eventSeq: 0,
      deposits: {}, withdrawals: [], housePnl: 0,
      mode: mode ?? game.mode ?? "market", captions: [], scoreEntries: [], gemini,
    };
    if (isReplay(game) && game.replay) {
      l.replay = newRun(game.replay, game.questions.length);
      // Calibrate the pricing models to Gemini's moneyline and total before kickoff.
      if (gemini) calibrateRun(l.replay, toEngineQuotes(gemini));
    }
    addEvent(l, "tap", `${game.title} picked. Tap your phone to join!`, "tap");
    if (await kvSet(lobbyKey(code), JSON.stringify(l), { px: LOBBY_TTL_MS, nx: true })) {
      await kvSet(kioskKey(kioskId), code, { px: LOBBY_TTL_MS });
      return l;
    }
  }
  throw new ApiError(500, "Could not create a lobby code, try again");
}

export function findPlayer(l: Lobby, token: string | null | undefined): Player | null {
  if (!token) return null;
  return Object.values(l.players).find((p) => p.token === token) ?? null;
}

export function requirePlayer(l: Lobby, token: string | null | undefined): Player {
  const p = findPlayer(l, token);
  if (!p) throw new ApiError(401, "Join the lobby first");
  return p;
}

// ---------------------------------------------------------------- actions

export function join(l: Lobby, rawName: unknown, now: number): Player {
  let name = cleanName(rawName);
  if (!name) throw new ApiError(400, "Enter a name");
  if (l.phase === "ended") throw new ApiError(400, "This session has ended");
  if (l.order.length >= MAX_PLAYERS) throw new ApiError(400, "This lobby is full");
  const taken = new Set(Object.values(l.players).map((p) => p.name.toLowerCase()));
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${cleanName(rawName).slice(0, 11)} ${n}`;
  const p: Player = { id: rid(4), token: rid(16), name, balance: 0, deposited: 0, withdrawn: 0, joinedAt: now };
  l.players[p.id] = p;
  l.order.push(p.id);
  addEvent(l, "join", `${name} joined`, "join");
  caption(l, { type: "join", name }, now, p.id);
  onJoin(l, p, now);
  return p;
}

/** Adds money to a player's balance. `ref` makes it idempotent (a Coinbase transaction id or Solana signature is only credited once). */
export function creditDeposit(l: Lobby, playerId: string, cents: number, source: "demo" | "coinbase" | "solana", ref: string, now: number): boolean {
  const p = l.players[playerId];
  if (!p || cents <= 0 || l.deposits[ref]) return false;
  p.balance += cents;
  p.deposited += cents;
  l.deposits[ref] = { playerId, cents, at: now, source, ref };
  addEvent(l, "deposit", `${p.name} added ${usd(cents)}`, "coin");
  return true;
}

/** Sets the trading mode for the next questions (host choice before or between questions). */
export function setMode(l: Lobby, mode: MarketMode): void {
  if (l.phase === "open" || l.phase === "locked") throw new ApiError(400, "Change the mode between questions");
  if (l.phase === "ended") throw new ApiError(400, "This session has ended");
  l.mode = mode;
}

export function openMarket(l: Lobby, now: number): void {
  if (l.phase === "ended") throw new ApiError(400, "This game is over. Tap New game to play again");
  if (l.phase !== "lobby" && l.phase !== "result") throw new ApiError(400, "A question is already running");
  const game = getGame(l.gameId);
  if (!game) throw new ApiError(400, "No more questions in this game");
  if (l.replay) return openReplayNext(l, game, now);
  const q = game.questions[l.qIndex];
  if (!q) throw new ApiError(400, "No more questions in this game");
  const tradeSecs = Math.max(5, q.lockAt - q.startAt);
  const resolveSecs = q.resolveAt != null ? Math.max(tradeSecs, q.resolveAt - q.startAt) : null;
  l.market = newMarket(l, now, {
    qIndex: l.qIndex, questionId: q.id, text: q.text, short: q.short || q.text, b: game.b ?? 10,
    prior: typeof q.prior === "number" ? q.prior : null,
    startAt: q.startAt, lockAt: now + tradeSecs * 1000, lockAtVideo: q.lockAt,
    resolveAt: q.answer && resolveSecs !== null ? now + resolveSecs * 1000 : null,
    source: { kind: "clip" },
    geminiKey: q.gemini ? { event: q.gemini.event, contract: q.gemini.contract } : null,
  });
  l.phase = "open";
  markOpen(l, now);
  announceOpen(l, l.market, now);
}

/** Replay games: the host's Start tap starts the clock (after the pregame question, if any); Next opens the best question now. */
function openReplayNext(l: Lobby, game: Game, now: number): void {
  const run = l.replay!;
  if (run.startedAt === null && !run.pregame && !run.parked && run.asked === 0) {
    const pre = game.gemini ? pregameQuestion(run) : null;
    if (pre) {
      run.pregame = pre;
      run.asked = 1;
      openReplayMarket(l, pre, pre.yesPrior, now + PREGAME_TRADE_MS, null, now);
      return;
    }
    startRun(run, now);
  }
  if (run.asked >= run.maxQuestions) throw new ApiError(400, "No more questions in this game");
  advanceReplay(run, now, replayHost(l), true);
  if (l.phase !== "open") {
    const nowMs = replayMs(run, now);
    throw new ApiError(400, bestCandidate(run, nowMs) ? "Try again in a moment" : "Waiting for the next play. It opens by itself");
  }
}

export function lockMarket(l: Lobby, now: number = Date.now()): void {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is not open");
  const m = l.market;
  // Gemini's price at the lock (while still open, so the refresh applies): the scorecard compares against it.
  syncReplayGemini(l, now);
  refreshMarketGemini(l, now);
  l.phase = "locked";
  m.lockAt = Math.min(m.lockAt, now);
  m.priceAtLock = yesPrice(m);
  noteTrail(m, now, true);
  if (modeOf(m) === "h2h") releaseOffers(l, m);
  addEvent(l, "lock", "Trading closed. Watch the play!", "lock");
  caption(l, { type: "lock", yesPct: m.priceAtLock * 100, mode: modeOf(m) }, now, m.questionId);
}

/** h2h: at lock, the unmatched part of every offer goes back to its maker. */
function releaseOffers(l: Lobby, m: Market): void {
  for (const o of m.offers ?? []) {
    if (!o.open) continue;
    o.open = false;
    const left = o.cents - o.filled;
    const p = l.players[o.by];
    if (left > 0 && p) p.balance += left;
  }
}

/** Pays out a market (any mode) or refunds it (outcome null). Returns cents paid per player. */
function settle(l: Lobby, m: Market, outcome: Side | null, now: number): Record<string, number> {
  const mode = modeOf(m);
  const pay: Record<string, number> = {};
  let moneyIn = 0;
  if (mode === "pool") {
    const stakes = Object.entries(m.stakes ?? {}).flatMap(([player, s]) => [
      { player, side: "yes" as const, cents: s.yes },
      { player, side: "no" as const, cents: s.no },
    ]).filter((s) => s.cents > 0);
    moneyIn = stakes.reduce((a, s) => a + s.cents, 0);
    if (outcome) Object.assign(pay, settlePool(stakes, outcome).payouts);
    else for (const s of stakes) pay[s.player] = (pay[s.player] ?? 0) + s.cents;
  } else if (mode === "h2h") {
    releaseOffers(l, m); // no-op after lock
    const pairs = m.pairs ?? [];
    moneyIn = pairs.reduce((a, p) => a + p.makerCents + p.takerCents, 0);
    Object.assign(pay, outcome ? settlePairs(pairs, outcome) : refundPairs(pairs));
  } else {
    moneyIn = m.volume;
    for (const [pid, pos] of Object.entries(m.positions)) {
      const cents = outcome ? Math.floor((outcome === "yes" ? pos.yes : pos.no) * 100 + 1e-6) : pos.spent;
      if (cents > 0) pay[pid] = cents;
    }
  }
  let paid = 0;
  for (const [pid, cents] of Object.entries(pay)) {
    const p = l.players[pid];
    if (cents > 0 && p) {
      p.balance += cents;
      paid += cents;
    } else delete pay[pid];
  }
  l.housePnl += moneyIn - paid;
  m.payouts = pay;
  m.outcome = outcome;
  m.resolvedAt = now;
  return pay;
}

function winnersOf(l: Lobby, m: Market, outcome: Side): { name: string; cents: number }[] {
  // A winner is someone who backed the winning side; a pool refund (nobody won) has no winners.
  const backed = (pid: string): boolean => {
    if (modeOf(m) === "pool") return (m.stakes?.[pid]?.[outcome] ?? 0) > 0;
    if (modeOf(m) === "h2h") return (m.pairs ?? []).some((p) => (p.side === outcome ? p.maker : p.taker) === pid);
    return (m.positions[pid]?.[outcome] ?? 0) > 0;
  };
  return Object.entries(m.payouts)
    .filter(([pid]) => backed(pid))
    .sort((a, b) => b[1] - a[1])
    .map(([pid, cents]) => ({ name: l.players[pid]?.name ?? "?", cents }));
}

function recordScore(l: Lobby, m: Market, outcome: Side): void {
  const room = m.priceAtLock ?? yesPrice(m);
  // Games with a Gemini market say whether Gemini priced it at all, so the verdict can tell "not comparable" apart.
  const mapped = !!geminiConfigFor(getGame(l.gameId));
  const priced = !!l.gemini?.events.some((e) => e.contracts.some((c) => c.prob !== null));
  (l.scoreEntries ??= []).push({
    room, model: m.model ?? null, gemini: m.gemini?.prob ?? null, outcome: outcome === "yes" ? 1 : 0, ...(mapped ? { geminiUnpriced: !priced } : {}),
  });
}

export function resolveMarket(l: Lobby, outcome: Side, now: number): void {
  if (l.phase === "open") lockMarket(l, now);
  if (l.phase !== "locked" || !l.market) throw new ApiError(400, "Nothing to resolve");
  const m = l.market;
  if (l.replay?.current?.key === m.questionId) l.replay.current = null;
  if (l.replay?.pregame) {
    // The host settled the pregame question by hand: the clock starts now.
    l.replay.pregame = null;
  }
  settle(l, m, outcome, now);
  onResult(l, m, outcome, now);
  recordScore(l, m, outcome);
  l.results.push({ qIndex: m.qIndex, text: m.text, outcome, volume: m.volume, payouts: { ...m.payouts } });
  l.phase = "result";
  // A called moment is an extra question: it does not use up one of the game's scripted questions.
  if (m.source?.kind !== "moment") l.qIndex = m.qIndex + 1;
  const winners = winnersOf(l, m, outcome);
  const head = outcome === "yes" ? "YES!" : "NO!";
  // Somebody won: fanfare. Nobody did: the room goes "aww".
  addEvent(l, "result", winners.length ? `${head} ${winners.map((w) => `${w.name} wins ${usd(w.cents)}`).join(", ")}` : `${head} No winners this time.`, winners.length ? "win" : "lose");
  const atLock = m.priceAtLock ?? yesPrice(m);
  caption(l, { type: "result", outcome, winners, atLockPct: (outcome === "yes" ? atLock : 1 - atLock) * 100 }, now, m.questionId);
  if (l.replay && l.replay.startedAt === null && !l.replay.parked && m.source?.kind === "replay") {
    startRun(l.replay, now);
  }
}

// ---------------------------------------------------------------- "Call it" moments

export { MOMENT_KINDS };

export function sportOf(game: Game | undefined): MomentSport {
  if (game?.sport) return game.sport;
  const t = game?.replay ? getTimeline(game.replay) : undefined;
  if (t) return t.info.sport;
  return game?.persona === "soccer" ? "soccer" : "nfl";
}

/** The moment buttons a lobby's game offers: [{ id: "moment:penalty", label: "Penalty!" }]. */
export function momentsFor(l: Lobby): { id: string; label: string }[] {
  const game = getGame(l.gameId);
  const sport = sportOf(game);
  return (game?.moments ?? [])
    .map((k) => findMoment(sport, k))
    .filter((m): m is NonNullable<typeof m> => !!m)
    .map((m) => ({ id: `moment:${m.kind}`, label: kioskSafe(m.label).slice(0, 11) }));
}

/**
 * The host called a moment on the kiosk: open a market for it right now (no question may be running).
 * Replay games use the engine's matching candidate when it has one (resolved from the play-by-play);
 * otherwise the question comes from the moment's template, priced by the model, and the host taps the result.
 */
export function openMoment(l: Lobby, kind: string, now: number): void {
  if (l.phase !== "lobby" && l.phase !== "result") throw new ApiError(400, l.phase === "ended" ? "This session has ended" : "Finish the current question first");
  const game = getGame(l.gameId);
  if (!game) throw new ApiError(400, "Unknown game");
  const k = String(kind || "").replace(/^moment:/, "");
  const offered = game.moments ?? [];
  const mk = offered.includes(k) ? findMoment(sportOf(game), k) : undefined;
  if (!mk) throw new ApiError(400, "This game does not offer that moment");
  const run = l.replay;
  if (run && !run.pregame) {
    const hit = takeCandidate(run, mk.templates, now);
    if (hit) {
      const lockAtWall = run.startedAt! + hit.lockAtMs;
      openReplayMarket(l, hit.q, hit.q.yesPrior, lockAtWall, hit.q.resolveAtMs !== null ? run.startedAt! + hit.q.resolveAtMs : null, now, mk);
      return;
    }
    // No engine question: in a replay the plays are the truth, so never ask about a 3rd down, a penalty or a
    // free-throw trip that is not happening on screen.
    if (run.startedAt !== null && mk.onField) {
      const why = mk.onField(run.state); // mutate() folded the plays up to now before this runs
      if (why) throw new ApiError(400, why);
    }
  }
  const w = mk.write({ state: run?.state ?? null });
  l.market = newMarket(l, now, {
    qIndex: l.qIndex, questionId: `moment-${k}-${now}`, text: w.text, short: w.short, b: game.b ?? 10, prior: w.prior,
    startAt: 0, lockAt: now + mk.lockSecs * 1000, lockAtVideo: 0, resolveAt: null,
    source: { kind: "moment", moment: k, label: mk.label, rationale: w.rationale },
  });
  l.phase = "open";
  markOpen(l, now);
  announceOpen(l, l.market, now, mk);
}

/** Refund every stake (the resolver could not settle it, e.g. a penalty on the play). */
export function voidMarket(l: Lobby, reason: string | null, now: number): void {
  if (l.phase === "open") lockMarket(l, now);
  if (l.phase !== "locked" || !l.market) throw new ApiError(400, "Nothing to void");
  const m = l.market;
  if (l.replay?.current?.key === m.questionId) l.replay.current = null;
  settle(l, m, null, now);
  onVoid(l, m);
  m.voided = true;
  m.voidReason = reason;
  l.qIndex = m.qIndex + 1;
  // Back to the lobby screen (the kiosk's result screen needs an outcome); the next question opens by itself.
  l.phase = "lobby";
  addEvent(l, "result", "That one's off: everyone gets their money back.", "tap");
  caption(l, { type: "void", reason }, now, m.questionId);
}

/** The pregame question of a replay game settles at the final whistle (or is refunded). */
function settleParked(l: Lobby, outcome: Side | null, reason: string | null, now: number): void {
  const run = l.replay;
  const m = run?.parkedMarket;
  if (!run || !m) return;
  run.parked = null;
  run.parkedMarket = null;
  settle(l, m, outcome, now);
  if (!outcome) {
    m.voided = true;
    m.voidReason = reason;
    caption(l, { type: "void", reason }, now, m.questionId);
    return;
  }
  recordScore(l, m, outcome);
  l.results.push({ qIndex: m.qIndex, text: m.text, outcome, volume: m.volume, payouts: { ...m.payouts } });
  const winners = winnersOf(l, m, outcome);
  addEvent(l, "result", `Pregame call: ${outcome === "yes" ? "YES" : "NO"}! ${winners.map((w) => `${w.name} wins ${usd(w.cents)}`).join(", ") || "No winners."}`, winners.length ? "win" : "lose");
  const atLock = m.priceAtLock ?? yesPrice(m);
  caption(l, { type: "result", outcome, winners, atLockPct: (outcome === "yes" ? atLock : 1 - atLock) * 100 }, now, `parked-${m.questionId}`);
}

export function endSession(l: Lobby, now: number = Date.now()): void {
  if (l.phase === "open" || l.phase === "locked") throw new ApiError(400, "Resolve the current question first");
  if (l.replay?.parkedMarket) settleParked(l, null, "the session ended before the final whistle", now);
  l.phase = "ended";
  addEvent(l, "end", "Session over. Cash out on your phone.", "coin");
  // Same order as every board (box, TV, phone): lib/standings.ts. The caption then says how far up the leader
  // is (cents = profit), so it never names a different winner than the podium, and names nobody on a tie.
  const board = standings(l.order.map((id) => l.players[id]));
  const top = board.find((p) => p.lead);
  const sc = buildScorecard(l.scoreEntries ?? []);
  caption(l, { type: "end", leader: top ? { name: top.name, cents: top.worth - top.deposited } : null, verdict: sc.n ? sc.verdict : null }, now, "end");
}

function checkStake(p: Player, cents: number): void {
  if (!Number.isInteger(cents) || cents < MIN_BUY || cents > MAX_BUY) throw new ApiError(400, `Pick between ${usd(MIN_BUY)} and ${usd(MAX_BUY)}`);
  if (p.balance < cents) throw new ApiError(400, "Not enough balance. Add money first.");
}

/** LMSR buy, or a pool stake in pool mode. */
export function buy(l: Lobby, p: Player, side: Side, cents: number, now: number) {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is closed");
  if (side !== "yes" && side !== "no") throw new ApiError(400, "Pick YES or NO");
  const m = l.market;
  if (modeOf(m) === "h2h") throw new ApiError(400, "This question is head-to-head: make an offer or take one");
  checkStake(p, cents);
  const before = yesPrice(m);
  const volumeBefore = m.volume;
  let shares: number;
  if (modeOf(m) === "pool") {
    const pool = (m.pool ??= { yes: 0, no: 0 });
    const st = ((m.stakes ??= {})[p.id] ??= { yes: 0, no: 0 });
    pool[side] += cents;
    st[side] += cents;
    shares = cents / 100; // pool "shares" = dollars staked
    setDisplayPrice(m, poolYesShare(pool, m.model ?? 0.5));
  } else {
    shares = lmsr.sharesForSpend(side, cents / 100, m.yes, m.no, m.b);
    if (side === "yes") m.yes += shares;
    else m.no += shares;
  }
  const priceAfter = yesPrice(m);
  p.balance -= cents;
  m.volume += cents;
  const pos = (m.positions[p.id] ??= { yes: 0, no: 0, spent: 0 });
  pos[side] += shares;
  pos.spent += cents;
  pushHistory(m, before);
  noteTrail(m, now);
  m.trades.push({ at: now, playerId: p.id, name: p.name, side, cents, shares, priceAfter });
  if (m.trades.length > 60) m.trades.splice(0, m.trades.length - 60);
  if (isBigTrade(cents, volumeBefore)) caption(l, { type: "trade", name: p.name, side, cents, yesPctAfter: priceAfter * 100 }, now, `${p.id}${now}`);
  return { shares, priceAfter };
}

/** h2h: back `side` with `cents` at decimal `odds`. The stake leaves the balance until matched or released at lock. */
export function makeOffer(l: Lobby, p: Player, side: Side, cents: number, odds: number, now: number): Offer {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is closed");
  const m = l.market;
  if (modeOf(m) !== "h2h") throw new ApiError(400, "Offers are only for head-to-head questions");
  if (side !== "yes" && side !== "no") throw new ApiError(400, "Pick YES or NO");
  if (!Number.isFinite(odds) || odds < MIN_ODDS || odds > MAX_ODDS) throw new ApiError(400, `Odds must be between ${MIN_ODDS} and ${MAX_ODDS}`);
  checkStake(p, cents);
  const offers = (m.offers ??= []);
  if (offers.filter((o) => o.open).length >= 30) throw new ApiError(400, "Too many open offers");
  const o: Offer = { id: rid(3), by: p.id, name: p.name, side, cents, filled: 0, odds: roundOdds(odds), open: true, at: now };
  p.balance -= cents;
  offers.push(o);
  caption(l, { type: "offer", name: p.name, side, cents, odds: o.odds }, now, o.id);
  return o;
}

/** h2h: take (part of) an offer. `cents` is the taker's stake; any amount above what is left is not used. */
export function takeOffer(l: Lobby, p: Player, offerId: string, cents: number, now: number) {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is closed");
  const m = l.market;
  if (modeOf(m) !== "h2h") throw new ApiError(400, "Offers are only for head-to-head questions");
  const o = (m.offers ?? []).find((x) => x.id === offerId);
  if (!o || !o.open) throw new ApiError(400, "That offer is gone");
  if (o.by === p.id) throw new ApiError(400, "That's your own offer");
  if (!Number.isInteger(cents) || cents < 1) throw new ApiError(400, "Enter an amount");
  // Partial takes: fill up to what the taker has (CONTRACT "Partial takes OK"); refuse only an empty balance.
  if (p.balance < 1) throw new ApiError(400, "Not enough balance. Add money first.");
  let fill;
  try {
    fill = fillOffer(o, Math.min(cents, p.balance));
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : "Could not take that offer");
  }
  const before = yesPrice(m);
  p.balance -= fill.takerCents;
  o.filled = fill.newFilled;
  if (fill.complete) o.open = false;
  (m.pairs ??= []).push({ offerId: o.id, maker: o.by, taker: p.id, side: o.side, makerCents: fill.makerCents, takerCents: fill.takerCents });
  m.volume += fill.makerCents + fill.takerCents;
  const takerSide: Side = o.side === "yes" ? "no" : "yes";
  const maker = (m.positions[o.by] ??= { yes: 0, no: 0, spent: 0 });
  maker[o.side] += fill.makerCents / 100;
  maker.spent += fill.makerCents;
  const taker = (m.positions[p.id] ??= { yes: 0, no: 0, spent: 0 });
  taker[takerSide] += fill.takerCents / 100;
  taker.spent += fill.takerCents;
  setDisplayPrice(m, impliedYes(o.side, o.odds));
  pushHistory(m, before);
  noteTrail(m, now);
  const priceAfter = yesPrice(m);
  m.trades.push({ at: now, playerId: p.id, name: p.name, side: takerSide, cents: fill.takerCents, shares: fill.takerCents / 100, priceAfter });
  if (m.trades.length > 60) m.trades.splice(0, m.trades.length - 60);
  if (isBigTrade(fill.takerCents, 0)) caption(l, { type: "trade", name: p.name, side: takerSide, cents: fill.takerCents, yesPctAfter: null }, now, `${p.id}${now}`);
  return { offerId: o.id, takerCents: fill.takerCents, makerCents: fill.makerCents, complete: fill.complete };
}

/** Takes the player's whole balance out of the game and records a pending withdrawal. */
export function reserveWithdrawal(l: Lobby, p: Player, to: string | null, now: number): WithdrawalRecord {
  if (p.balance <= 0) throw new ApiError(400, "Nothing to cash out");
  const w: WithdrawalRecord = { playerId: p.id, cents: p.balance, at: now, to, txHash: null, status: "demo" };
  p.withdrawn += p.balance;
  p.balance = 0;
  l.withdrawals.push(w);
  return w;
}

// ---------------------------------------------------------------- what phones and the watch page see

function marketExtras(l: Lobby, m: Market) {
  const mode = modeOf(m);
  return {
    mode,
    model: m.model ?? null,
    gemini: m.gemini ? { prob: m.gemini.prob, label: m.gemini.label, asOf: m.gemini.asOf, url: m.gemini.url, live: m.gemini.live, source: m.gemini.source ?? (m.gemini.live ? "live" : "snapshot") } : null,
    geminiAtOpen: m.geminiAtOpen ?? null,
    trail: (m.trail ?? []).map((p) => ({ at: p.at, room: p.room, gemini: p.gemini })),
    priceAtLock: m.priceAtLock ?? null,
    voided: m.voided ?? false,
    rationale: m.source && "rationale" in m.source ? m.source.rationale : null,
    moment: m.source?.kind === "moment" ? m.source.moment : m.source?.kind === "replay" ? m.source.moment ?? null : null,
    /** true = nothing settles it by itself: the host taps It was YES/NO on the box. */
    hostSettles: m.resolveAt === null && m.source?.kind !== "replay",
    pool: mode === "pool" ? { yesCents: m.pool?.yes ?? 0, noCents: m.pool?.no ?? 0 } : undefined,
    offers:
      mode === "h2h"
        ? (m.offers ?? []).map((o) => ({
            id: o.id, by: o.by, name: o.name, side: o.side, cents: o.cents, odds: o.odds, open: o.open,
            filled: o.filled, remaining: o.cents - o.filled, takeCents: o.open ? takerStakeFor(o.cents - o.filled, o.odds) : 0,
          }))
        : undefined,
  };
}

/**
 * The game-level Gemini block of the public view: where the prices come from, the moneyline and total as they
 * stand, and (replayed real games) Gemini's home-win probability over the replay so far for the TV chart.
 */
export function geminiView(l: Lobby, now: number = Date.now()) {
  const game = getGame(l.gameId);
  const cfg = geminiConfigFor(game);
  const s = l.gemini ?? null;
  if (!cfg || !s) return null;
  const ml = s.events.find((e) => e.kind === "moneyline" && !e.period);
  const price = (code: string | undefined) => (code ? ml?.contracts.find((c) => c.ticker.toUpperCase() === code.toUpperCase())?.prob ?? null : null);
  const total = s.events.find((e) => e.kind === "total" && !e.period);
  const line = total?.contracts
    .filter((c) => c.prob !== null)
    .sort((a, b) => Math.abs((a.prob as number) - 0.5) - Math.abs((b.prob as number) - 0.5))[0];
  const lineNum = line ? Number(/(\d+(?:\.\d+)?)/.exec(line.label)?.[1]) : NaN;
  const rg = replayGeminiOf(l);
  const atMs = l.replay ? replayMs(l.replay, now) : 0;
  return {
    event: cfg.event,
    url: ml?.url ?? cfg.url ?? null,
    source: sourceOf(s),
    live: s.live,
    asOf: s.asOf,
    note: s.note ?? (s.live ? "Live from Gemini Prediction Markets." : "Last prices seen on Gemini."),
    settled: isSettled(cfg, now),
    moneyline: ml
      ? {
          home: { code: cfg.home ?? null, prob: price(cfg.home) },
          away: { code: cfg.away ?? null, prob: price(cfg.away) },
          draw: ml.contracts.find((c) => c.ticker.toUpperCase() === "D")?.prob ?? null,
        }
      : null,
    total: line && Number.isFinite(lineNum) ? { line: lineNum, over: line.prob } : null,
    track: rg && l.replay?.startedAt !== null ? replayMoneylineTrack(rg.g, cfg.home, atMs) : [],
  };
}

export function publicView(l: Lobby, token: string | null, baseUrl: string) {
  const now = Date.now();
  const game = getGame(l.gameId);
  const me = findPlayer(l, token);
  const m = l.market;
  const name = (id: string) => l.players[id]?.name ?? "?";
  const py = m ? lmsr.priceYes(m.yes, m.no, m.b) : 0.5;
  const run = l.replay;
  const parked = run?.parkedMarket ?? null;
  const open = openValues(l);
  const score = run
    ? {
        home: run.state.home.name, away: run.state.away.name, homeShort: run.state.home.short, awayShort: run.state.away.short,
        homeScore: run.state.score.home, awayScore: run.state.score.away, clock: run.state.clock.display, period: run.state.clock.period,
        status: run.state.status, started: run.startedAt !== null, lastPlay: run.state.lastEvent?.text ?? null,
      }
    : undefined;
  return {
    code: l.code,
    /** Tap-to-confirm (lib/hw.ts): this phone's bet waiting for a tap on the box. */
    tapConfirm: me ? pendingFor(l, me.id, now) : null,
    v: l.v,
    now,
    phase: l.phase,
    kioskId: l.kioskId,
    joinUrl: `${baseUrl}/l/${l.code}`,
    game: game
      ? {
          id: game.id, title: game.title, subtitle: game.subtitle ?? "", color: game.color ?? "#1d9e75",
          youtubeId: hasVideo(game) ? game.youtubeId : null, kind: game.kind ?? "clip", persona: personaOf(l), score,
          sport: game.kind === "replay" ? sportOf(game) : game.sport ?? null,
          league: game.league ?? null, date: game.date ?? null, real: game.real ?? false, source: game.source ?? null,
        }
      : null,
    gemini: geminiView(l, now),
    mode: lobbyMode(l),
    moments: momentsFor(l).map((x) => ({ ...x, enabled: l.phase === "lobby" || l.phase === "result" })),
    qIndex: l.qIndex,
    questionCount: game?.questions.length ?? 0,
    nextQuestion: run ? null : game?.questions[l.qIndex]?.text ?? null,
    market: m
      ? {
          qIndex: m.qIndex,
          text: m.text,
          short: m.short,
          b: m.b,
          yesShares: m.yes,
          noShares: m.no,
          priceYes: py,
          yesCents: lmsr.toCents(py),
          noCents: 100 - lmsr.toCents(py),
          lastMove: m.lastMove,
          history: m.history.map((p) => lmsr.toCents(p)),
          volume: m.volume,
          openedAt: m.openedAt,
          startAt: m.startAt,
          lockAt: m.lockAt,
          lockAtVideo: m.lockAtVideo,
          lockIn: Math.max(0, Math.ceil((m.lockAt - now) / 1000)),
          outcome: m.outcome,
          winners: Object.entries(m.payouts).sort((a, b) => b[1] - a[1]).map(([id, cents]) => ({ name: name(id), cents })),
          /** "Cooked": backed it and got nothing back (cents = stake), biggest first; empty until it settles. */
          losers: losersOf(m).map((x) => ({ name: name(x.id), cents: x.cents })),
          trades: m.trades.slice(-10).reverse().map((t) => ({ name: t.name, side: t.side, cents: t.cents, at: t.at })),
          ...marketExtras(l, m),
        }
      : null,
    parked: parked
      ? { text: parked.text, yesCents: lmsr.toCents(parked.priceAtLock ?? yesPrice(parked)), model: parked.model ?? null, gemini: parked.gemini ?? null, volume: parked.volume, mode: modeOf(parked), myPosition: me ? parked.positions[me.id] ?? null : null }
      : null,
    // open: cents in the running (or parked) question at value, so boards rank by worth (lib/standings.ts).
    players: l.order.map((id) => ({ id, name: name(id), balance: l.players[id].balance, deposited: l.players[id].deposited, withdrawn: l.players[id].withdrawn, open: open[id] ?? 0 })),
    results: l.results.map((r) => ({
      text: r.text,
      outcome: r.outcome,
      volume: r.volume,
      winners: Object.entries(r.payouts).sort((a, b) => b[1] - a[1]).map(([id, cents]) => ({ name: name(id), cents })),
    })),
    events: l.events.slice(-15),
    captions: (l.captions ?? []).slice(-MAX_CAPTIONS).map((c) => ({ id: c.id, at: c.at, text: c.text })),
    scorecard: buildScorecard(l.scoreEntries ?? []),
    /** On-chain activity (Solana money): explorer links, and "Settled on Solana" once the vault finalized. Null otherwise. */
    chain: chainView(l, me?.id ?? null),
    /** "Pay on the box" request being shown on the box right now (null when none). */
    boxPay: l.boxPay
      ? { name: l.boxPay.name, cents: l.boxPay.cents, url: l.boxPay.url, until: l.boxPay.until, paidAt: l.boxPay.paidAt ?? null, mine: !!me && l.boxPay.playerId === me.id }
      : null,
    me: me
      ? {
          id: me.id,
          name: me.name,
          balance: me.balance,
          deposited: me.deposited,
          withdrawn: me.withdrawn,
          position: m?.positions[me.id] ?? null,
          payout: m?.payouts[me.id] ?? null,
          stake: m && modeOf(m) === "pool" ? m.stakes?.[me.id] ?? { yes: 0, no: 0 } : undefined,
          /** MONEY_MODE=solana: the wallet cash-out goes to by default (paid from / faucet), and whether the faucet was used. */
          solanaAddress: me.solanaAddress ?? null,
          fauceted: !!me.fauceted,
        }
      : null,
  };
}

export type PublicLobby = ReturnType<typeof publicView>;

// ---------------------------------------------------------------- hardware extras (lib/hw.ts)

const hwErr = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof HwError) throw new ApiError(400, e.message);
    throw e;
  }
};

/** Tap-to-confirm: park a bet until the phone taps the box (or presses "Confirm here"). */
export function pendingBuy(l: Lobby, p: Player, side: Side, cents: number, now: number) {
  return hwErr(() => placePending(l, p, side, cents, now));
}

/** Places this player's pending bet. Throws when there is none (expired, or the question moved on). */
export function confirmPending(l: Lobby, p: Player, now: number) {
  const pend = takePending(l, p.id, now);
  if (!pend) throw new ApiError(400, "Nothing to confirm");
  return { side: pend.side, cents: pend.cents, ...buy(l, p, pend.side, pend.cents, now) };
}

/** Box touch hotseat:accept. */
export function hotseatAccept(l: Lobby, now: number): void {
  hwErr(() => acceptHotseat(l, now));
}
