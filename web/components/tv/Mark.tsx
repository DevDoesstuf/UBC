import type { CSSProperties } from "react";

/** Lit pixels walk the brand gradient: deep green, green, lime, then gold. */
const LIT = ["#0B7A3E", "#0D8542", "#109347", "#12A150", "#2EAE4F", "#4DBA4F", "#68C44E", "#7CCB4E", "#9CC947", "#BDBE42", "#D6AF3F", "#E8A33D"];

/**
 * The Huddle mark: the box's LED ring seen from above, twelve pixels with one lit. `lit` lights more pixels
 * (the lobby fills it as people join); `spin` walks the lit pixels round (connecting).
 */
export function Mark({ size = "1em", lit = 1, spin = false, className = "", style }: {
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
              className="hd-mark-dot"
              cx={20 + 15 * Math.cos(a)}
              cy={20 + 15 * Math.sin(a)}
              r={on ? 3.7 : 2.6}
              fill={on ? LIT[count === 1 ? 0 : i] : "currentColor"}
              opacity={on ? 1 : 0.3}
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
