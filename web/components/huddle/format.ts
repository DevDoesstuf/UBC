/**
 * Display formatting for odds and money. Every helper is total: NaN, undefined, 0, 1 and
 * out-of-range values produce a readable string, never an empty one.
 */

const isNum = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p);

/** Clamp a probability into [0, 1]; non-numbers become null. */
export function clampProb(p: number | null | undefined): number | null {
  if (!isNum(p)) return null;
  return Math.min(1, Math.max(0, p));
}

/** Whole-number percentage text without the sign: 0.7712 -> "77". Tiny -> "<1", near certain -> ">99", missing -> "–". */
export function pctText(p: number | null | undefined): string {
  const v = clampProb(p);
  if (v === null) return "–";
  if (v > 0 && v < 0.005) return "<1";
  if (v < 1 && v > 0.995) return ">99";
  return String(Math.round(v * 100));
}

/** Numeric part used for rolling digits and direction (null when unknown). */
export function pctValue(p: number | null | undefined): number | null {
  const v = clampProb(p);
  return v === null ? null : Math.round(v * 1000) / 10;
}

/** Spoken form: "77 percent". */
export function pctLabel(p: number | null | undefined): string {
  const t = pctText(p);
  if (t === "–") return "no price yet";
  if (t === "<1") return "under 1 percent";
  if (t === ">99") return "over 99 percent";
  return `${t} percent`;
}

/** Decimal payout per 1 staked at probability p: "1.30", "15", "100+"; null when meaningless. */
export function multiplierText(p: number | null | undefined): string | null {
  const v = clampProb(p);
  if (v === null || v <= 0 || v >= 1) return null;
  const x = 1 / v;
  if (x >= 100) return "100+";
  // Always to the cent, so the tile ("$1 pays $11.32") matches the $1 chip under it ("get $11.32").
  return x.toFixed(2);
}

/** "$1 pays $1.30". Certain outcomes and missing prices say so. */
export function payoutText(p: number | null | undefined): string {
  const v = clampProb(p);
  if (v === null) return "No price yet";
  if (v >= 1) return "Sure thing, no payout";
  const m = multiplierText(v);
  if (m === null) return "Long shot, no takers yet";
  return `$1 pays $${m}`;
}

/** Normalise probabilities so they sum to 1 (for split bars); missing -> equal shares. */
export function normalise(ps: (number | null | undefined)[]): number[] {
  const vals = ps.map((p) => clampProb(p) ?? 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return vals.map(() => 1 / Math.max(1, vals.length));
  return vals.map((v) => v / sum);
}

/** Cents as dollars: 1250 -> "$12.50". */
export const usd = (cents: number) => `$${(Math.round(cents) / 100).toFixed(2)}`;

/** Short dollars for chips: 500 -> "$5", 250 -> "$2.50". */
export const usdShort = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : usd(cents));

/** Signed money for P&L: "+$1.20", "−$0.80" (true minus), "$0.00". */
export function signedUsd(cents: number): string {
  if (Math.abs(cents) < 1) return "$0.00";
  return `${cents > 0 ? "+" : "−"}${usd(Math.abs(cents))}`;
}

/** 1 -> "1st", 2 -> "2nd". */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
