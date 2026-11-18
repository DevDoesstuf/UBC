/** Price line of YES (in cents, 0-100) with a dashed 50 line. Same idea as the kiosk's small chart. */
export function Spark({ points, width = 240, height = 80, color = "var(--yes)" }: { points: number[]; width?: number; height?: number; color?: string }) {
  const pts = points.length > 1 ? points : [points[0] ?? 50, points[0] ?? 50];
  const x = (i: number) => (i / (pts.length - 1)) * (width - 8) + 4;
  const y = (v: number) => height - 4 - (v / 100) * (height - 8);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block", height }} aria-label={`YES price history, now ${last} cents`}>
      <line x1="0" x2={width} y1={y(50)} y2={y(50)} stroke="var(--line)" strokeDasharray="4 4" />
      <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(pts.length - 1)} cy={y(last)} r="4" fill={color} />
    </svg>
  );
}
