"use client";
import QRCode from "qrcode";
import { useMemo } from "react";

/** QR code as crisp SVG squares (white background with a quiet zone, so phones scan it off a dark screen). */
export function Qr({ text, size = 220, className }: { text: string; size?: number; className?: string }) {
  const { n, path } = useMemo(() => {
    const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
    const n = qr.modules.size;
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) d += `M${c + 2},${r + 2}h1v1h-1z`;
    return { n, path: d };
  }, [text]);
  return (
    <svg className={className} width={size} height={size} viewBox={`0 0 ${n + 4} ${n + 4}`} shapeRendering="crispEdges" role="img" aria-label={`QR code for ${text}`}>
      <rect width={n + 4} height={n + 4} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
