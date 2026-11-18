"use client";
import type { SVGProps } from "react";

/**
 * One icon set for both apps: 24px grid, 2px round strokes, no fills except the solid triangles
 * used as direction marks. Decorative by default (aria-hidden); pass `title` for a meaningful icon.
 */
const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  arrowUp: "M12 19V5M5.5 11.5L12 5l6.5 6.5",
  arrowDown: "M12 5v14M5.5 12.5L12 19l6.5-6.5",
  arrowRight: "M5 12h14M12.5 5.5L19 12l-6.5 6.5",
  arrowLeft: "M19 12H5M11.5 5.5L5 12l6.5 6.5",
  chevronDown: "M6 9.5l6 6 6-6",
  chevronUp: "M6 14.5l6-6 6 6",
  lock: "M7.5 11V8a4.5 4.5 0 019 0v3M5.5 11h13v9.5h-13zM12 15v2",
  unlock: "M7.5 11V8a4.5 4.5 0 018.6-1.9M5.5 11h13v9.5h-13zM12 15v2",
  flag: "M5.5 21V4M5.5 4.5h11.5l-2.2 4 2.2 4H5.5",
  mic: "M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5.5 11a6.5 6.5 0 0013 0M12 17.5V21",
  speaker: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11",
  mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  trophy: "M8 4h8v5a4 4 0 01-8 0V4zM8 6H4.5a3 3 0 003.5 4M16 6h3.5A3 3 0 0116 10M12 13v4M8.5 20h7M10 17h4v3h-4z",
  crown: "M3.5 8.5l4.5 4 4-6.5 4 6.5 4.5-4-1.8 10.5H5.3z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  refresh: "M19.5 12a7.5 7.5 0 11-2.2-5.3M19.5 4.5v4h-4",
  list: "M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01",
  chart: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  ticket: "M4 7.5V5h16v2.5a2.5 2.5 0 000 5V15H4v-2.5a2.5 2.5 0 000-5zM4 15v4h16v-4",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  hourglass:
    "M7 3h10M7 21h10M8 3v3.5a4 4 0 002 3.4L12 12l2-1.1a4 4 0 002-3.4V3M8 21v-3.5a4 4 0 012-3.4L12 12l2 2.1a4 4 0 012 3.4V21",
  wifi: "M2.5 9a14 14 0 0119 0M5.5 12.5a9.5 9.5 0 0113 0M8.5 16a5 5 0 017 0M12 19.5h.01",
  wifiOff: "M3 3l18 18M8.5 16a5 5 0 017 0M5.5 12.5a9.5 9.5 0 015-2.6M2.5 9a14 14 0 014.4-2.8M13.5 6.1A14 14 0 0121.5 9M12 19.5h.01",
  nfc: "M8.5 8.5a5 5 0 010 7M12 5.5a9 9 0 010 13M15.5 2.5a13 13 0 010 19M5 12h.01",
  play: "M7.5 5v14l11-7z",
  pause: "M7.5 5v14M16.5 5v14",
  settings:
    "M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5",
  next: "M5 5.5l7 6.5-7 6.5M13 5.5l7 6.5-7 6.5",
  warn: "M12 3.5l9.5 16.5h-19zM12 10v4.5M12 17.5h.01",
  link: "M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1",
  coin: "M12 3a9 9 0 100 18 9 9 0 000-18zM14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2.1 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.3 0-2.4-.6-2.9-1.5M12 6v1.8M12 16.2V18",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4.5 20.5a7.5 7.5 0 0115 0",
  users: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18.5 14a6.5 6.5 0 013 6",
  handshake: "M3 11l4-4 3 1 3-2 3 1 5 4M3 11l5 5c1 1 2.2 1 3 .2M21 11l-5 5c-.8.8-2 .8-2.8 0L10 13",
  qr: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z",
  wallet: "M4 7.5A2.5 2.5 0 016.5 5H18v3M4 7.5V17a2 2 0 002 2h14V9H6.5A2.5 2.5 0 014 7.5zM16.5 14h.01",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5V12l3 2",
} as const;

/** Solid direction marks (paired with the YES/NO colours, so the shape carries the meaning). */
const SOLID = {
  up: "M12 5l7.5 10h-15z",
  down: "M12 19L4.5 9h15z",
} as const;

export type IconName = keyof typeof PATHS | keyof typeof SOLID;

export function Icon({
  name,
  size,
  title,
  className,
  strokeWidth = 2,
  ...rest
}: { name: IconName; size?: number | string; title?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
  const solid = name in SOLID;
  const d = solid ? SOLID[name as keyof typeof SOLID] : PATHS[name as keyof typeof PATHS];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size ?? "1em"}
      height={size ?? "1em"}
      className={className}
      fill={solid ? "currentColor" : "none"}
      stroke={solid ? "none" : "currentColor"}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
