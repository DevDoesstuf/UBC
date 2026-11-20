// Hardware-integration extras for the box (kiosk) and its speaker: tap-to-confirm bets, join flashes,
// big win/loss call-outs, the hot seat, inside info and standings breaks. Lobby state lives in `l.hw`;
// lib/lobby.ts calls the hooks below, lib/kiosk.ts reads hwKioskFields(). Self-contained (no import of
// lib/lobby.ts) so there is no import cycle.
import { hashSeed, toSpeech } from "./announcer";
import { openValues, standings } from "./standings";
import type { Lobby, LobbyEvent, Market, Player, Side, SoundName } from "./types";

export const CONFIRM_MS = 20_000;
export const JOIN_FLASH_MS = 3000;
export const RESULT_FLASH_MS = 4500;
export const HOTSEAT_MS = 5000;
export const HOTSEAT_MIN_LEFT_MS = 4000;
export const HOTSEAT_EVERY = 3;
export const INTERLUDE_MS = 6000;
export const INTERLUDE_EVERY = 3;
export const BIG_WIN_PROFIT = 500;
export const BIG_LOSS_CENTS = 300;

export interface HwPending { side: Side; cents: number; at: number; until: number; questionId: string }
export interface HwFlash { kind: "join" | "bigwin" | "bigloss" | "collect"; name: string; text: string; cents?: number; until: number }
export interface HwHotseat {
  playerId: string; name: string; questionId: string; mult: number; until: number;
  accepted?: boolean; done?: boolean; bonus?: number;
}
export interface HwState {
  pending?: Record<string, HwPending>;
  flash?: HwFlash | null;
  hotseat?: HwHotseat | null;
  /** Questions asked (results count) when the last hot seat was called. */
  hotseatAtResult?: number | null;
  /** Question ids already considered for a hot seat. */
  hotseatSkip?: string | null;
  interludeUntil?: number | null;
}

export class HwError extends Error {}

const hw = (l: Lobby): HwState => (l.hw ??= {});
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const usdShort = (c: number) => (c % 100 === 0 ? `$${c / 100}` : usd(c));

function pushEvent(l: Lobby, kind: LobbyEvent["kind"], text: string, sound: SoundName | undefined, now: number): void {
  const id = Math.max(l.eventSeq + 1, now);
  l.eventSeq = id;
  l.events.push({ id, at: now, kind, text, sound });
  if (l.events.length > 40) l.events.splice(0, l.events.length - 40);
}

/** An announcer line (box/TV caption + the speaker's voice). */
function pushCaption(l: Lobby, text: string, say: string, kind: string, now: number): void {
  const caps = (l.captions ??= []);
  const last = caps.length ? caps[caps.length - 1].id : 0;
  const id = Math.max(last + 1, l.eventSeq + 1, now);
  l.eventSeq = id;
  caps.push({ id, at: now, text, kind, say });
  if (caps.length > 10) caps.splice(0, caps.length - 10);
}

// ---------------------------------------------------------------- 1. tap-to-confirm

/** A phone parks a bet; the box shows it and an NFC tap on the box (/k/<kiosk>) or "Confirm here" places it. */
export function placePending(l: Lobby, p: Player, side: Side, cents: number, now: number): HwPending {
  if (l.phase !== "open" || !l.market) throw new HwError("Trading is closed");
  if (side !== "yes" && side !== "no") throw new HwError("Pick YES or NO");
  if (!Number.isInteger(cents) || cents < 25 || cents > 5000) throw new HwError("Pick between $0.25 and $50.00");
  if (p.balance < cents) throw new HwError("Not enough balance. Add money first.");
  const pend: HwPending = { side, cents, at: now, until: Math.min(now + CONFIRM_MS, l.market.lockAt), questionId: l.market.questionId };
  (hw(l).pending ??= {})[p.id] = pend;
  pushEvent(l, "tap", `${p.name}: tap the box to confirm`, "tap", now);
  return pend;
}

/** The player's live pending bet, if any. */
export function pendingFor(l: Lobby, playerId: string, now: number): HwPending | null {
  const p = l.hw?.pending?.[playerId];
  if (!p || now > p.until || l.phase !== "open" || l.market?.questionId !== p.questionId) return null;
  return p;
}

/** Removes and returns the player's pending bet (the caller then runs the normal buy). */
export function takePending(l: Lobby, playerId: string, now: number): HwPending | null {
  const p = pendingFor(l, playerId, now);
  if (l.hw?.pending) delete l.hw.pending[playerId];
  return p;
}

