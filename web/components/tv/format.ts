// Display formatting for odds and money on the TV page. Every helper is total: missing, NaN, 0 and 1 give a
// readable string, never an empty one.

const isNum = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p);

export function clampProb(p: number | null | undefined): number | null {
  return isNum(p) ? Math.min(1, Math.max(0, p)) : null;
}

/** Whole-number percentage text without the sign: 0.77 -> "77"; tiny "<1", near certain ">99", missing "–". */
export function pctText(p: number | null | undefined): string {
  const v = clampProb(p);
  if (v === null) return "–";
  if (v > 0 && v < 0.005) return "<1";
  if (v < 1 && v > 0.995) return ">99";
  return String(Math.round(v * 100));
}

/** Numeric value that drives the roll direction (null when unknown). */
export function pctValue(p: number | null | undefined): number | null {
  const v = clampProb(p);
  return v === null ? null : Math.round(v * 1000) / 10;
}

export function pctLabel(p: number | null | undefined): string {
  const t = pctText(p);
  if (t === "–") return "no price yet";
  if (t === "<1") return "under 1 percent";
  if (t === ">99") return "over 99 percent";
  return `${t} percent`;
}

/** "$1 pays $1.30" at probability p (one winning share pays $1). */
export function payoutText(p: number | null | undefined): string {
  const v = clampProb(p);
  if (v === null) return "No price yet";
  if (v >= 1) return "Sure thing";
  if (v <= 0) return "Long shot, no takers";
  const x = 1 / v;
  return `$1 pays $${x >= 100 ? "100+" : x >= 10 ? String(Math.round(x)) : x.toFixed(2)}`;
}

/** Cents as dollars: 1250 -> "$12.50"; signed: "+$3.10" / "−$3.10". */
export function money(cents: number, opts: { sign?: boolean } = {}): string {
  const s = `$${(Math.abs(cents) / 100).toFixed(2)}`;
  if (!opts.sign) return cents < 0 ? `−${s}` : s;
  return cents > 0 ? `+${s}` : cents < 0 ? `−${s}` : s;
}

/** Seconds as "14" or "1:20". */
export function secsText(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}` : String(v);
}

export const SIDE_LABEL = { yes: "Yes", no: "No" } as const;
