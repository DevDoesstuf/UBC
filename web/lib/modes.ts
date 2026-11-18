// Pool (pari-mutuel) and head-to-head settlement math. Integer cents only, no floats in money.
// Ported from Huddle packages/shared/src/math/pool.ts and bet.ts (decimal.js replaced by integer math:
// odds are kept as integer hundredths, e.g. 1.30 -> 130). Pure module.

export type Side = "yes" | "no";

// ---------------------------------------------------------------- pool

export interface PoolStake {
  player: string;
  side: Side;
  cents: number;
}

export interface PoolSettlement {
  /** Cents returned to each player (winners: their share of the whole pot; refunds when nobody won). */
  payouts: Record<string, number>;
  /** Rounding remainder that goes to the house. */
  dust: number;
  refunded: boolean;
  total: number;
}

/**
 * payout_i = floor(stake_i * total / winningTotal). Dust (the rounding remainder) goes to the house.
 * If nobody backed the winning side, every stake is refunded.
 */
export function settlePool(stakes: PoolStake[], winner: Side): PoolSettlement {
  const total = stakes.reduce((a, s) => a + s.cents, 0);
  const winning = stakes.filter((s) => s.side === winner).reduce((a, s) => a + s.cents, 0);
  const payouts: Record<string, number> = {};
  if (winning === 0) {
    for (const s of stakes) payouts[s.player] = (payouts[s.player] ?? 0) + s.cents;
    return { payouts, dust: 0, refunded: true, total };
  }
  // Pay per player (sum of their winning stakes) so dust is computed once per player.
  const byPlayer: Record<string, number> = {};
  for (const s of stakes) if (s.side === winner) byPlayer[s.player] = (byPlayer[s.player] ?? 0) + s.cents;
  let paid = 0;
  for (const [player, cents] of Object.entries(byPlayer)) {
    const p = Number((BigInt(cents) * BigInt(total)) / BigInt(winning));
    payouts[player] = p;
    paid += p;
  }
  return { payouts, dust: total - paid, refunded: false, total };
}

/** What `cents` more on `side` would pay if it won, given the pot before it. */
export function poolPotential(pool: { yes: number; no: number }, side: Side, cents: number): number {
  const total = pool.yes + pool.no + cents;
  const winning = pool[side] + cents;
  return winning > 0 ? Number((BigInt(cents) * BigInt(total)) / BigInt(winning)) : 0;
}

/** Share of the pot on YES (0..1), or `prior` while the pot is empty. */
export function poolYesShare(pool: { yes: number; no: number }, prior = 0.5): number {
  const total = pool.yes + pool.no;
  return total > 0 ? pool.yes / total : prior;
}

// ---------------------------------------------------------------- head to head

export const MIN_ODDS = 1.01;
export const MAX_ODDS = 50;

/** Decimal odds rounded to 2 places inside [1.01, 50]. */
export function roundOdds(odds: number): number {
  if (!Number.isFinite(odds)) return 2;
  const o = Math.min(MAX_ODDS, Math.max(MIN_ODDS, odds));
  return Math.round(o * 100) / 100;
}

/** Fair odds for a side with probability p (0.77 -> 1.30). */
export function fairOdds(p: number): number {
  return roundOdds(1 / Math.min(0.99, Math.max(0.02, p)));
}

const hundredths = (odds: number) => Math.round(roundOdds(odds) * 100);

/** Taker stake that matches `makerCents` at `odds` (rounded up so the maker is never under-covered, min 1). */
export function takerStakeFor(makerCents: number, odds: number): number {
  if (makerCents <= 0) return 0;
  const h = hundredths(odds) - 100;
  return Math.max(1, Math.ceil((makerCents * h) / 100));
}

export interface OfferLike {
  cents: number; // maker stake
  filled: number; // maker stake already matched
  odds: number;
}

export interface Fill {
  takerCents: number;
  makerCents: number;
  newFilled: number;
  complete: boolean;
}

/** Match up to `takerCents` against what is left of an offer. Excess beyond the capacity is not used. */
export function fillOffer(offer: OfferLike, takerCents: number): Fill {
  if (!Number.isInteger(takerCents) || takerCents <= 0) throw new Error("Amount must be a positive number of cents");
  const left = offer.cents - offer.filled;
  if (left <= 0) throw new Error("That offer is fully taken");
  const capacity = takerStakeFor(left, offer.odds);
  if (takerCents >= capacity) return { takerCents: capacity, makerCents: left, newFilled: offer.cents, complete: true };
  const h = hundredths(offer.odds) - 100;
  const makerCents = Math.min(left, Math.floor((takerCents * 100) / h));
  if (makerCents <= 0) throw new Error("Amount too small for these odds");
  return { takerCents, makerCents, newFilled: offer.filled + makerCents, complete: offer.filled + makerCents >= offer.cents };
}

export interface MatchedPair {
  offerId: string;
  maker: string;
  taker: string;
  /** The side the maker backs. The taker has the other side. */
  side: Side;
  makerCents: number;
  takerCents: number;
}

/** Winner of each matched pair receives both stakes. */
export function settlePairs(pairs: MatchedPair[], winner: Side): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pairs) {
    const w = p.side === winner ? p.maker : p.taker;
    out[w] = (out[w] ?? 0) + p.makerCents + p.takerCents;
  }
  return out;
}

/** Void: both sides get their own stake back. */
export function refundPairs(pairs: MatchedPair[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pairs) {
    out[p.maker] = (out[p.maker] ?? 0) + p.makerCents;
    out[p.taker] = (out[p.taker] ?? 0) + p.takerCents;
  }
  return out;
}

/** YES probability implied by a maker's offer: backing YES at odds o means P(YES) = 1/o. */
export function impliedYes(side: Side, odds: number): number {
  const p = 1 / roundOdds(odds);
  return side === "yes" ? p : 1 - p;
}