export function anyPending(l: Lobby, now: number): boolean {
  return Object.keys(l.hw?.pending ?? {}).some((id) => !!pendingFor(l, id, now));
}

// ---------------------------------------------------------------- 3. joins

const JOIN_LINES = [
  (n: string) => `${n}'s here! Yayyy!`,
  (n: string) => `Make some noise, ${n} just walked in!`,
  (n: string) => `${n} has entered the huddle!`,
  (n: string) => `Look who it is! ${n}, welcome!`,
  (n: string) => `${n} is in the building!`,
  (n: string) => `Ladies and gentlemen... ${n}!`,
  (n: string) => `${n} pulls up a chair. Let's go!`,
  (n: string) => `Fresh legs! ${n} checks in!`,
  (n: string) => `${n} is here, and they came to win!`,
  (n: string) => `Oh, it's ${n}! The party can start!`,
];

/** Deterministic per name, varied across names. */
export function joinLine(name: string): string {
  return JOIN_LINES[hashSeed(name.toLowerCase()) % JOIN_LINES.length](name);
}

export function onJoin(l: Lobby, p: Player, now: number): void {
  const text = joinLine(p.name);
  // The existing join caption keeps its text; the speaker says the fun line instead.
  const caps = l.captions ?? [];
  const last = caps[caps.length - 1];
  if (last && last.kind === "join") last.say = toSpeech(text);
  else pushCaption(l, text, toSpeech(text), "join", now);
  hw(l).flash = { kind: "join", name: p.name, text, until: now + JOIN_FLASH_MS };
}

/** Cash out by tapping the box at the end: the box shows who just collected and the speaker says it. */
export function onCollect(l: Lobby, p: Player, cents: number, now: number): void {
  const text = `${p.name} collects ${dollars(cents)}!`;
  pushEvent(l, "deposit", text, "coin", now);
  pushCaption(l, text, toSpeech(text), "collect", now);
  hw(l).flash = { kind: "collect", name: p.name, cents, text, until: now + COLLECT_FLASH_MS };
}
const COLLECT_FLASH_MS = 5000;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------- 2. bets in

/** What a player has riding on the market, in cents. */
export function stakeOf(m: Market, pid: string): number {
  if (m.mode === "pool") return (m.stakes?.[pid]?.yes ?? 0) + (m.stakes?.[pid]?.no ?? 0);
  if (m.mode === "h2h") {
    const pairs = (m.pairs ?? []).reduce((a, p) => a + (p.maker === pid ? p.makerCents : 0) + (p.taker === pid ? p.takerCents : 0), 0);
    const offers = (m.offers ?? []).filter((o) => o.by === pid && o.open).reduce((a, o) => a + o.cents - o.filled, 0);
    return pairs + offers;
  }
  return m.positions[pid]?.spent ?? 0;
}

export function betsIn(l: Lobby): { n: number; of: number } | undefined {
  const m = l.market;
  if (!m) return undefined;
  return { n: l.order.filter((id) => stakeOf(m, id) > 0).length, of: l.order.length };
}

// ---------------------------------------------------------------- 4. dramatic results / 5. hot seat bonus

