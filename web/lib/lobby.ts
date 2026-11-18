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
import { captionLine, isBigTrade, type CaptionEvent, type Persona } from "./announcer";
import { geminiForGame, refForContract, refForHint, toEngineQuotes, type GeminiGameConfig, type GeminiSnapshot } from "./gemini";
import { buildScorecard } from "./scorecard";
import { fillOffer, impliedYes, poolYesShare, refundPairs, roundOdds, settlePairs, settlePool, takerStakeFor, MAX_ODDS, MIN_ODDS } from "./modes";
import { advanceReplay, bestCandidate, calibrateRun, clampPrior, newRun, pregameQuestion, replayDue, replayMs, startRun, takeCandidate, type PendingQ, type ReplayHost } from "./replay/run";
import { findMoment, kioskSafe, MOMENT_KINDS, type MomentKind, type MomentSport } from "./moments";
import { getTimeline } from "./replay/timeline";
import type { Game, Lobby, LobbyEvent, Market, MarketMode, Offer, Player, Side, WithdrawalRecord } from "./types";
import { MARKET_MODES } from "./types";

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
export const BUY_OPTIONS = [100, 200, 500]; // cents, the quick buttons on phones
export const MIN_BUY = 25;
export const MAX_BUY = 5000;
const MAX_CAPTIONS = 10;
/** Pregame question of a replay game (the Gemini-comparable moneyline) trades this long before kickoff. */
export const PREGAME_TRADE_MS = 20_000;

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
  const text = captionLine(ev, personaOf(l), `${l.code}|${seed}|${(l.captions?.length ?? 0)}`);
  if (!text) return;
  const caps = (l.captions ??= []);
  const last = caps.length ? caps[caps.length - 1].id : 0;
  // Captions share the event id counter, so the speaker's audio stream (events + captions) never repeats an id.
  const id = Math.max(last + 1, l.eventSeq + 1, now);
  l.eventSeq = id;
  caps.push({ id, at: now, text, kind: ev.type });
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

function refreshMarketGemini(l: Lobby): void {
  const m = l.market;
  if (!m || !m.geminiKey || l.phase !== "open") return;
  const k = m.geminiKey;
  const ref = k.event && k.contract ? refForContract(l.gemini ?? null, k.event, k.contract) : refForHint(l.gemini ?? null, k.hint, k.yesTeam);
  if (ref) m.gemini = ref;
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
  addEvent(l, "start", moment ? `${moment.call} ${m.text}` : `Trading open: ${m.text}`, "start");
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
    lastResultAt: () => (l.phase === "result" || l.phase === "lobby" ? l.market?.resolvedAt ?? 0 : 0),
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
      const big = ev.type === "goal" || ev.type === "final" || (ev.type === "play_result" && ev.data.touchdown === true) || ev.type === "drive_end" && ev.data.result === "fg";
      if (big && ev.text) caption(l, { type: "play", text: ev.text }, Date.now(), `ev${ev.seq}`);
    },
  };
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
  refreshMarketGemini(l);
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
  if (l.replay && l.phase !== "ended") {
    if (tickReplay(l, now, dryRun)) {
      if (dryRun) return true;
      changed = true;
    }
  }
  const m = l.market;
  if (!m) return changed;
  if (l.phase === "open" && now >= m.lockAt) {
    if (dryRun) return true;
    lockMarket(l, m.lockAt);
    if (l.replay?.pregame) parkPregame(l, now);
    return true;
  }
  if (l.phase === "locked" && !l.replay && m.resolveAt !== null && now >= m.resolveAt) {
    const q = getGame(l.gameId)?.questions[m.qIndex];
    if (q?.answer) {
      if (!dryRun) resolveMarket(l, q.answer, now);
      return true;
    }
  }
  if (!dryRun && l.phase === "open") refreshMarketGemini(l);
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
  const cfg = geminiConfigFor(getGame(l.gameId));
  if (!cfg) return null;
  return geminiForGame(cfg).catch(() => null);
}

