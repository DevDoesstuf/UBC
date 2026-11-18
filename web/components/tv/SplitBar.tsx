import type { CSSProperties, ReactNode } from "react";
import { clampProb, pctLabel } from "./format";

export type Tone = "yes" | "no";

/**
 * seam-glide: one bar, YES and NO side by side, each as wide as the room thinks it is likely. Only transforms
 * animate (a scaled YES layer over the NO track and a translated seam), so the odds glide on a spring.
 */
export function SplitBar({ yes, className = "", style, children }: {
  /** YES share 0..1. */
  yes: number | null | undefined;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const p = clampProb(yes) ?? 0.5;
  return (
    <div className={`hd-split ${className}`} style={style} role="img" aria-label={`Yes ${pctLabel(p)}, No ${pctLabel(1 - p)}`}>
      <div className="hd-split-fill hd-tone-no" style={{ transform: "scaleX(1)", zIndex: 1 }} />
      <div className="hd-split-fill hd-tone-yes" style={{ transform: `scaleX(${p})`, zIndex: 2 }} />
      <div className="hd-split-seam" style={{ transform: `translateX(${p * 100}%)` }} />
      {children}
    </div>
  );
}

/**
 * Notches on the split axis for the other forecasters (Model solid ▼, Gemini hollow ▽), each at its YES
 * probability. Pair with a legend that repeats shape and number.
 */
export function SplitMarkers({ markers, className = "" }: {
  markers: { id: string; p: number | null | undefined; shape: "solid" | "hollow" }[];
  className?: string;
}) {
  return (
    <div className={`hd-markers ${className}`} aria-hidden="true">
      {markers.map((m) => {
        const p = clampProb(m.p);
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
      <path d="M1.2 1.2h9.6L6 8.8z" fill={shape === "solid" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
