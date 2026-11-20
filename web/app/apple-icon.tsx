import { ImageResponse } from "next/og";
import { MARK_BODIES, MARK_GREEN, MARK_HEADS } from "@/components/huddle/Mark";

// Home-screen icon: the three-people mark in the brand green on near-black (iOS rounds the corners itself).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0A0A0A" }}>
        {/* The mark's box is centred on its rotation centre; nudge it up so the drawing itself sits in the middle. */}
        <svg width="136" height="136" viewBox="0 0 40 40" style={{ marginTop: -11 }}>
          <path d={MARK_BODIES} fill={MARK_GREEN} />
          {MARK_HEADS.map(([x, y, r]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r={r} fill={MARK_GREEN} />
          ))}
        </svg>
      </div>
    ),
    size,
  );
}