/** Read a lobby, applying any timer transition that is due. Returns null when it does not exist. */
export async function getLobby(code: string): Promise<Lobby | null> {
  code = normCode(code);
  if (!code) return null;
  const l = await read(code);
  if (!l) return null;
  const g = l.phase === "open" || l.phase === "lobby" ? await geminiFor(l) : null;
  const stale = !!g && (!l.gemini || g.at !== l.gemini.at || g.live !== l.gemini.live);
  if (stale || tick(l, Date.now(), true)) return mutate(code, () => {}, g);
  return l;
}

export async function getKioskLobby(kioskId: string): Promise<Lobby | null> {
  const code = await kvGet(kioskKey(kioskId));
  if (!code) return null;
  const l = await getLobby(code);
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
  const gemini = await geminiForGame(geminiConfigFor(game) as GeminiGameConfig).catch(() => null);
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
  return p;
}

/** Adds money to a player's balance. `ref` makes it idempotent (a Coinbase transaction id or Solana signature is only credited once). */
export function creditDeposit(l: Lobby, playerId: string, cents: number, source: "demo" | "coinbase" | "solana", ref: string, now: number): boolean {
  const p = l.players[playerId];
  if (!p || cents <= 0 || l.deposits[ref]) return false;
  p.balance += cents;
  p.deposited += cents;
  l.deposits[ref] = { playerId, cents, at: now, source, ref };
  addEvent(l, "deposit", `${p.name} added ${usd(cents)}`);
  return true;
}

/** Sets the trading mode for the next questions (host choice before or between questions). */
export function setMode(l: Lobby, mode: MarketMode): void {
  if (l.phase === "open" || l.phase === "locked") throw new ApiError(400, "Change the mode between questions");
  if (l.phase === "ended") throw new ApiError(400, "This session has ended");
  l.mode = mode;
}

export function openMarket(l: Lobby, now: number): void {
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
  refreshMarketGemini(l);
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
    throw new ApiError(400, bestCandidate(run, nowMs) ? "Try again in a moment" : "Waiting for the next play. A question opens by itself when one comes up.");
  }
}

export function lockMarket(l: Lobby, now: number = Date.now()): void {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is not open");
  const m = l.market;
  l.phase = "locked";
  m.lockAt = Math.min(m.lockAt, now);
  m.priceAtLock = yesPrice(m);
  refreshMarketGemini(l);
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
  (l.scoreEntries ??= []).push({ room, model: m.model ?? null, gemini: m.gemini?.prob ?? null, outcome: outcome === "yes" ? 1 : 0 });
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
  recordScore(l, m, outcome);
  l.results.push({ qIndex: m.qIndex, text: m.text, outcome, volume: m.volume, payouts: { ...m.payouts } });
  l.phase = "result";
  // A called moment is an extra question: it does not use up one of the game's scripted questions.
  if (m.source?.kind !== "moment") l.qIndex = m.qIndex + 1;
  const winners = winnersOf(l, m, outcome);
  const head = outcome === "yes" ? "YES!" : "NO!";
  addEvent(l, "result", winners.length ? `${head} ${winners.map((w) => `${w.name} wins ${usd(w.cents)}`).join(", ")}` : `${head} No winners this time.`, "win");
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
  }
  const w = mk.write({ state: run?.state ?? null });
  l.market = newMarket(l, now, {
    qIndex: l.qIndex, questionId: `moment-${k}-${now}`, text: w.text, short: w.short, b: game.b ?? 10, prior: w.prior,
    startAt: 0, lockAt: now + mk.lockSecs * 1000, lockAtVideo: 0, resolveAt: null,
    source: { kind: "moment", moment: k, label: mk.label, rationale: w.rationale },
  });
  l.phase = "open";
  announceOpen(l, l.market, now, mk);
}

/** Refund every stake (the resolver could not settle it, e.g. a penalty on the play). */
export function voidMarket(l: Lobby, reason: string | null, now: number): void {
  if (l.phase === "open") lockMarket(l, now);
  if (l.phase !== "locked" || !l.market) throw new ApiError(400, "Nothing to void");
  const m = l.market;
  if (l.replay?.current?.key === m.questionId) l.replay.current = null;
  settle(l, m, null, now);
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
  addEvent(l, "result", `Pregame call: ${outcome === "yes" ? "YES" : "NO"}! ${winners.map((w) => `${w.name} wins ${usd(w.cents)}`).join(", ") || "No winners."}`, "win");
  const atLock = m.priceAtLock ?? yesPrice(m);
  caption(l, { type: "result", outcome, winners, atLockPct: (outcome === "yes" ? atLock : 1 - atLock) * 100 }, now, `parked-${m.questionId}`);
}

