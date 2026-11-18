import type { CSSProperties } from "react";

/** Lit pixels walk the brand gradient: deep green, green, lime, then gold. */
export const MARK_LIT = [
  "#0B7A3E", "#0E8A45", "#12A150", "#2DAE4F", "#4BBA4F", "#68C54E",
  "#7CCB4E", "#98C948", "#B4C243", "#CDB540", "#DEA93E", "#E8A33D",
];

/**
 * The Huddle mark: the box's LED ring seen from above, twelve pixels with one lit. `lit` lights
 * more pixels (the lobby fills it as people join); `spin` walks the lit pixels round (loading).
 * Unlit pixels use `currentColor` at 32%, so set `color` for the ring.
 */
export function Mark({
  size = "1em",
  lit = 1,
  spin = false,
  className = "",
  style,
}: {
  size?: string | number;
  lit?: number;
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const n = 12;
  const count = Math.max(0, Math.min(n, lit));
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} className={className} style={style} aria-hidden="true" focusable="false">
      <g className={spin ? "hd-spin" : undefined}>
        {Array.from({ length: n }, (_, i) => {
          const a = (i / n) * Math.PI * 2 - Math.PI / 2;
          const on = i < count;
          return (
            <circle
              key={i}
              cx={20 + 15 * Math.cos(a)}
              cy={20 + 15 * Math.sin(a)}
              r={on ? 3.7 : 2.6}
              fill={on ? MARK_LIT[count === 1 ? 2 : i] : "currentColor"}
              opacity={on ? 1 : 0.32}
            />
          );
        })}
      </g>
    </svg>
  );
}

/** Mark + lowercase "huddle" in the display face. Size it with font-size. */
export function Wordmark({ className = "", lit = 1, spin = false }: { className?: string; lit?: number; spin?: boolean }) {
  return (
    <span className={`hd-wordmark ${className}`} translate="no">
      <Mark size="1.05em" lit={lit} spin={spin} />
      <span>huddle</span>
    </span>
  );
}
