// The lobby: one shared state per watch party. Every device (kiosk, phones, watch page) is a view of it.
// All game logic lives here, so the kiosk firmware only displays state and sends taps.
import { randomBytes } from "crypto";
import { kvDel, kvGet, kvSet, withLock } from "./store";
import { getGame, hasVideo } from "./games";
import * as lmsr from "./lmsr";
import type { Lobby, LobbyEvent, Player, Side, WithdrawalRecord } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const MAX_PLAYERS = 12;
export const BUY_OPTIONS = [100, 200, 500]; // cents, the quick buttons on phones
export const MIN_BUY = 25;
export const MAX_BUY = 5000;

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

// ---------------------------------------------------------------- time-based transitions

/** Applies (or, with dryRun, only detects) the transitions that happen on a timer: auto-lock and auto-resolve. */
function tick(l: Lobby, now: number, dryRun = false): boolean {
  const m = l.market;
  if (!m) return false;
  if (l.phase === "open" && now >= m.lockAt) {
    if (!dryRun) lockMarket(l);
    return true;
  }
  if (l.phase === "locked" && m.resolveAt !== null && now >= m.resolveAt) {
    const q = getGame(l.gameId)?.questions[m.qIndex];
    if (q?.answer) {
      if (!dryRun) resolveMarket(l, q.answer, now);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- reading and changing a lobby

/** Load, change and save a lobby under a lock. `fn` throws ApiError to refuse the change. */
export async function mutate(code: string, fn: (l: Lobby, now: number) => void): Promise<Lobby> {
  code = normCode(code);
  return withLock(`lobby:${code}`, async () => {
    const l = await read(code);
    if (!l) throw new ApiError(404, "Lobby not found. Pick a game on the kiosk to start a new one.");
    const now = Date.now();
    tick(l, now);
    fn(l, now);
    tick(l, now);
    l.v++;
    l.updatedAt = now;
    await write(l);
    return l;
  });
}

/** Read a lobby, applying any timer transition that is due. Returns null when it does not exist. */
export async function getLobby(code: string): Promise<Lobby | null> {
  code = normCode(code);
  if (!code) return null;
  const l = await read(code);
  if (!l) return null;
  if (tick(l, Date.now(), true)) return mutate(code, () => {});
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

export async function createLobby(kioskId: string, gameId: string): Promise<Lobby> {
  const game = getGame(gameId);
  if (!game) throw new ApiError(404, "Unknown game");
  if (!game.live || game.questions.length === 0) throw new ApiError(400, `${game.title} is coming soon`);
  const now = Date.now();
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Array.from(randomBytes(4), (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join("");
    const l: Lobby = {
      code, kioskId, gameId, createdAt: now, updatedAt: now, v: 1, phase: "lobby", qIndex: 0,
      players: {}, order: [], market: null, results: [], events: [], eventSeq: 0,
      deposits: {}, withdrawals: [], housePnl: 0,
    };
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
  return p;
}

/** Adds money to a player's balance. `ref` makes it idempotent (a Coinbase transaction id is only credited once). */
export function creditDeposit(l: Lobby, playerId: string, cents: number, source: "demo" | "coinbase", ref: string, now: number): boolean {
  const p = l.players[playerId];
  if (!p || cents <= 0 || l.deposits[ref]) return false;
  p.balance += cents;
  p.deposited += cents;
  l.deposits[ref] = { playerId, cents, at: now, source, ref };
  addEvent(l, "deposit", `${p.name} added ${usd(cents)}`);
  return true;
}

export function openMarket(l: Lobby, now: number): void {
  if (l.phase !== "lobby" && l.phase !== "result") throw new ApiError(400, "A question is already running");
  const game = getGame(l.gameId);
  const q = game?.questions[l.qIndex];
  if (!game || !q) throw new ApiError(400, "No more questions in this game");
  const tradeSecs = Math.max(5, q.lockAt - q.startAt);
  const resolveSecs = q.resolveAt != null ? Math.max(tradeSecs, q.resolveAt - q.startAt) : null;
  l.market = {
    qIndex: l.qIndex, questionId: q.id, text: q.text, short: q.short || q.text, b: game.b ?? 10,
    yes: 0, no: 0, volume: 0,
    openedAt: now, startAt: q.startAt, lockAt: now + tradeSecs * 1000, lockAtVideo: q.lockAt,
    resolveAt: q.answer && resolveSecs !== null ? now + resolveSecs * 1000 : null,
    history: [0.5], lastMove: 0, positions: {}, trades: [], outcome: null, payouts: {}, resolvedAt: null,
  };
  l.phase = "open";
  addEvent(l, "start", `Trading open: ${q.text}`, "start");
}

export function lockMarket(l: Lobby): void {
  if (l.phase !== "open") throw new ApiError(400, "Trading is not open");
  l.phase = "locked";
  addEvent(l, "lock", "Trading closed. Watch the play!", "lock");
}

export function resolveMarket(l: Lobby, outcome: Side, now: number): void {
  if (l.phase === "open") lockMarket(l);
  if (l.phase !== "locked" || !l.market) throw new ApiError(400, "Nothing to resolve");
  const m = l.market;
  m.outcome = outcome;
  m.resolvedAt = now;
  let paid = 0;
  for (const [pid, pos] of Object.entries(m.positions)) {
    const shares = outcome === "yes" ? pos.yes : pos.no;
    const cents = Math.floor(shares * 100 + 1e-6); // each winning share pays $1
    const p = l.players[pid];
    if (cents > 0 && p) {
      p.balance += cents;
      m.payouts[pid] = cents;
      paid += cents;
    }
  }
  l.housePnl += m.volume - paid;
  l.results.push({ qIndex: m.qIndex, text: m.text, outcome, volume: m.volume, payouts: { ...m.payouts } });
  l.phase = "result";
  l.qIndex = m.qIndex + 1;
  const winners = Object.entries(m.payouts)
    .sort((a, b) => b[1] - a[1])
    .map(([pid, c]) => `${l.players[pid]?.name ?? "?"} wins ${usd(c)}`);
  const head = outcome === "yes" ? "YES!" : "NO!";
  addEvent(l, "result", winners.length ? `${head} ${winners.join(", ")}` : `${head} No winners this time.`, "win");
}

export function endSession(l: Lobby): void {
  if (l.phase === "open" || l.phase === "locked") throw new ApiError(400, "Resolve the current question first");
  l.phase = "ended";
  addEvent(l, "end", "Session over. Cash out on your phone.", "tap");
}

export function buy(l: Lobby, p: Player, side: Side, cents: number, now: number) {
  if (l.phase !== "open" || !l.market) throw new ApiError(400, "Trading is closed");
  if (side !== "yes" && side !== "no") throw new ApiError(400, "Pick YES or NO");
  if (!Number.isInteger(cents) || cents < MIN_BUY || cents > MAX_BUY) {
    throw new ApiError(400, `Buy between ${usd(MIN_BUY)} and ${usd(MAX_BUY)}`);
  }
  if (p.balance < cents) throw new ApiError(400, "Not enough balance. Add money first.");
  const m = l.market;
  const before = lmsr.toCents(lmsr.priceYes(m.yes, m.no, m.b));
  const shares = lmsr.sharesForSpend(side, cents / 100, m.yes, m.no, m.b);
  if (side === "yes") m.yes += shares;
  else m.no += shares;
  const priceAfter = lmsr.priceYes(m.yes, m.no, m.b);
  const after = lmsr.toCents(priceAfter);
  p.balance -= cents;
  m.volume += cents;
  const pos = (m.positions[p.id] ??= { yes: 0, no: 0, spent: 0 });
  pos[side] += shares;
  pos.spent += cents;
  m.history.push(priceAfter);
  if (m.history.length > 120) m.history.splice(1, m.history.length - 120);
  m.lastMove = after > before ? 1 : after < before ? -1 : 0;
  m.trades.push({ at: now, playerId: p.id, name: p.name, side, cents, shares, priceAfter });
  if (m.trades.length > 60) m.trades.splice(0, m.trades.length - 60);
  return { shares, priceAfter };
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

export function publicView(l: Lobby, token: string | null, baseUrl: string) {
  const now = Date.now();
  const game = getGame(l.gameId);
  const me = findPlayer(l, token);
  const m = l.market;
  const name = (id: string) => l.players[id]?.name ?? "?";
  const py = m ? lmsr.priceYes(m.yes, m.no, m.b) : 0.5;
  return {
    code: l.code,
    v: l.v,
    now,
    phase: l.phase,
    kioskId: l.kioskId,
    joinUrl: `${baseUrl}/l/${l.code}`,
    game: game
      ? { id: game.id, title: game.title, subtitle: game.subtitle ?? "", color: game.color ?? "#1d9e75", youtubeId: hasVideo(game) ? game.youtubeId : null }
      : null,
    qIndex: l.qIndex,
    questionCount: game?.questions.length ?? 0,
    nextQuestion: game?.questions[l.qIndex]?.text ?? null,
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
        }
      : null,
    players: l.order.map((id) => ({ id, name: name(id), balance: l.players[id].balance, deposited: l.players[id].deposited })),
    results: l.results.map((r) => ({
      text: r.text,
      outcome: r.outcome,
      volume: r.volume,
      winners: Object.entries(r.payouts).sort((a, b) => b[1] - a[1]).map(([id, cents]) => ({ name: name(id), cents })),
    })),
    events: l.events.slice(-15),
    me: me
      ? {
          id: me.id,
          name: me.name,
          balance: me.balance,
          deposited: me.deposited,
          withdrawn: me.withdrawn,
          position: m?.positions[me.id] ?? null,
          payout: m?.payouts[me.id] ?? null,
        }
      : null,
  };
}

export type PublicLobby = ReturnType<typeof publicView>;
