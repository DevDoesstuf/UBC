import type { SVGProps } from "react";

/** One icon set: 24px grid, round strokes, solid triangles for direction. Decorative unless `title` is set. */
const PATHS = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  arrowRight: "M5 12h14M12.5 5.5L19 12l-6.5 6.5",
  lock: "M7.5 11V8a4.5 4.5 0 019 0v3M5.5 11h13v9.5h-13zM12 15v2",
  speaker: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11",
  mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
  trophy: "M8 4h8v5a4 4 0 01-8 0V4zM8 6H4.5a3 3 0 003.5 4M16 6h3.5A3 3 0 0116 10M12 13v4M8.5 20h7M10 17h4v3h-4z",
  crown: "M3.5 8.5l4.5 4 4-6.5 4 6.5 4.5-4-1.8 10.5H5.3z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6z",
  hourglass: "M7 3h10M7 21h10M8 3v3.5a4 4 0 002 3.4L12 12l2-1.1a4 4 0 002-3.4V3M8 21v-3.5a4 4 0 012-3.4L12 12l2 2.1a4 4 0 012 3.4V21",
  nfc: "M8.5 8.5a5 5 0 010 7M12 5.5a9 9 0 010 13M15.5 2.5a13 13 0 010 19M5 12h.01",
  play: "M7.5 5v14l11-7z",
  coin: "M12 3a9 9 0 100 18 9 9 0 000-18zM14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2s1.2 1.7 2.8 2.1 2.8.9 2.8 2.1-1.2 2-2.8 2c-1.3 0-2.4-.6-2.9-1.5M12 6v1.8M12 16.2V18",
  users: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20a6.5 6.5 0 0113 0M16 4.3a3.5 3.5 0 010 6.4M18.5 14a6.5 6.5 0 013 6",
  wifiOff: "M3 3l18 18M8.5 16a5 5 0 017 0M5.5 12.5a9.5 9.5 0 015-2.6M2.5 9a14 14 0 014.4-2.8M13.5 6.1A14 14 0 0121.5 9M12 19.5h.01",
  handshake: "M3 11l4-4 3 1 3-2 3 1 5 4M3 11l5 5c1 1 2.2 1 3 .2M21 11l-5 5c-.8.8-2 .8-2.8 0L10 13",
} as const;

const SOLID = {
  up: "M12 5l7.5 10h-15z",
  down: "M12 19L4.5 9h15z",
} as const;

export type IconName = keyof typeof PATHS | keyof typeof SOLID;

export function Icon({
  name,
  size,
  title,
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