/** After settle(), before the result is recorded: pays the hot seat bonus, then calls out a big win or loss. */
export function onResult(l: Lobby, m: Market, outcome: Side, now: number): void {
  const h = l.hw?.hotseat;
  if (h && h.questionId === m.questionId) {
    const paid = m.payouts[h.playerId] ?? 0;
    const won = paid > 0 && backedSide(m, h.playerId, outcome);
    if (h.accepted && won) {
      const bonus = paid * (h.mult - 1);
      const p = l.players[h.playerId];
      if (p) {
        p.balance += bonus;
        l.housePnl -= bonus;
        m.payouts[h.playerId] = paid + bonus;
        h.bonus = bonus;
        pushCaption(l, `Hot seat pays! ${h.name} doubles up: ${usd(paid + bonus)}!`, toSpeech(`Hot seat pays! ${h.name} doubles up to ${usd(paid + bonus)}!`), "hotseat", now);
      }
    }
    h.done = true;
  }
  const rows = l.order.map((id) => {
    const stake = stakeOf(m, id) || (m.positions[id]?.spent ?? 0);
    const paid = m.payouts[id] ?? 0;
    return { id, name: l.players[id]?.name ?? "?", stake, paid, profit: paid - stake };
  }).filter((r) => r.stake > 0);
  const top = [...rows].sort((a, b) => b.profit - a.profit)[0];
  const worst = [...rows].sort((a, b) => a.profit - b.profit)[0];
  const seed = hashSeed(`${l.code}|${m.questionId}`);
  if (top && top.profit > 0 && (top.profit >= BIG_WIN_PROFIT || (top.stake >= 100 && top.paid >= 2 * top.stake))) {
    const lines = [
      `${top.name} is on fire! Up ${usd(top.profit)} on that one!`,
      `Bow down to ${top.name}! Plus ${usd(top.profit)}!`,
      `${top.name} called it and cashed ${usd(top.paid)}! Genius!`,
    ];
    const text = lines[seed % lines.length];
    pushEvent(l, "bigwin", text, "cheer", now);
    pushCaption(l, text, toSpeech(text), "bigwin", now);
    hw(l).flash = { kind: "bigwin", name: top.name, cents: top.profit, text, until: now + RESULT_FLASH_MS };
  } else if (worst && worst.profit <= -BIG_LOSS_CENTS) {
    const lost = -worst.profit;
    const lines = [
      `Ouch, ${worst.name}! That's ${usd(lost)} gone. Shake it off!`,
      `${worst.name} just donated ${usd(lost)} to the house. Thank you!`,
      `Rough one, ${worst.name}. ${usd(lost)} down, but the comeback starts now!`,
    ];
    const text = lines[seed % lines.length];
    pushEvent(l, "bigloss", text, "lose", now);
    pushCaption(l, text, toSpeech(text), "bigloss", now);
    hw(l).flash = { kind: "bigloss", name: worst.name, cents: lost, text, until: now + RESULT_FLASH_MS };
  }
  // 7. standings break after every 3rd resolved question (results gets this one pushed right after).
  const resolved = l.results.length + 1;
  if (resolved % INTERLUDE_EVERY === 0 && l.order.length) {
    hw(l).interludeUntil = now + INTERLUDE_MS;
    const open = openValues(l);
    const board = standings(l.order.map((id) => ({ ...l.players[id], open: open[id] ?? 0 })));
    const top3 = board.slice(0, 3);
    const text = top3.map((p, i) => i === 0 ? `${p.name} leads with ${usdShort(p.worth)}` : `${p.name} has ${usdShort(p.worth)}`).join(", ");
    const say = `Standings check! ${text}.`;
    pushCaption(l, say, toSpeech(say), "standings", now);
  }
}

function backedSide(m: Market, pid: string, outcome: Side): boolean {
  if (m.mode === "pool") return (m.stakes?.[pid]?.[outcome] ?? 0) > 0;
  if (m.mode === "h2h") return (m.pairs ?? []).some((p) => (p.side === outcome ? p.maker : p.taker) === pid);
  return (m.positions[pid]?.[outcome] ?? 0) > 0;
}

/** Void/refund: the hot seat on that question is over without a bonus. */
export function onVoid(l: Lobby, m: Market): void {
  const h = l.hw?.hotseat;
  if (h && h.questionId === m.questionId) h.done = true;
}

/** The replay engine waits out a standings break before it opens the next question. */
export function interludeHold(l: Lobby): number {
  return l.hw?.interludeUntil ?? 0;
}

// ---------------------------------------------------------------- 5. hot seat (timer side)

