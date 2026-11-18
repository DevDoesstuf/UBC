"use client";
// Motion helpers for the TV page (same names as the shared Huddle kit, so the merge can unify them).
// Rule: the resting style is the final state; animation only describes the journey there. Anything that
// starts invisible is a CSS animation (time based, finishes in a background tab), never JS-driven.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

const RM = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(RM).matches;
}

/** Live `prefers-reduced-motion` value (false on the server and on first paint). */
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

/**
 * Restartable one-shot CSS animation: a class that alternates `${base}-a` / `${base}-b` each time `trigger`
 * changes (same keyframes, new name, so the browser replays it without a remount). '' until the first change,
 * so nothing animates on first paint.
 */
export function useReplayClass(trigger: unknown, base: string): string {
  const [s, setS] = useState<{ last: unknown; n: number }>({ last: trigger, n: 0 });
  if (s.last !== trigger) setS({ last: trigger, n: s.n + 1 });
  return s.n === 0 ? "" : `${base}-${s.n % 2 ? "a" : "b"}`;
}

/** Direction of the last change of a number: 'up' | 'down' | null, cleared after `holdMs`. */
export function useDirection(value: number | null | undefined, holdMs = 1100): "up" | "down" | null {
  const [s, setS] = useState<{ prev: number | null | undefined; dir: "up" | "down" | null; n: number }>({ prev: value, dir: null, n: 0 });
  if (value !== s.prev) {
    const dir =
      typeof value === "number" && typeof s.prev === "number" && Number.isFinite(value) && Number.isFinite(s.prev)
        ? value > s.prev ? "up" : value < s.prev ? "down" : null
        : null;
    setS({ prev: value, dir, n: s.n + 1 });
  }
  useEffect(() => {
    if (!s.dir) return;
    const t = setTimeout(() => setS((x) => ({ ...x, dir: null })), holdMs);
    return () => clearTimeout(t);
  }, [s.n, s.dir, holdMs]);
  return s.dir;
}

/** Ids that were not there on the first render (so only real arrivals animate). */
export function useFresh(ids: string[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(ids);
  return new Set(ids.filter((id) => !seen.current!.has(id)));
}

/**
 * FLIP reorder for a list whose children carry `data-flip="<key>"`: when the order changes, each child slides
 * from where it was to where it is now on a spring (Web Animations: time based, transform only, the resting
 * style is the final position). Instant under reduced motion.
 */
export function useFlip<T extends HTMLElement>(order: string) {
  const ref = useRef<T>(null);
  const last = useRef<{ order: string; pos: Map<string, DOMRect> }>({ order: "", pos: new Map() });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = new Map<string, DOMRect>();
    const changed = last.current.order !== "" && last.current.order !== order;
    const reduce = prefersReducedMotion();
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const k = child.dataset.flip;
      if (!k) continue;
      const r = child.getBoundingClientRect();
      next.set(k, r);
      const prev = last.current.pos.get(k);
      if (!changed || reduce || !prev || typeof child.animate !== "function") continue;
      const dx = prev.left - r.left;
      const dy = prev.top - r.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      child.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], {
        duration: 560,
        easing: "cubic-bezier(0.34, 1.3, 0.64, 1)",
      });
    }
    last.current = { order, pos: next };
  });
  return ref;
}

/** `--d` (animation delay) as a style object. */
export const delay = (ms: number) => ({ ["--d" as string]: `${ms}ms` }) as CSSProperties;

/** Merge CSS custom properties into a style object. */
export const vars = (v: Record<string, string | number>) => v as unknown as CSSProperties;
