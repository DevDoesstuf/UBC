"use client";
// The TV's multi-line price chart. The shared kit's Sparkline (components/huddle) draws one series; the TV
// needs the room and Gemini on one axis, so it keeps this variant. Same draw-on motion (hd-spark-draw-*).
import { useState, type CSSProperties } from "react";

export type Line = { points: number[]; stroke: string; fill?: string; dash?: boolean; dot?: boolean; id: string };

/**
 * price-draw: stepped price lines (like an order book chart) on a shared 0..100 axis that auto-scales with a
 * minimum 20-point range so noise does not look like a crash. When the first line grows, the new segment
 * reveals with a sliding window (transform only) and the end dot pings. Decorative: pair it with text that
 * says the numbers.
 */
export function Sparkline({ lines, className = "", minRange = 20 }: { lines: Line[]; className?: string; minRange?: number }) {
  const main = lines[0];
  const n = Math.max(1, main?.points.length ?? 1);
  const [drawn, setDrawn] = useState<{ n: number; flip: boolean; from: number }>({ n, flip: false, from: 1 });
  if (drawn.n !== n) setDrawn({ n, flip: !drawn.flip, from: drawn.n <= 1 || n <= 1 ? 0 : (drawn.n - 1) / (n - 1) });
  const all = lines.flatMap((l) => l.points);
  if (!main || all.length === 0) return <div className={className} aria-hidden="true" />;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < minRange) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(100 - minRange, mid - minRange / 2));
    hi = lo + minRange;
  }
  const pad = (hi - lo) * 0.14;
  lo -= pad;
  hi += pad;
  const X = (i: number, len: number) => (len <= 1 ? 100 : (i / (len - 1)) * 100);
  const Y = (p: number) => 100 - ((p - lo) / (hi - lo)) * 100;
  const path = (ps: number[]) => {
    let d = `M 0 ${Y(ps[0]).toFixed(2)}`;
    for (let i = 1; i < ps.length; i++) d += ` H ${X(i, ps.length).toFixed(2)} V ${Y(ps[i]).toFixed(2)}`;
    return d + (ps.length === 1 ? " H 100" : "");
  };
  const guide = 50 > lo && 50 < hi ? Y(50) : null;
  return (
    <div className={`tv-sparkbox ${className}`} aria-hidden="true">
      {guide !== null && <span className="tv-spark-guide" style={{ top: `${guide}%` }} />}
      <div className={`tv-spark-win ${drawn.flip ? "hd-spark-draw-a" : "hd-spark-draw-b"}`} style={{ ["--from" as string]: String(drawn.from) } as CSSProperties}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="hd-spark">
          {lines.map((l) => {
            if (!l.points.length) return null;
            const d = path(l.points);
            return (
              <g key={l.id}>
                {l.fill && <path d={`${d} V 100 H 0 Z`} fill={l.fill} stroke="none" />}
                <path
                  d={d}
                  fill="none"
                  stroke={l.stroke}
                  strokeWidth={l.dash ? 2 : 3}
                  strokeDasharray={l.dash ? "5 5" : undefined}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            );
          })}
        </svg>
      </div>
      {lines.map((l) =>
        l.dot === false || !l.points.length ? null : (
          <span key={l.id} className={`tv-spark-dot ${l.dash ? "hollow" : ""}`} style={{ top: `${Y(l.points[l.points.length - 1])}%`, ["--c" as string]: l.stroke } as CSSProperties}>
            {!l.dash && <i className="hd-ping" />}
          </span>
        ),
      )}
    </div>
  );
}
