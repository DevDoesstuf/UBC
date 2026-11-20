import type { CSSProperties, ReactNode } from "react";

/**
 * The Huddle mark: three people in a ring, 120 degrees apart, turning round the centre. Each person is a
 * head and a swoosh body that wraps under the head, runs along the rim and tapers into the next person.
 * Drawn in a 40 x 40 box centred on (20, 20) (the rotation centre); MARK_BODIES is the three bodies, one
 * subpath each, MARK_HEADS the three heads [cx, cy, r]. Source of truth for the icons (app/icon.svg,
 * app/apple-icon.tsx), the box preview (components/KioskView.tsx) and the firmware (ui.cpp markLogo).
 */
export const MARK_BODIES =
  "M35.32 25.27A16.2 16.2 0 0 1 25.62 35.19A5.63 5.63 0 1 0 14.38 35.19A16.2 16.2 0 0 1 10.87 33.38A9.98 9.98 0 0 1 10.53 21.59A9.6 9.6 0 0 0 15.94 28.7A7.5 7.5 0 0 1 24.06 28.7A9.6 9.6 0 0 0 24.23 28.62A11.48 11.48 0 0 0 35.32 25.27Z" +
  "M7.77 30.63A16.2 16.2 0 0 1 4.03 17.27A5.63 5.63 0 1 0 9.65 7.53A16.2 16.2 0 0 1 12.98 5.4A9.98 9.98 0 0 1 23.35 11A9.6 9.6 0 0 0 14.5 12.13A7.5 7.5 0 0 1 10.44 19.17A9.6 9.6 0 0 0 10.42 19.36A11.48 11.48 0 0 0 7.77 30.63Z" +
  "M16.91 4.1A16.2 16.2 0 0 1 30.35 7.53A5.63 5.63 0 1 0 35.97 17.27A16.2 16.2 0 0 1 36.15 21.22A9.98 9.98 0 0 1 26.11 27.4A9.6 9.6 0 0 0 29.56 19.17A7.5 7.5 0 0 1 25.5 12.13A9.6 9.6 0 0 0 25.34 12.03A11.48 11.48 0 0 0 16.91 4.1Z";
export const MARK_HEADS: readonly (readonly [number, number, number])[] = [
  [20, 35, 4.5],
  [7.01, 12.5, 4.5],
  [32.99, 12.5, 4.5],
];
/** The brand green (the app's --k-green). */
export const MARK_GREEN = "#1FD67F";

/** Kept for older imports: the LED-ring gradient the previous mark used. */
export const MARK_LIT = [
  "#0B7A3E", "#0E8A45", "#12A150", "#2DAE4F", "#4BBA4F", "#68C54E",
  "#7CCB4E", "#98C948", "#B4C243", "#CDB540", "#DEA93E", "#E8A33D",
];

/** The mark as a standalone SVG string (icons, data URIs). */
export function markSvg({ size = 40, fill = MARK_GREEN, bg }: { size?: number; fill?: string; bg?: string } = {}): string {
  const heads = MARK_HEADS.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join("");
  const back = bg ? `<rect width="40" height="40" fill="${bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">${back}<g fill="${fill}"><path d="${MARK_BODIES}"/>${heads}</g></svg>`;
}

/**
 * The Huddle mark. Green by default (`--hd-mark`, else `--k-green`); pass `color` to override, e.g. on a
 * green button. `spin` turns it slowly round its centre (loading); with reduced motion it pulses instead.
 * `lit` is accepted for older callers (the previous LED-ring mark lit pixels as people joined) and ignored.
 */
export function Mark({
  size = "1em",
  spin = false,
  className = "",
  style,
  color,
}: {
  size?: string | number;
  lit?: number;
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 0 40 40"
      width={size}
      height={size}
      className={`hd-mark ${className}`}
      style={{ fill: color ?? "var(--hd-mark, var(--k-green, #1FD67F))", ...style }}
      aria-hidden="true"
      focusable="false"
    >
      <g className={spin ? "hd-mark-spin" : undefined}>
        <path d={MARK_BODIES} />
        {MARK_HEADS.map(([x, y, r]) => (
          <circle key={`${x},${y}`} cx={x} cy={y} r={r} />
        ))}
      </g>
    </svg>
  );
}

/** Mark + lowercase "huddle" in the display face. Size it with font-size. */
export function Wordmark({ className = "", spin = false }: { className?: string; lit?: number; spin?: boolean }) {
  return (
    <span className={`hd-wordmark ${className}`} translate="no">
      <Mark size="1.15em" spin={spin} />
      <span>huddle</span>
    </span>
  );
}

/**
 * Every loading / connecting / waking state: the mark turning, "huddle" under it in the wordmark face, and an
 * optional status line (and a quieter detail line) under that. Centred in whatever holds it.
 * size: "sm" inline panels, "md" phone screens (default), "lg" the TV.
 */
export function BrandLoader({
  label,
  detail,
  spin = true,
  size = "md",
  className = "",
  children,
}: {
  label?: ReactNode;
  detail?: ReactNode;
  spin?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`hd-loader hd-loader-${size} ${className}`} role="status" aria-live="polite">
      <Mark size="1em" spin={spin} className="hd-loader-mark" />
      <span className="hd-loader-word" translate="no">
        huddle
      </span>
      {label ? <span className="hd-loader-label">{label}</span> : <span className="hd-sr">Loading</span>}
      {detail && <span className="hd-loader-detail">{detail}</span>}
      {children}
    </div>
  );
}
