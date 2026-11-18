import type { CSSProperties, ReactNode } from "react";
import { normalise, pctLabel } from "./format";

export type Tone = "yes" | "no" | "other" | "other-alt";

/** Tone per outcome position: 1st YES blue, last NO orange, middle ones hatched (never colour alone). */
export function toneFor(index: number, count: number): Tone {
  if (index === 0) return "yes";
  if (count === 2 || index === count - 1) return "no";
  return index % 2 ? "other" : "other-alt";
}

export interface SplitPart {
  id: string;
  label: string;
  p: number | null | undefined;
  tone?: Tone;
}

/**
 * seam-glide: one bar per market, outcomes side by side, each as wide as the room thinks it is
 * likely. Only transforms animate (scaleX layers + a translated seam), so odds glide on the spring.
 */
export function SplitBar({
  parts,
  className = "",
  style,
  children,
}: {
  parts: SplitPart[];
  className?: string;
  style?: CSSProperties;
  /** Overlays inside the bar (labels, flood layers). */
  children?: ReactNode;
}) {
  const ps = normalise(parts.map((x) => x.p));
  const cum: number[] = [];
  ps.reduce((a, p, i) => ((cum[i] = a + p), a + p), 0);
  const label = parts.map((x, i) => `${x.label} ${pctLabel(ps[i])}`).join(", ");
  return (
    <div className={`hd-split ${className}`} style={style} role="img" aria-label={label}>
      {parts.map((x, i) => {
        const tone = x.tone ?? toneFor(i, parts.length);
        // Layer i covers [0, cum_i]; earlier layers sit on top.
        return (
          <div
            key={x.id}
            className={`hd-split-fill hd-tone-${tone}`}
            style={{ transform: `scaleX(${i === parts.length - 1 ? 1 : (cum[i] ?? 1)})`, zIndex: parts.length - i }}
          />
        );
      })}
      {cum.slice(0, -1).map((c, i) => (
        <div key={`seam-${i}`} className="hd-split-seam" style={{ transform: `translateX(${c * 100}%)` }} />
      ))}
      {children}
    </div>
  );
}

/**
 * Notches on the split axis for other forecasters (Model, Gemini): a solid or hollow triangle
 * pointing at the bar, each at `p` of its width. Pair with a legend that repeats shapes and numbers.
 */
export function SplitMarkers({
  markers,
  className = "",
}: {
  markers: { id: string; label: string; p: number | null | undefined; shape: "solid" | "hollow" }[];
  className?: string;
}) {
  return (
    <div className={`hd-markers ${className}`} aria-hidden="true">
      {markers.map((m) => {
        const p = typeof m.p === "number" && Number.isFinite(m.p) ? Math.min(1, Math.max(0, m.p)) : null;
        if (p === null) return null;
        return (
          <div key={m.id} className="hd-marker" style={{ transform: `translateX(${p * 100}%)` }}>
            <MarkerShape shape={m.shape} className="hd-marker-shape" />
          </div>
        );
      })}
    </div>
  );
}

export function MarkerShape({ shape, className = "" }: { shape: "solid" | "hollow"; className?: string }) {
  return (
    <svg viewBox="0 0 12 10" width="0.8em" height="0.66em" className={className} aria-hidden="true" focusable="false">
      <path
        d="M1.2 1.2h9.6L6 8.8z"
        fill={shape === "solid" ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
