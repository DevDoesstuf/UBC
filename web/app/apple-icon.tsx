import { ImageResponse } from "next/og";

// Home-screen icon: the LED-ring mark (three lit pixels on the green gradient) on ivory.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const RING = 12;
// The three lit pixels at the top of the ring (11, 0, 1), left to right along the gradient.
const LIT: Record<number, string> = { 11: "#0B7A3E", 0: "#12A150", 1: "#7CCB4E" };

export default function AppleIcon() {
  const dots = Array.from({ length: RING }, (_, i) => {
    const a = (i / RING) * Math.PI * 2 - Math.PI / 2;
    const lit = LIT[i];
    const r = lit ? (i === 0 ? 11 : 10) : 7.5;
    return { x: 90 + 66 * Math.cos(a), y: 90 + 66 * Math.sin(a), r, fill: lit ?? "#CBC4B2" };
  });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#F6F3EA" }}>
        {dots.map((d, i) => (
          <div
            key={i}
            style={{ position: "absolute", left: d.x - d.r, top: d.y - d.r, width: d.r * 2, height: d.r * 2, borderRadius: 999, background: d.fill }}
          />
        ))}
      </div>
    ),
    size,
  );
}
