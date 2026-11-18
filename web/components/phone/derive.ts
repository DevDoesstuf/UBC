// Pure helpers for the phone: what to show, derived from the lobby view. No fetching, no React.
import type { LobbyData } from "@/components/client";
import { sharesForSpend } from "@/lib/lmsr";
import { poolPotential, takerStakeFor } from "@/lib/modes";
import { awayFirst, inOrder } from "@/lib/matchup";
import { standings, worthOf as worth } from "@/lib/standings";

export type Side = "yes" | "no";
export type Lobby = LobbyData;
export type Mkt = NonNullable<LobbyData["market"]>;
export type Me = NonNullable<LobbyData["me"]>;
export type MarketMode = "market" | "pool" | "h2h";

export const SIDE: Record<Side, string> = { yes: "Yes", no: "No" };
export const other = (s: Side): Side => (s === "yes" ? "no" : "yes");

export const modeOf = (m: Mkt | null | undefined): MarketMode => (m?.mode === "pool" || m?.mode === "h2h" ? m.mode : "market");

/** Money tied up in the running question (spent, not yet paid back). */
export function inPlay(l: Lobby): number {
  const me = l.me;
  if (!me) return 0;
  let c = 0;
  if (l.market && (l.phase === "open" || l.phase === "locked") && me.position) c += me.position.spent;
  const parked = l.parked?.myPosition as { spent?: number } | null | undefined;
  if (parked?.spent) c += parked.spent;
  return c;
}

/** Tonight's profit: everything you hold or took out, minus what you put in. */
export function profitOf(l: Lobby): number {
  const me = l.me;
  if (!me) return 0;
  return me.balance + me.withdrawn + inPlay(l) - me.deposited;
}

/** Lock clock for the running question, on the server's clock. */
export function lockClock(m: Mkt, serverNow: number) {
  const remainingMs = Math.max(0, m.lockAt - serverNow);
  const window = Math.max(1, m.lockAt - m.openedAt);
  const secs = Math.ceil(remainingMs / 1000);
  return {
    remainingMs,
    secs,
    fraction: Math.min(1, remainingMs / window),
    urgent: remainingMs > 0 && secs <= 5,
    label: secs >= 60 ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : String(secs),
  };
}

/** What a stake returns if `side` wins (cents), or null when it cannot be priced. */
export function stakeReturn(m: Mkt, side: Side, cents: number): number | null {
  const mode = modeOf(m);
  if (mode === "pool") {
    const pool = m.pool ?? { yesCents: 0, noCents: 0 };
    return poolPotential({ yes: pool.yesCents, no: pool.noCents }, side, cents);
  }
  if (mode === "market") {
    const shares = sharesForSpend(side, cents / 100, m.yesShares, m.noShares, m.b);
    return Number.isFinite(shares) ? Math.floor(shares * 100) : null;
  }
  return null;
}

/** "$1 pays $1.61" for the tile: what $1 on `side` returns right now. */
export function perDollar(m: Mkt, side: Side): number | null {
  const r = stakeReturn(m, side, 100);
  return r === null ? null : r / 100;
}

/** Head-to-head: what the taker pays to take everything left on an offer, and gets back if right. */
export function offerTerms(o: { cents: number; odds: number; remaining?: number; takeCents?: number }) {
  const left = o.remaining ?? o.cents;
  const take = o.takeCents ?? takerStakeFor(left, o.odds);
  return { left, take, back: take + left };
}

/** Head-to-head: posting `cents` at `odds` needs this much from a friend; you get both back if right. */
export function offerPreview(cents: number, odds: number) {
  const match = takerStakeFor(cents, odds);
  return { match, back: cents + match };
}

export type MyResult =
  | { kind: "won"; net: number; payout: number }
  | { kind: "lost"; net: number }
  | { kind: "refunded"; amount: number }
  | { kind: "none" };

/** How the settled question went for me. */
export function myResult(l: Lobby): MyResult {
  const m = l.market;
  const me = l.me;
  if (!m || !me || !m.outcome) return { kind: "none" };
  const spent = me.position?.spent ?? 0;
  const payout = me.payout ?? 0;
  if (spent <= 0 && payout <= 0) return { kind: "none" };
  if (m.voided) return { kind: "refunded", amount: payout || spent };
  const net = payout - spent;
  if (payout > 0 && net >= 0) return { kind: "won", net, payout };
  return { kind: "lost", net };
}

export const momentLabel = (l: Lobby, kind: string | null | undefined): string | null => {
  if (!kind) return null;
  const hit = l.moments?.find((x) => x.id === `moment:${kind}` || x.id === kind);
  return hit?.label ?? kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
};

/**
 * What a player is worth tonight (lib/standings.ts): balance, what they already cashed out, and their open
 * positions at value (`open`, from the server). The lobby view carries `withdrawn` for every player; mine
 * is read from `me` in case an older server sends it only there.
 */
export function worthOf(l: Lobby, p: Lobby["players"][number]): number {
  const out = p.id === l.me?.id ? l.me.withdrawn : p.withdrawn;
  return worth({ balance: p.balance, withdrawn: typeof out === "number" ? out : 0, open: p.open });
}

/**
 * Players by worth, best first (ties keep join order), with a shared rank on ties and `lead` only for a sole
 * leader. `boughtIn` ranks only players who put money in (a watcher with $0 is not "2nd of 12").
 */
export function ranked(l: Lobby, boughtIn = false) {
  const players = boughtIn ? l.players.filter((p) => p.deposited > 0) : l.players;
  return standings(players, (p) => worthOf(l, p));
}

type Side2 = { name: string; short?: string; score: number };

/**
 * The scorebug's two teams in drawing order (lib/matchup.ts): US leagues put the away team on the left like the
 * game card ("49ers at Cowboys": SF 0 0 DAL), soccer the home team. null for games without a score.
 */
export function scoreSides(l: Lobby): { left: Side2; right: Side2; label: string } | null {
  const s = l.game?.score;
  if (!s) return null;
  const home: Side2 = { name: s.home, short: s.homeShort ?? undefined, score: s.homeScore };
  const away: Side2 = { name: s.away, short: s.awayShort ?? undefined, score: s.awayScore };
  const at = awayFirst(l.game?.sport, l.game?.league);
  const [left, right] = inOrder(home, away, at);
  return { left, right, label: `${left.name} ${left.score}${at ? " at " : ", "}${right.name} ${right.score}` };
}

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