export function endSession(l: Lobby, now: number = Date.now()): void {
  if (l.phase === "open" || l.phase === "locked") throw new ApiError(400, "Resolve the current question first");
  if (l.replay?.parkedMarket) settleParked(l, null, "the session ended before the final whistle", now);
  l.phase = "ended";
  addEvent(l, "end", "Session over. Cash out on your phone.", "tap");
  const board = l.order.map((id) => l.players[id]).map((p) => ({ name: p.name, cents: p.balance + p.withdrawn - p.deposited }));
  board.sort((a, b) => b.cents - a.cents);
  const sc = buildScorecard(l.scoreEntries ?? []);
  caption(l, { type: "end", leader: board[0] ?? null, verdict: sc.n ? sc.verdict : null }, now, "end");
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
  if (p.balance < Math.min(cents, takerStakeFor(o.cents - o.filled, o.odds))) throw new ApiError(400, "Not enough balance. Add money first.");
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
    gemini: m.gemini ? { prob: m.gemini.prob, label: m.gemini.label, asOf: m.gemini.asOf, url: m.gemini.url, live: m.gemini.live } : null,
    priceAtLock: m.priceAtLock ?? null,
    voided: m.voided ?? false,
    rationale: m.source && "rationale" in m.source ? m.source.rationale : null,
    moment: m.source?.kind === "moment" ? m.source.moment : m.source?.kind === "replay" ? m.source.moment ?? null : null,
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

export function publicView(l: Lobby, token: string | null, baseUrl: string) {
  const now = Date.now();
  const game = getGame(l.gameId);
  const me = findPlayer(l, token);
  const m = l.market;
  const name = (id: string) => l.players[id]?.name ?? "?";
  const py = m ? lmsr.priceYes(m.yes, m.no, m.b) : 0.5;
  const run = l.replay;
  const parked = run?.parkedMarket ?? null;
  const score = run
    ? {
        home: run.state.home.name, away: run.state.away.name, homeShort: run.state.home.short, awayShort: run.state.away.short,
        homeScore: run.state.score.home, awayScore: run.state.score.away, clock: run.state.clock.display, period: run.state.clock.period,
        status: run.state.status, started: run.startedAt !== null, lastPlay: run.state.lastEvent?.text ?? null,
      }
    : undefined;
  return {
    code: l.code,
    v: l.v,
    now,
    phase: l.phase,
    kioskId: l.kioskId,
    joinUrl: `${baseUrl}/l/${l.code}`,
    game: game
      ? {
          id: game.id, title: game.title, subtitle: game.subtitle ?? "", color: game.color ?? "#1d9e75",
          youtubeId: hasVideo(game) ? game.youtubeId : null, kind: game.kind ?? "clip", persona: personaOf(l), score,
        }
      : null,
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
          trades: m.trades.slice(-10).reverse().map((t) => ({ name: t.name, side: t.side, cents: t.cents, at: t.at })),
          ...marketExtras(l, m),
        }
      : null,
    parked: parked
      ? { text: parked.text, yesCents: lmsr.toCents(parked.priceAtLock ?? yesPrice(parked)), model: parked.model ?? null, gemini: parked.gemini ?? null, volume: parked.volume, mode: modeOf(parked), myPosition: me ? parked.positions[me.id] ?? null : null }
      : null,
    players: l.order.map((id) => ({ id, name: name(id), balance: l.players[id].balance, deposited: l.players[id].deposited })),
    results: l.results.map((r) => ({
      text: r.text,
      outcome: r.outcome,
      volume: r.volume,
      winners: Object.entries(r.payouts).sort((a, b) => b[1] - a[1]).map(([id, cents]) => ({ name: name(id), cents })),
    })),
    events: l.events.slice(-15),
    captions: (l.captions ?? []).slice(-MAX_CAPTIONS).map((c) => ({ id: c.id, at: c.at, text: c.text })),
    scorecard: buildScorecard(l.scoreEntries ?? []),
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
