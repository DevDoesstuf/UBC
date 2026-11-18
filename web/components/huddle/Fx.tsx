"use client";
import { createElement, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* ------------------------------------------------------------------ kinetic type */

/**
 * kinetic-text: every word rises out of its own baseline mask with a springy stagger (CSS, so it
 * finishes in a background tab and is instant under reduced motion). The sentence is in the DOM once
 * for assistive tech; the animated words are presentation. Change `text` (or `replay`) to replay.
 */
export function Kinetic({
  text,
  as = "span",
  className = "",
  style,
  delay = 0,
  stagger = 55,
  replay,
  id,
}: {
  text: string;
  as?: "span" | "h1" | "h2" | "h3" | "p";
  className?: string;
  style?: CSSProperties;
  /** ms before the first word. */
  delay?: number;
  /** ms between words. */
  stagger?: number;
  /** Extra key to replay the same text. */
  replay?: unknown;
  id?: string;
}) {
  const words = text.split(/\s+/).filter(Boolean);
  const shown: ReactNode[] = [];
  words.forEach((w, i) => {
    if (i > 0) shown.push(" ");
    shown.push(
      <span key={i} className="hd-wm">
        <span className="hd-w" style={{ ["--wi" as string]: i } as CSSProperties}>
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
    <span key="sr" className="hd-sr">
      {text}
    </span>,
    <span key="words" aria-hidden="true">
      {shown}
    </span>,
  );
}

/* ------------------------------------------------------------------ confetti */

export const BURST_COLOURS = ["#12A150", "#7CCB4E", "#E8A33D", "#1468FF", "#0B7A3E", "#F2C94C", "#FF6B00"];
export const GOLD_BURST = ["#E8A33D", "#F2C94C", "#7CCB4E", "#12A150"];

/** Small deterministic PRNG so a burst looks the same on every render of the same seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

/**
 * A one-shot confetti burst sized to the moment (`count` 14 for a small win, 40 for the night).
 * Decorative: aria-hidden, hidden under reduced motion, transform/opacity only. Place it in a
 * `position: relative` parent; `x`/`y` are the origin inside it. Change `seed` to fire again.
 */
export function Burst({
  count = 24,
  seed = 1,
  colours = BURST_COLOURS,
  x = "50%",
  y = "50%",
  spread = 14,
  delay = 0,
}: {
  count?: number;
  seed?: number;
  colours?: string[];
  x?: string;
  y?: string;
  /** Radius of the burst in rem. */
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
        x: `${(Math.cos(a) * d).toFixed(2)}rem`,
        y: `${(Math.sin(a) * d * 0.75 - spread * 0.25).toFixed(2)}rem`,
        r: `${Math.round((r() - 0.5) * 1080)}deg`,
        c: colours[i % colours.length],
        w: long ? "0.45rem" : "0.6rem",
        h: long ? "1rem" : "0.6rem",
        br: long ? "2px" : "999px",
        dur: `${1100 + Math.round(r() * 700)}ms`,
        d: `${delay + Math.round(r() * 120)}ms`,
        fall: `${(3 + r() * 6).toFixed(1)}rem`,
      };
    });
  }, [seed, count, spread, delay, colours]);
  return (
    <span key={seed} className="hd-burst" style={{ ["--bx" as string]: x, ["--by" as string]: y } as CSSProperties} aria-hidden="true">
      {bits.map((b) => (
        <i
          key={b.i}
          className="hd-bit"
          style={
            {
              "--x": b.x, "--y": b.y, "--r": b.r, "--c": b.c, "--w": b.w, "--h": b.h,
              "--br": b.br, "--dur": b.dur, "--d": b.d, "--fall": b.fall,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ ambient field */

export interface AuroraBlob {
  /** CSS colour at the blob's centre (alpha 0.12-0.3 on the ivory canvas). */
  c: string;
  x: string;
  y: string;
  s?: string;
  mx?: string;
  my?: string;
  dur?: string;
  d?: string;
}

export const AURORA_DEFAULT: AuroraBlob[] = [
  { c: "rgba(18,161,80,0.18)", x: "-14vmax", y: "-18vmax", s: "62vmax", mx: "10vmax", my: "6vmax", dur: "26s" },
  { c: "rgba(124,203,78,0.18)", x: "48vw", y: "30vh", s: "56vmax", mx: "-8vmax", my: "-6vmax", dur: "30s", d: "-6s" },
  { c: "rgba(232,163,61,0.13)", x: "6vw", y: "58vh", s: "50vmax", mx: "9vmax", my: "-4vmax", dur: "34s", d: "-12s" },
];

/** "#E4002B" + alpha -> "rgba(228,0,43,a)"; anything else passes through. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * A slow drifting colour field for the ivory canvas (radial gradients moved by transform only;
 * static under reduced motion). Pass two team colours during a moment market.
 */
export function Aurora({ blobs = AURORA_DEFAULT, className = "", fixed = false }: { blobs?: AuroraBlob[]; className?: string; fixed?: boolean }) {
  return (
    <div className={`hd-aurora ${fixed ? "hd-aurora-fixed" : ""} ${className}`} aria-hidden="true">
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

/**
 * Avatar fills, white initial on each (all pass 4.5:1). Never the YES/NO hues. The same eight colours and the
 * same hash (FNV-1a of the name) as the box (firmware/kiosk_screen/ui.cpp avatarColor, KioskView), so a player
 * has one colour on the box, the phones and the TV.
 */
const AVATAR: { bg: string; fg: string }[] = [
  "#0B7A3E", "#127C71", "#6D4AD6", "#B4235A", "#5B6B2F", "#8C5A1B", "#2F4858", "#9A3412",
].map((bg) => ({ bg, fg: "#FFFFFF" }));

export function avatarColour(name: string): { bg: string; fg: string } {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return AVATAR[h % AVATAR.length];
}

/** A player's squircle with their initial, coloured from their name. Decorative (the name is next to it). */
export function Avatar({ name, size = "2.5rem", className = "", style }: { name: string; size?: string; className?: string; style?: CSSProperties }) {
  const { bg, fg } = avatarColour(name);
  return (
    <span
      className={`hd-avatar ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: `calc(${size} * 0.34)`,
        background: bg,
        color: fg,
        fontSize: `calc(${size} * 0.48)`,
        boxShadow: `inset 0 calc(${size} * -0.06) 0 rgba(16,38,28,0.18)`,
        ...style,
      }}
      aria-hidden="true"
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

/* ------------------------------------------------------------------ price history */

export interface SeriesPoint {
  t: number;
  p: number;
}

/**
 * A live series for one value (a market's price): seeded from history, then a point is appended
 * whenever `value` changes. Keyed by `key` so a new market starts fresh. Capped at `max` points.
 */
export function useSeries(key: string, value: number | null | undefined, seed: SeriesPoint[] = [], max = 120): SeriesPoint[] {
  const ref = useRef<{ key: string; pts: SeriesPoint[] }>({ key: "", pts: [] });
  if (ref.current.key !== key) ref.current = { key, pts: seed.slice(-max) };
  const pts = ref.current.pts;
  if (typeof value === "number" && Number.isFinite(value)) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.p - value) > 1e-6) ref.current.pts = [...pts, { t: Date.now(), p: value }].slice(-max);
  }
  return ref.current.pts;
}

/**
 * price-draw: a stepped price line (like an order-book chart), the new segment revealed with a
 * sliding window (transform only); the end dot pings. Auto-scaled with a minimum 10-point range so
 * noise does not look like a crash. Pair with text that says the numbers; the chart is aria-hidden.
 */
export function Sparkline({
  points,
  className = "",
  style,
  stroke = "var(--k-green)",
  fill = "rgba(18,161,80,0.12)",
  dot = true,
}: {
  points: SeriesPoint[];
  className?: string;
  style?: CSSProperties;
  stroke?: string;
  fill?: string;
  dot?: boolean;
}) {
  const n = points.length;
  const [drawn, setDrawn] = useState<{ n: number; flip: boolean; from: number }>({ n, flip: false, from: 1 });
  if (drawn.n !== n) setDrawn({ n, flip: !drawn.flip, from: drawn.n <= 1 || n <= 1 ? 0 : (drawn.n - 1) / (n - 1) });
  if (n === 0) return <div className={className} style={style} aria-hidden="true" />;
  const ps = points.map((x) => x.p);
  let lo = Math.min(...ps);
  let hi = Math.max(...ps);
  if (hi - lo < 0.1) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, mid - 0.05);
    hi = Math.min(1, lo + 0.1);
    lo = hi - 0.1;
  }
  const pad = (hi - lo) * 0.12;
  lo -= pad;
  hi += pad;
  const X = (i: number) => (n === 1 ? 100 : (i / (n - 1)) * 100);
  const Y = (p: number) => 100 - ((p - lo) / (hi - lo)) * 100;
  let d = `M 0 ${Y(ps[0]).toFixed(2)}`;
  for (let i = 1; i < n; i++) d += ` H ${X(i).toFixed(2)} V ${Y(ps[i]).toFixed(2)}`;
  if (n === 1) d += ` H 100`;
  const area = `${d} V 100 H 0 Z`;
  const lastY = Y(ps[n - 1]);
  const animate = drawn.from < 1;
  return (
    <div className={`hd-spark-box ${className}`} style={style} aria-hidden="true">
      <div
        className={`hd-spark-win ${animate ? (drawn.flip ? "hd-spark-draw-a" : "hd-spark-draw-b") : ""}`}
        style={{ ["--from" as string]: String(drawn.from) } as CSSProperties}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="hd-spark">
          <path d={area} fill={fill} stroke="none" />
          <path d={d} fill="none" stroke={stroke} strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      </div>
      {dot && (
        <svg viewBox="0 0 10 10" className="hd-spark-dot" style={{ top: `${lastY}%` }}>
          <circle cx="5" cy="5" r="3.2" fill={stroke} className="hd-ping" />
          <circle cx="5" cy="5" r="3.2" fill={stroke} stroke="#fff" strokeWidth="1.4" />
        </svg>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ money flow */

interface Coin {
  id: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  d: number;
}

/**
 * money-flow: gold coins arc from one element to another (buy-in: you to the pot; payout: the pot to
 * you). Decorative CSS (`hd-coin`), hidden under reduced motion; numbers roll on their own.
 * Returns [layer to render, fire(from, to, n)].
 */
export function useCoins(): [ReactNode, (from: Element | null, to: Element | null, n?: number) => void] {
  const [coins, setCoins] = useState<Coin[]>([]);
  const seq = useRef(0);
  const fire = useCallback((from: Element | null, to: Element | null, n = 6) => {
    if (!from || !to) return;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    const bx = b.left + b.width / 2;
    const by = b.top + b.height / 2;
    const batch = Array.from({ length: n }, (_, i) => ({
      id: ++seq.current,
      x: ax + (i - n / 2) * 7,
      y: ay + (i % 2 ? 4 : -4),
      dx: bx - ax - (i - n / 2) * 7,
      dy: by - ay,
      d: i * 80,
    }));
    setCoins((c) => [...c, ...batch]);
    const ids = new Set(batch.map((c) => c.id));
    setTimeout(() => setCoins((c) => c.filter((x) => !ids.has(x.id))), 950 + n * 80 + 200);
  }, []);
  const layer =
    coins.length && typeof document !== "undefined"
      ? createPortal(
          <div className="hd-coin-layer" aria-hidden="true">
            {coins.map((c) => (
              <span
                key={c.id}
                className="hd-coin"
                style={{ left: c.x - 8, top: c.y - 8, fontSize: 17, ["--dx" as string]: `${c.dx}px`, ["--dy" as string]: `${c.dy}px`, ["--d" as string]: `${c.d}ms` } as CSSProperties}
              />
            ))}
          </div>,
          document.body,
        )
      : null;
  return [layer, fire];
}
