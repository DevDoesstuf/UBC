// Who is ahead, one rule for every board (phone, TV, box): what each player is worth right now.
//
//   worth = balance + withdrawn + open
//
// `open` is what the player's stake in a question that has not settled is worth: in market (LMSR) mode the
// shares at the current price, in pool and head-to-head mode the stake at cost (matched or still on offer).
// Without it a player who just bought would drop down the board while the question is open.
//
// Pure: no server imports, so phones and the TV use the same code as lib/kiosk.ts and lib/lobby.ts.
import { priceYes } from "./lmsr";
import type { Lobby, Market } from "./types";

type OpenMarket = Pick<Market, "yes" | "no" | "b" | "positions" | "outcome" | "resolvedAt"> & Partial<Pick<Market, "mode" | "offers">>;

/** Cents a player's stake in `m` is worth while it has not settled (0 once it settled or was voided). */
export function openValue(m: OpenMarket | null | undefined, playerId: string): number {
  if (!m || m.outcome || m.resolvedAt != null) return 0;
  const mode = m.mode ?? "market";
  const pos = m.positions[playerId];
  let v = 0;
  if (pos) {
    if (mode === "market") {
      const p = priceYes(m.yes, m.no, m.b);
      v += (pos.yes * p + pos.no * (1 - p)) * 100;
    } else v += pos.spent;
  }
  // Head to head: an offer's unmatched stake has left the balance too (it comes back at lock).
  if (mode === "h2h") for (const o of m.offers ?? []) if (o.open && o.by === playerId) v += Math.max(0, o.cents - o.filled);
  return Math.round(v);
}

/** Open value per player across the running question and a replay's parked pregame question. */
export function openValues(l: Pick<Lobby, "order" | "market" | "replay">): Record<string, number> {
  const parked = l.replay?.parkedMarket ?? null;
  const out: Record<string, number> = {};
  for (const id of l.order) out[id] = openValue(l.market, id) + openValue(parked, id);
  return out;
}

/**
 * "Cooked": who backed a settled question and got nothing back, biggest loss first (cents = what they put in).
 * Empty before it settles and when it was voided (everyone refunded). The box result screen and the TV use it.
 */
export function losersOf(m: Pick<Market, "positions" | "payouts" | "outcome"> & Partial<Pick<Market, "voided">>): { id: string; cents: number }[] {
  if (!m.outcome || m.voided) return [];
  return Object.entries(m.positions)
    .filter(([id, pos]) => pos.spent > 0 && !(m.payouts[id] > 0))
    .sort((a, b) => b[1].spent - a[1].spent)
    .map(([id, pos]) => ({ id, cents: pos.spent }));
}

export interface Worthy {
  balance: number;
  withdrawn?: number;
  /** Cents in open positions (see openValue). */
  open?: number;
}

/** What a player is worth tonight: balance, plus what they cashed out, plus open positions at value. */
export const worthOf = (p: Worthy): number => p.balance + (p.withdrawn ?? 0) + (p.open ?? 0);

export type Standing<T> = T & {
  worth: number;
  /** 1-based, shared on a tie (1, 1, 3). */
  rank: number;
  /** The one player strictly ahead of everyone (and worth something): false for everyone on a tie at the top. */
  lead: boolean;
};

/** Players best first (ties keep their order), with a shared rank on ties and a leader only when there is one. */
export function standings<T extends Worthy>(players: readonly T[], worth: (p: T) => number = worthOf): Standing<T>[] {
  const rows = players.map((p, i) => ({ p, i, w: worth(p) })).sort((a, b) => b.w - a.w || a.i - b.i);
  const top = rows[0]?.w ?? 0;
  const soleLeader = rows.length > 0 && top > 0 && (rows.length === 1 || rows[1].w < top);
  let rank = 0;
  return rows.map((r, k) => {
    if (k === 0 || r.w < rows[k - 1].w) rank = k + 1;
    return { ...r.p, worth: r.w, rank, lead: soleLeader && k === 0 };
  });
}
