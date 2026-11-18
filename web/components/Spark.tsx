/**
 * Price line of YES (cents, 0-100): a quiet 50¢ guide, the line, and a dot at the latest price.
 * The SVG stretches to its box (non-scaling strokes); the dot and the label are HTML so they never squash.
 */
export function Spark({ points, height = 80, color = "var(--green-line)", label = true }: {
  points: number[];
  height?: number;
  color?: string;
  /** Show the 50¢ guide label on the right. */
  label?: boolean;
}) {
  const W = 1000;
  const pts = points.length > 1 ? points : [points[0] ?? 50, points[0] ?? 50];
  const px = (i: number) => (i / (pts.length - 1)) * W;
  const py = (v: number) => 100 - Math.min(100, Math.max(0, v));
  const d = pts.map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(2)}`).join("");
  const last = pts[pts.length - 1];
  return (
    <div className="spark" style={{ height }} role="img" aria-label={`YES price history, now ${last} cents`}>
      <div className="spark-plot">
        <svg width="100%" height="100%" viewBox={`0 0 ${W} 100`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" x2={W} y1="50" y2="50" stroke="var(--line-strong)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="spark-dot" style={{ left: "100%", top: `${py(last)}%`, background: color }} aria-hidden="true" />
      </div>
      {label && (
        <span className="spark-label" aria-hidden="true">
          50¢
        </span>
      )}
    </div>
  );
}
