"use client";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Motion tokens (mirrored as CSS variables in huddle.css). Durations in ms.
 * Rule: the resting style is the final state; animation only describes the journey there. Anything
 * that starts invisible is a CSS animation (time-based, finishes even in a background tab), never a
 * JS-driven fade-in.
 */
export const DUR = { instant: 90, quick: 160, base: 240, slow: 420, linger: 700, reveal: 1200 } as const;

export const EASE = {
  /** Entrances, numbers settling. */
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** Exits. */
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  /** The lock: hard in, hard stop. */
  snap: "cubic-bezier(0.85, 0, 0.15, 1)",
  /** Small overshoot for stamps (win amount, score change). */
  swing: "cubic-bezier(0.34, 1.4, 0.64, 1)",
} as const;

const query = "(prefers-reduced-motion: reduce)";

/** True when the user asked for reduced motion. Safe on the server (false). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Live `prefers-reduced-motion` value. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/**
 * Restartable one-shot CSS animation: returns a class that alternates between `${base}-a` and
 * `${base}-b` each time `trigger` changes (same keyframes, new name, so the browser replays it
 * without remounting). Returns '' until the first change, so nothing animates on first paint.
 */
export function useReplayClass(trigger: unknown, base: string): string {
  const [state, setState] = useState<{ last: unknown; n: number }>({ last: trigger, n: 0 });
  if (state.last !== trigger) setState({ last: trigger, n: state.n + 1 });
  return state.n === 0 ? "" : `${base}-${state.n % 2 ? "a" : "b"}`;
}

/** Direction of the last change of a number: 'up' | 'down' | null, cleared after `holdMs`. */
export function useDirection(value: number | null | undefined, holdMs = 1100): "up" | "down" | null {
  const [state, setState] = useState<{ prev: number | null | undefined; dir: "up" | "down" | null; n: number }>({
    prev: value,
    dir: null,
    n: 0,
  });
  if (value !== state.prev) {
    const dir =
      typeof value === "number" && typeof state.prev === "number" && Number.isFinite(value) && Number.isFinite(state.prev)
        ? value > state.prev
          ? "up"
          : value < state.prev
            ? "down"
            : null
        : null;
    setState({ prev: value, dir, n: state.n + 1 });
  }
  useEffect(() => {
    if (!state.dir) return;
    const t = setTimeout(() => setState((s) => ({ ...s, dir: null })), holdMs);
    return () => clearTimeout(t);
  }, [state.n, state.dir, holdMs]);
  return state.dir;
}

/** Ids that appeared since the first render (for "someone joined" pops). Stable across re-renders. */
export function useNewIds(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const fresh = useRef<Set<string>>(new Set());
  if (seen.current === null) seen.current = new Set(ids);
  for (const id of ids) {
    if (!seen.current.has(id)) {
      seen.current.add(id);
      fresh.current.add(id);
    }
  }
  return fresh.current;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * board-reorder without a motion library (FLIP): give every row `data-flip="<id>"` inside the
 * returned ref. When the order changes, rows glide from where they were to where they are on the
 * spring (transform only), vertically for a list and sideways for a row of chips. Layout offsets
 * (not bounding boxes) are compared, so a glide still running never skews the next one. Instant
 * under reduced motion. `key` should change when the order does.
 */
export function useFlip<T extends HTMLElement>(key: string) {
  const ref = useRef<T>(null);
  const last = useRef<Map<string, { x: number; y: number }>>(new Map());
  useIsoLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-flip]"));
    const next = new Map<string, { x: number; y: number }>();
    const reduce = prefersReducedMotion();
    for (const el of rows) {
      const id = el.dataset.flip!;
      const at = { x: el.offsetLeft, y: el.offsetTop };
      next.set(id, at);
      const before = last.current.get(id);
      if (!before || reduce || typeof el.animate !== "function") continue;
      const dx = before.x - at.x;
      const dy = before.y - at.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: 560,
        easing: "cubic-bezier(0.34, 1.3, 0.64, 1)",
      });
    }
    last.current = next;
  }, [key]);
  return ref;
}

/** `--d` (the kit's animation delay) as a style object: `style={delay(240)}`. */
export const delay = (ms: number) => ({ ["--d" as string]: `${ms}ms` }) as CSSProperties;

/** CSS custom properties as a style object: `style={vars({ "--from": 0.4 })}`. */
export const vars = (v: Record<string, string | number>) => v as unknown as CSSProperties;
