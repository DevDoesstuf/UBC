"use client";
// The TV's price chart, after the box's Kalshi-style chart: the room's YES price as a smooth line with a soft
// fill, the model as a dashed level and Gemini as a subtle thin line, on one 0..100 axis with quiet gridlines.
// Motion: the room line draws on when a market opens, every new trade tweens the lines (and the axis) to the
// new prices instead of jumping, and the end dot pings. Reduced motion jumps straight to the final state, and
// the resting style is always the drawn chart. Decorative: pair it with text that says the numbers.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

export type Line = { id: string; points: number[]; tone: "room" | "gemini" | "model" };

const reduced = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** Tween a list of numbers to `target` (a longer list grows from its last value). */
function useTween(target: number[], ms = 650): number[] {
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  const key = target.join(",");
  useEffect(() => {
    const start = from.current;
    const to = key ? key.split(",").map(Number) : [];
    if (reduced() || start.length === 0) {
      from.current = to;
      setShown(to);
      return;
    }
    const base = to.map((_, i) => start[Math.min(i, start.length - 1)]);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = ease(Math.min(1, (t - t0) / ms));
      const cur = to.map((v, i) => base[i] + (v - base[i]) * k);
      from.current = cur;
      setShown(cur);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [key, ms]);
  if (shown.length === target.length) return shown;
  const prev = from.current;
  return target.map((v, i) => (prev.length ? prev[Math.min(i, prev.length - 1)] : v));
}

export function Sparkline({ lines, className = "", minRange = 20, axis = true }: { lines: Line[]; className?: string; minRange?: number; axis?: boolean }) {
  const gid = useId().replace(/:/g, "");
  // One tween over every line's points (flattened), so the lines and the axis move together.
  const sizes = lines.map((l) => l.points.length);
  const flat = useTween(lines.flatMap((l) => l.points));
  let at = 0;
  const shown = lines.map((l, i) => {
    const pts = flat.slice(at, at + sizes[i]);
    at += sizes[i];
    return { ...l, points: pts };
  });
  const all = shown.flatMap((l) => l.points);
  const room = shown.find((l) => l.tone === "room") ?? shown[0];
  const n = room?.points.length ?? 0;
  if (!room || all.length === 0) return <div className={className} aria-hidden="true" />;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < minRange) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(100 - minRange, mid - minRange / 2));
    hi = lo + minRange;
  }
  const pad = (hi - lo) * 0.16;
  lo = Math.max(-2, lo - pad);
  hi = Math.min(102, hi + pad);
  const X = (i: number, len: number) => (len <= 1 ? (i ? 100 : 0) : (i / (len - 1)) * 100);
  const Y = (p: number) => 100 - ((p - lo) / (hi - lo)) * 100;
  // Smooth, monotone between points (control points at the horizontal midpoints: no overshoot).
  const path = (ps: number[]) => {
    const pts = ps.length === 1 ? [ps[0], ps[0]] : ps;
    let d = `M 0 ${Y(pts[0]).toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const x0 = X(i - 1, pts.length), x1 = X(i, pts.length), xm = (x0 + x1) / 2;
      d += ` C ${xm.toFixed(2)} ${Y(pts[i - 1]).toFixed(2)} ${xm.toFixed(2)} ${Y(pts[i]).toFixed(2)} ${x1.toFixed(2)} ${Y(pts[i]).toFixed(2)}`;
    }
    return d;
  };
  const span = hi - lo;
  const tick = span > 60 ? 25 : span > 30 ? 10 : 5;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / tick) * tick; v <= hi; v += tick) if (v >= 0 && v <= 100) ticks.push(v);
  const last = room.points[room.points.length - 1];
  return (
    <div className={`tv-sparkbox ${className}`} aria-hidden="true">
      {axis && ticks.map((v) => (
        <span key={v} className="tv-spark-tick" style={{ top: `${Y(v)}%` }}><b>{v}%</b></span>
      ))}
      <div className="tv-spark-win">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="tv-spark-svg">
          <defs>
            <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--yes)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--yes)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {shown.map((l) => {
            if (!l.points.length) return null;
            if (l.tone === "model") {
              const y = Y(l.points[l.points.length - 1]).toFixed(2);
              return <path key={l.id} className="tv-line-model" d={`M 0 ${y} H 100`} vectorEffect="non-scaling-stroke" />;
            }
            const d = path(l.points);
            if (l.tone === "gemini") return <path key={l.id} className="tv-line-gem" d={d} vectorEffect="non-scaling-stroke" />;
            return (
              <g key={l.id}>
                <path className="tv-line-fill" d={`${d} V 100 H 0 Z`} fill={`url(#g${gid})`} />
                <path className="tv-line-room" d={d} vectorEffect="non-scaling-stroke" />
              </g>
            );
          })}
        </svg>
      </div>
      {shown.filter((l) => l.tone !== "model" && l.points.length).map((l) => (
        <span key={l.id} className={`tv-spark-dot ${l.tone}`} style={{ top: `${Y(l.tone === "room" ? last : l.points[l.points.length - 1])}%` } as CSSProperties}>
          {l.tone === "room" && <i key={n} className="tv-spark-ping" />}
        </span>
      ))}
    </div>
  );
}
