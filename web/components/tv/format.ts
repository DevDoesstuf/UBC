// TV-only display helpers. Odds formatting is the shared kit's (components/huddle/format.ts), so the TV, the
// phones and the home page always print a price the same way.
import { clampProb, signedUsd, usd, type SplitPart } from "@/components/huddle";

export { clampProb, payoutText, pctLabel, pctText, pctValue } from "@/components/huddle";

/** Cents as dollars: 1250 -> "$12.50"; signed: "+$3.10" / "−$3.10". */
export function money(cents: number, opts: { sign?: boolean } = {}): string {
  if (opts.sign) return signedUsd(cents);
  return cents < 0 ? `−${usd(-cents)}` : usd(cents);
}

/** Seconds as "14" or "1:20". */
export function secsText(s: number): string {
  const v = Math.max(0, Math.ceil(s));
  return v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}` : String(v);
}

export const SIDE_LABEL = { yes: "Yes", no: "No" } as const;

/** A YES probability as the kit SplitBar's two parts (missing -> an even split). */
export function yesNo(yes: number | null | undefined): SplitPart[] {
  const p = clampProb(yes) ?? 0.5;
  return [
    { id: "yes", label: "Yes", p, tone: "yes" },
    { id: "no", label: "No", p: 1 - p, tone: "no" },
  ];
}
