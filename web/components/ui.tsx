"use client";
// Small shared UI pieces: the Huddle mark, icons, rolling digits, count-up and "only new rows animate".
// Motion rules: the resting style is always the final state; animations are CSS (they finish in background
// tabs) and only describe the journey; nothing ever waits on an exit animation.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// ---------------------------------------------------------------- brand

/** The Huddle mark: three people leaning in, seen from above. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="mark">
      <rect width="24" height="24" rx="7" fill="var(--green)" />
      <circle cx="12" cy="8.2" r="2.7" fill="#fff" />
      <circle cx="7.6" cy="15.2" r="2.7" fill="#fff" />
      <circle cx="16.4" cy="15.2" r="2.7" fill="#fff" />
    </svg>
  );
}

export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="wordmark" translate="no">
      <Mark size={size} />
      <span>Huddle</span>
    </span>
  );
}

// ---------------------------------------------------------------- icons (1.75 stroke, 24 grid)

type IconName = "up" | "down" | "lock" | "check" | "x" | "sound" | "mute" | "plus" | "arrow-right" | "trophy" | "clock";

const PATHS: Record<IconName, ReactNode> = {
  up: <path d="M12 6l6 9H6z" fill="currentColor" stroke="none" />,
  down: <path d="M12 18l6-9H6z" fill="currentColor" stroke="none" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  sound: (
    <>
      <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
    </>
  ),
  mute: (
    <>
      <path d="M4 10v4h3.5L12 18V6L7.5 10z" />
      <path d="M16 10l4 4M20 10l-4 4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  "arrow-right": <path d="M5 12h14M13 6l6 6-6 6" />,
  trophy: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0z" />
      <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 2" />
    </>
  ),
};

export function Icon({ name, size = 16, className = "", label }: { name: IconName; size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon ${className}`}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {PATHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------- motion helpers

const RM = "(prefers-reduced-motion: reduce)";
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(RM);
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}

/** Direction of the last change of a number ('up' | 'down' | null), cleared after `holdMs`. */
export function useDirection(value: number | null | undefined, holdMs = 1200): "up" | "down" | null {
  const [s, setS] = useState<{ prev: number | null | undefined; dir: "up" | "down" | null; n: number }>({ prev: value, dir: null, n: 0 });
  if (value !== s.prev) {
    const dir = typeof value === "number" && typeof s.prev === "number" ? (value > s.prev ? "up" : value < s.prev ? "down" : null) : null;
    setS({ prev: value, dir, n: s.n + 1 });
  }
  useEffect(() => {
    if (!s.dir) return;
    const t = setTimeout(() => setS((x) => ({ ...x, dir: null })), holdMs);
    return () => clearTimeout(t);
  }, [s.n, s.dir, holdMs]);
  return s.dir;
}

/** A class that alternates a/b each time `trigger` changes, so the same keyframes replay without remounting. */
function useReplayClass(trigger: unknown, base: string): string {
  const [s, setS] = useState<{ last: unknown; n: number }>({ last: trigger, n: 0 });
  if (s.last !== trigger) setS({ last: trigger, n: s.n + 1 });
  return s.n === 0 ? "" : `${base}-${s.n % 2 ? "a" : "b"}`;
}

// ---------------------------------------------------------------- rolling digits

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function Digit({ d, i }: { d: number; i: number }) {
  return (
    <span className="digit" style={{ "--i": i } as CSSProperties}>
      <span className="digit-sizer">0</span>
      <span className="digit-strip" style={{ transform: `translate3d(0, ${-d * 10}%, 0)` }}>
        {DIGITS.map((n) => (
          <span key={n}>{n}</span>
        ))}
      </span>
    </span>
  );
}

/**
 * A number whose digits roll to their new value and briefly tint the direction it moved (with a ▲/▼ glyph,
 * never colour alone). `text` is pre-formatted ("72¢", "$12.50"); only digits roll. Screen readers get
 * `label` (or `text`) once.
 */
export function Roll({ text, value, label, className = "", arrow = false, tint = true }: {
  text: string;
  value?: number | null;
  label?: string;
  className?: string;
  arrow?: boolean;
  tint?: boolean;
}) {
  const parsed = Number.parseFloat(text.replace(/[^0-9.-]/g, ""));
  const numeric = value !== undefined ? value : Number.isFinite(parsed) ? parsed : null;
  const dir = useDirection(numeric);
  const flash = useReplayClass(numeric, `flash-${dir ?? "up"}`);
  const chars = [...text];
  let di = 0;
  return (
    <span className={`roll ${tint && dir ? flash : ""} ${className}`}>
      <span className="sr-only">{label ?? text}</span>
      <span aria-hidden="true" className="roll-chars">
        {chars.map((c, i) => {
          const key = chars.length - i; // keyed from the right: the ones digit stays the ones digit
          if (c >= "0" && c <= "9") return <Digit key={`d${key}`} d={Number(c)} i={di++} />;
          return <span key={`c${key}`}>{c}</span>;
        })}
      </span>
      {arrow && dir && (
        <span className={`dir dir-${dir}`} aria-hidden="true">
          <Icon name={dir} size={14} />
        </span>
      )}
    </span>
  );
}

/** Counts a money amount up from 0 once when it first appears (instant under reduced motion). */
export function CountUp({ cents, format, ms = 900 }: { cents: number; format: (c: number) => string; ms?: number }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(cents);
  const from = useRef(0); // counts from the last value it settled on (0 the first time)
  // Layout effect: the start value is set before the first paint, so the final value never flashes first.
  useLayoutEffect(() => {
    const start = from.current;
    if (reduce || start === cents) {
      from.current = cents;
      setShown(cents);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const settle = () => {
      from.current = cents;
      setShown(cents);
    };
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      if (k >= 1) return settle();
      setShown(Math.round(start + (cents - start) * (1 - Math.pow(1 - k, 3))));
      raf = requestAnimationFrame(step);
    };
    setShown(start);
    raf = requestAnimationFrame(step);
    // rAF pauses in background tabs: the final value lands regardless.
    const done = setTimeout(settle, ms + 150);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [cents, ms, reduce]);
  return (
    <span className="tnum">
      <span className="sr-only">{format(cents)}</span>
      <span aria-hidden="true">{format(shown)}</span>
    </span>
  );
}

/** Ids that appeared after the first render (so only newcomers get an entrance, not the whole list on load). */
export function useNewIds(ids: string[]): Set<string> {
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const key = ids.join("|");
  useEffect(() => {
    const list = key ? key.split("|") : [];
    if (!known.current) {
      known.current = new Set(list);
      return;
    }
    const added = list.filter((id) => !known.current!.has(id));
    added.forEach((id) => known.current!.add(id));
    if (added.length) setFresh(new Set(added));
  }, [key]);
  return fresh;
}

/** Initials avatar on a quiet grey square (never the YES/NO colours). */
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {initials || "?"}
    </span>
  );
}
