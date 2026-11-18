"use client";
import { createElement, useMemo, useState, type CSSProperties, type ReactNode } from "react";

/* ------------------------------------------------------------------ kinetic type */

/**
 * kinetic-text: every word rises out of its own baseline mask on a springy stagger (CSS, so it finishes in a
 * background tab and is instant under reduced motion). The sentence is in the DOM once for assistive tech.
 * Change `text` (or `replay`) to play it again.
 */
export function Kinetic({ text, as = "span", className = "", style, delay = 0, stagger = 55, replay, id }: {
  text: string;
  as?: "span" | "h1" | "h2" | "h3" | "p";
  className?: string;
  style?: CSSProperties;
  delay?: number;
  stagger?: number;
  replay?: unknown;
  id?: string;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  const shown: ReactNode[] = [];
  words.forEach((w, i) => {
    if (i > 0) shown.push(" ");
    shown.push(
      <span key={i} className="hd-wm">
        <span className="hd-w" style={{ ["--wi" as string]: Math.min(i, 24) } as CSSProperties}>
          {w}
        </span>
      </span>,
    );
  });
  return createElement(
    as,
    {
      key: `${text}|${String(replay ?? "")}`,
      id,
      className: `hd-words ${className}`,
      style: { ...style, ["--d" as string]: `${delay}ms`, ["--ws" as string]: `${stagger}ms` } as CSSProperties,
    },
    <span key="sr" className="hd-sr">{text}</span>,
    <span key="words" aria-hidden="true">{shown}</span>,
  );
}

/* ------------------------------------------------------------------ confetti */

const BURST_COLOURS = ["#12A150", "#7CCB4E", "#E8A33D", "#1468FF", "#0B7A3E", "#FF6B00", "#F2C94C"];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/** A one-shot confetti burst sized to the moment. Decorative; hidden under reduced motion. Change `seed` to fire again. */
export function Burst({ count = 24, seed = 1, colours = BURST_COLOURS, x = "50%", y = "50%", spread = 14, delay = 0 }: {
  count?: number;
  seed?: number;
  colours?: string[];
  x?: string;
  y?: string;
  spread?: number;
  delay?: number;
}) {
  const bits = useMemo(() => {
    const r = rng(seed * 9301 + count);
    return Array.from({ length: count }, (_, i) => {
      const a = r() * Math.PI * 2;
      const d = spread * (0.35 + r() * 0.65);
      const long = r() > 0.5;
      return {
        i,
        "--x": `${(Math.cos(a) * d).toFixed(2)}rem`,
        "--y": `${(Math.sin(a) * d * 0.75 - spread * 0.25).toFixed(2)}rem`,
        "--r": `${Math.round((r() - 0.5) * 1080)}deg`,
        "--c": colours[i % colours.length],
        "--w": long ? "0.45rem" : "0.6rem",
        "--h": long ? "1rem" : "0.6rem",
        "--br": long ? "2px" : "999px",
        "--dur": `${1100 + Math.round(r() * 700)}ms`,
        "--d": `${delay + Math.round(r() * 120)}ms`,
        "--fall": `${(3 + r() * 6).toFixed(1)}rem`,
      };
    });
  }, [seed, count, spread, delay, colours]);
  return (
    <span key={seed} className="hd-burst" style={{ ["--bx" as string]: x, ["--by" as string]: y } as CSSProperties} aria-hidden="true">
      {bits.map(({ i, ...v }) => (
        <i key={i} className="hd-bit" style={v as CSSProperties} />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ ambient field */

export interface AuroraBlob { c: string; x: string; y: string; s?: string; mx?: string; my?: string; dur?: string; d?: string }

const AURORA_DEFAULT: AuroraBlob[] = [
  { c: "rgba(18,161,80,0.16)", x: "-12vmax", y: "-18vmax", s: "62vmax", mx: "10vmax", my: "6vmax", dur: "26s" },
  { c: "rgba(124,203,78,0.18)", x: "48vw", y: "30vh", s: "56vmax", mx: "-8vmax", my: "-6vmax", dur: "30s", d: "-6s" },
  { c: "rgba(232,163,61,0.13)", x: "10vw", y: "55vh", s: "50vmax", mx: "9vmax", my: "-4vmax", dur: "34s", d: "-12s" },
];

/** Slow drifting colour field behind the ivory canvas (transform only; static under reduced motion). */
export function Aurora({ blobs = AURORA_DEFAULT, className = "" }: { blobs?: AuroraBlob[]; className?: string }) {
  return (
    <div className={`hd-aurora ${className}`} aria-hidden="true">
      {blobs.map((b, i) => (
        <i
          key={i}
          style={{ "--c": b.c, "--x": b.x, "--y": b.y, "--s": b.s, "--mx": b.mx, "--my": b.my, "--dur": b.dur, "--d": b.d } as CSSProperties}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ people */

/** Avatar fills: vivid, each with a 4.5:1 text colour. Never the YES/NO hues. */
const AVATAR: { bg: string; fg: string }[] = [
  { bg: "#0B7A3E", fg: "#FFFFFF" },
  { bg: "#7CCB4E", fg: "#10261C" },
  { bg: "#E8A33D", fg: "#10261C" },
  { bg: "#10261C", fg: "#FFFFFF" },
  { bg: "#B9A8FF", fg: "#10261C" },
  { bg: "#F2C94C", fg: "#10261C" },
  { bg: "#2BD9C4", fg: "#10261C" },
  { bg: "#5B4636", fg: "#FFFFFF" },
];

export function avatarColour(name: string): { bg: string; fg: string } {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR[h % AVATAR.length];
}

/** A player's squircle with their initial, coloured from their name. Decorative (the name is next to it). */
export function Avatar({ name, size = "2.5rem", className = "" }: { name: string; size?: string; className?: string }) {
  const { bg, fg } = avatarColour(name);
  return (
    <span
      className={`hd-avatar ${className}`}
      style={{ width: size, height: size, borderRadius: `calc(${size} * 0.34)`, background: bg, color: fg, fontSize: `calc(${size} * 0.48)` }}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------------ price history */

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
    <div className={`hd-sparkbox ${className}`} aria-hidden="true">
      {guide !== null && <span className="hd-spark-guide" style={{ top: `${guide}%` }} />}
      <div className={`hd-spark-win ${drawn.flip ? "hd-spark-draw-a" : "hd-spark-draw-b"}`} style={{ ["--from" as string]: String(drawn.from) } as CSSProperties}>
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
          <span key={l.id} className={`hd-spark-dot ${l.dash ? "hollow" : ""}`} style={{ top: `${Y(l.points[l.points.length - 1])}%`, ["--c" as string]: l.stroke } as CSSProperties}>
            {!l.dash && <i className="hd-ping" />}
          </span>
        ),
      )}
    </div>
  );
}