/** Runs from the lobby's tick(). Returns true when something changed. */
export function tickHw(l: Lobby, now: number, dryRun: boolean): boolean {
  const s = l.hw;
  const m = l.market;
  const h = s?.hotseat;
  // Expired without an accept: say so once.
  if (h && !h.accepted && !h.done && now > h.until) {
    if (dryRun) return true;
    h.done = true;
    const text = `Too slow, ${h.name}! The hot seat cools off.`;
    pushCaption(l, text, toSpeech(text), "hotseat", now);
    return true;
  }
  if (l.phase !== "open" || !m) return false;
  if (h && h.questionId === m.questionId) return false;
  if (s?.hotseatSkip === m.questionId) return false;
  const left = m.lockAt - now;
  if (left < HOTSEAT_MIN_LEFT_MS + HOTSEAT_MS) {
    // Too late for this one.
    if (dryRun) return false;
    if (now >= m.openedAt) (l.hw ??= {}).hotseatSkip = m.questionId;
    return false;
  }
  const asked = l.results.length;
  const lastAt = s?.hotseatAtResult;
  if (lastAt != null && asked - lastAt < HOTSEAT_EVERY) return false;
  const seed = hashSeed(`${l.code}|hot|${m.questionId}`);
  // Every HOTSEAT_EVERY questions, fired early in the window so it always fits before the lock.
  const span = Math.max(0, m.lockAt - m.openedAt - HOTSEAT_MIN_LEFT_MS - HOTSEAT_MS - 3000);
  const fireAt = m.openedAt + 3000 + (span ? (seed >>> 3) % Math.min(span, 3000) : 0);
  if (now < fireAt) return false;
  const holders = l.order.filter((id) => stakeOf(m, id) > 0);
  if (!holders.length) return false; // keep checking until someone bets or it is too late
  if (dryRun) return true;
  const pid = holders[(seed >>> 7) % holders.length];
  const name = l.players[pid]?.name ?? "?";
  const st = (l.hw ??= {});
  st.hotseat = { playerId: pid, name, questionId: m.questionId, mult: 2, until: now + HOTSEAT_MS };
  st.hotseatAtResult = asked;
  const text = `${name}, tap the box in the next five seconds to double your stake!`;
  pushEvent(l, "hotseat", `Hot seat: ${name}`, "siren", now);
  pushCaption(l, text, toSpeech(text), "hotseat", now);
  return true;
}

/** Box touch `hotseat:accept`. */
export function acceptHotseat(l: Lobby, now: number): void {
  const h = l.hw?.hotseat;
  if (!h || h.accepted || h.done || now > h.until || l.market?.questionId !== h.questionId) {
    throw new HwError("No hot seat right now");
  }
  h.accepted = true;
  const text = `${h.name} takes the hot seat! Win this one and the payout doubles!`;
  pushEvent(l, "hotseat", `${h.name} accepted the hot seat`, "coin", now);
  pushCaption(l, text, toSpeech(text), "hotseat", now);
}

// ---------------------------------------------------------------- box fields

export interface HwKioskFields {
  confirm?: { name: string; side: "YES" | "NO"; cents: number; leftMs: number };
  betsIn?: { n: number; of: number };
  flash?: { kind: HwFlash["kind"]; name: string; text: string; cents?: number; leftMs: number };
  hotseat?: { name: string; mult: number; leftMs: number };
  tip?: { label: string; text: string };
  interlude?: { kind: "standings"; leftMs: number };
}

function tipOf(l: Lobby): string | null {
  const m = l.market;
  if (!m) return null;
  const src = m.source as { rationale?: string } | undefined;
  const last = l.replay?.state.lastEvent?.text;
  const bits: string[] = [];
  if (src?.rationale) bits.push(src.rationale.replace(/[.\s]+$/, ""));
  else if (last) bits.push(`Last play: ${last.replace(/[.\s]+$/, "")}`);
  if (typeof m.model === "number") bits.push(`Model: ${Math.round(m.model * 100)}% YES`);
  return bits.length ? bits.join(". ").slice(0, 160) : null;
}

export function hwKioskFields(l: Lobby | null, now: number = Date.now()): HwKioskFields {
  if (!l) return {};
  const out: HwKioskFields = {};
  const s = l.hw;
  const m = l.market;
  if (l.phase === "open" && m) {
    let best: [string, HwPending] | null = null;
    for (const [pid, p] of Object.entries(s?.pending ?? {})) {
      if (pendingFor(l, pid, now) && (!best || p.at > best[1].at)) best = [pid, p];
    }
    if (best) out.confirm = { name: l.players[best[0]]?.name ?? "?", side: best[1].side === "yes" ? "YES" : "NO", cents: best[1].cents, leftMs: Math.max(0, best[1].until - now) };
    out.betsIn = betsIn(l);
    const tip = tipOf(l);
    if (tip) out.tip = { label: "Inside info", text: tip };
    const h = s?.hotseat;
    if (h && !h.accepted && !h.done && h.questionId === m.questionId && now <= h.until) out.hotseat = { name: h.name, mult: h.mult, leftMs: Math.max(0, h.until - now) };
  }
  if (l.phase === "locked" && m) out.betsIn = betsIn(l);
  const f = s?.flash;
  if (f && now < f.until) out.flash = { kind: f.kind, name: f.name, text: f.text, ...(f.cents != null ? { cents: f.cents } : {}), leftMs: f.until - now };
  if (s?.interludeUntil && now < s.interludeUntil && l.phase !== "open" && l.phase !== "ended") out.interlude = { kind: "standings", leftMs: s.interludeUntil - now };
  return out;
}
