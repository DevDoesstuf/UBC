// LMSR (logarithmic market scoring rule) for one YES/NO market.
// The server stores only two numbers per market: YES shares sold (qy) and NO shares sold (qn).
// b sets how fast the price moves. Everything here is in dollars and shares; callers convert cents.
//
//   cost   C(qy, qn) = b * ln(e^(qy/b) + e^(qn/b))
//   price  P(yes)    = e^(qy/b) / (e^(qy/b) + e^(qn/b))
//   buying costs C(after) - C(before)
//
// Pure functions, no imports: used by the server (trades) and by phones (trade previews).

export type Side = "yes" | "no";

/** C(qy, qn), computed with log-sum-exp so large share counts do not overflow. */
export function cost(qy: number, qn: number, b: number): number {
  const m = Math.max(qy, qn);
  return m + b * Math.log(Math.exp((qy - m) / b) + Math.exp((qn - m) / b));
}

/** Price of YES between 0 and 1. Price of NO is 1 - this. */
export function priceYes(qy: number, qn: number, b: number): number {
  return 1 / (1 + Math.exp((qn - qy) / b));
}

/** Dollar cost of buying `shares` of `side`. */
export function costToBuy(side: Side, shares: number, qy: number, qn: number, b: number): number {
  const before = cost(qy, qn, b);
  const after = side === "yes" ? cost(qy + shares, qn, b) : cost(qy, qn + shares, b);
  return after - before;
}

/**
 * Shares you get for spending `dollars` on `side` (closed form, the inverse of costToBuy).
 * Solving C(q_side + s, q_other) = C(q) + m for s gives
 *   s = b * ln( e^(m/b) + e^((q_other - q_side)/b) * (e^(m/b) - 1) )
 */
export function sharesForSpend(side: Side, dollars: number, qy: number, qn: number, b: number): number {
  if (dollars <= 0) return 0;
  const [mine, other] = side === "yes" ? [qy, qn] : [qn, qy];
  const em = Math.exp(dollars / b);
  return b * Math.log(em + Math.exp((other - mine) / b) * (em - 1));
}

/**
 * Worst case the market maker can lose on one market (the subsidy) when it opens at YES price `prior`:
 * b * ln(1 / p) where p is the opening price of the side that wins. b * ln 2 at 50/50, $29.96 at b = 10 and 5%.
 */
export function maxLoss(b: number, prior = 0.5): number {
  const p = Math.min(Math.max(prior, 1e-6), 1 - 1e-6);
  return b * Math.log(1 / Math.min(p, 1 - p));
}

/** Price as whole cents for display, kept inside 1..99 so neither side ever shows 0 or 100. */
export function toCents(p: number): number {
  return Math.min(99, Math.max(1, Math.round(p * 100)));
}
