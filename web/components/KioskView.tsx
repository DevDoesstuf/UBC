"use client";
// Draws a kiosk screen JSON at 800 x 480 with the SAME geometry as the ESP32 firmware
// (firmware/kiosk_screen/ui.cpp). If you move something here, move it there too.
import type { KioskScreen } from "./client";
import { fmtClock } from "./client";

const HEADER: Record<string, string> = { blue: "#123a63", amber: "#5a3d08", red: "#5a1f1a", green: "#0e4a37", gray: "#2a3140" };
const BTN: Record<string, string> = { primary: "#378add", yes: "#1d9e75", no: "#d85a30", plain: "#273042" };

export const BUTTON_Y = 400;
export const BUTTON_H = 64;

export function buttonRects(n: number) {
  const gap = 16;
  const w = n ? (768 - (n - 1) * gap) / n : 0;
  return Array.from({ length: n }, (_, i) => ({ x: 16 + i * (w + gap), y: BUTTON_Y, w, h: BUTTON_H }));
}

function PricePanel({ x, label, value, up, yes }: { x: number; label: string; value: number; up: boolean; yes: boolean }) {
  return (
    <div className="abs" style={{ left: x, top: 180, width: 250, height: 200, borderRadius: 16, background: yes ? "#0e4a37" : "#5a2414", border: `2px solid ${yes ? "#1d9e75" : "#d85a30"}` }}>
      <div className="abs" style={{ left: 20, top: 12, fontSize: 24, fontWeight: 700 }}>{label}</div>
      {up && <div className="abs" style={{ right: 18, top: 14, width: 0, height: 0, borderLeft: "14px solid transparent", borderRight: "14px solid transparent", borderBottom: "22px solid #7fe0bd" }} />}
      <div className="abs" style={{ left: 0, right: 0, top: 54, textAlign: "center", fontSize: 92, fontWeight: 800, lineHeight: "100px", fontVariantNumeric: "tabular-nums" }}>
        {value}<span style={{ fontSize: 40 }}>¢</span>
      </div>
    </div>
  );
}

function Chart({ points }: { points: number[] }) {
  const w = 220, h = 110;
  const pts = points.length > 1 ? points : [points[0] ?? 50, points[0] ?? 50];
  const x = (i: number) => 6 + (i / (pts.length - 1)) * (w - 12);
  const y = (v: number) => h - 6 - (v / 100) * (h - 12);
  return (
    <svg className="abs" style={{ left: 556, top: 180 }} width={w} height={h}>
      <rect width={w} height={h} rx="10" fill="#151b26" stroke="#273042" />
      <line x1="6" x2={w - 6} y1={y(50)} y2={y(50)} stroke="#273042" strokeDasharray="4 4" />
      <polyline points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="#1d9e75" strokeWidth="3" />
    </svg>
  );
}

export function KioskView({ s, pressed, error, stale, onTouch }: {
  s: KioskScreen;
  pressed?: string | null;
  error?: string | null;
  stale?: boolean;
  onTouch: (id: string) => void;
}) {
  const rects = buttonRects(s.buttons.length);
  return (
    <div className="kiosk">
      <div className="hdr" style={{ background: HEADER[s.color] ?? HEADER.gray }}>
        <div className="t">{s.title}</div>
        <div className="s">{s.subtitle}</div>
        <div className="f">{s.footer}</div>
      </div>

      {s.screen === "select" &&
        (s.tiles ?? []).slice(0, 4).map((t, i) => (
          <div
            key={t.id}
            className={`tile ${t.enabled ? "" : "off"} ${pressed === t.id ? "pressed" : ""}`}
            style={{ left: 16 + (i % 2) * 392, top: 100 + Math.floor(i / 2) * 192, width: 376, height: 176, background: t.enabled ? "#1f4f80" : undefined }}
            onClick={() => t.enabled && onTouch(t.id)}
          >
            <div className="l">{t.label}</div>
            <div className="sub">{t.sub}</div>
            {t.enabled && <div className="abs pill live" style={{ right: 16, bottom: 16, fontSize: 16 }}>LIVE</div>}
          </div>
        ))}

      {s.screen === "lobby" && (
        <>
          <div className="abs" style={{ left: 24, top: 100, width: 230, height: 230, background: "#fff", borderRadius: 8, display: "grid", placeItems: "center" }}>
            {s.qr && (
              <svg width={Math.floor(230 / (s.qr.size + 4)) * s.qr.size} height={Math.floor(230 / (s.qr.size + 4)) * s.qr.size} viewBox={`0 0 ${s.qr.size} ${s.qr.size}`} shapeRendering="crispEdges">
                {s.qr.rows.flatMap((row, r) => [...row].map((c, col) => (c === "1" ? <rect key={`${r}-${col}`} x={col} y={r} width="1" height="1" fill="#000" /> : null)))}
              </svg>
            )}
          </div>
          <div className="abs" style={{ left: 24, top: 336, width: 230, textAlign: "center", fontSize: 24, fontWeight: 700 }}>Code {s.code}</div>
          <div className="abs" style={{ left: 0, top: 368, width: 278, textAlign: "center", fontSize: 14, color: "#93a0b4" }}>{s.joinUrl}</div>
          <div className="abs" style={{ left: 280, top: 100, fontSize: 22, fontWeight: 700 }}>Players ({s.players?.length ?? 0})</div>
          {(s.players?.length ? s.players : ["Waiting for players..."]).slice(0, 7).map((p, i) => (
            <div key={i} className="abs" style={{ left: 280, top: 134 + i * 30, fontSize: 22, color: s.players?.length ? "#eef2f8" : "#93a0b4" }}>{p}</div>
          ))}
          {s.question && (
            <div className="abs" style={{ left: 280, top: 352, width: 496, fontSize: 18, color: "#93a0b4", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              First up: {s.question}
            </div>
          )}
        </>
      )}

      {(s.screen === "market" || s.screen === "locked") && (
        <>
          <div className="abs" style={{ left: 24, top: 98, width: 752, height: 72, fontSize: 30, fontWeight: 700, lineHeight: "34px", overflow: "hidden" }}>{s.question}</div>
          <PricePanel x={24} label="YES" value={s.yes ?? 50} up={s.move === 1} yes />
          <PricePanel x={290} label="NO" value={s.no ?? 50} up={s.move === -1} yes={false} />
          <Chart points={s.history ?? [50]} />
          <div className="abs" style={{ left: 556, top: 300, fontSize: 20 }}>{s.traded}</div>
          {s.screen === "market" ? (
            <>
              <div className="abs" style={{ left: 556, top: 334, fontSize: 16, color: "#93a0b4" }}>Locks in</div>
              <div className="abs" style={{ left: 556, top: 350, fontSize: 36, fontWeight: 800, color: (s.lockIn ?? 0) <= 10 ? "#f4a3a3" : "#eef2f8" }}>{fmtClock(s.lockIn ?? 0)}</div>
            </>
          ) : (
            <div className="abs" style={{ left: 556, top: 340, fontSize: 36, fontWeight: 800, color: "#e0675b" }}>CLOSED</div>
          )}
        </>
      )}

      {s.screen === "result" && (
        <>
          <div className="abs" style={{ left: 24, top: 100, width: 320, height: 284, borderRadius: 16, background: s.result === "YES" ? "#1d9e75" : "#d85a30", display: "grid", placeItems: "center", fontSize: 92, fontWeight: 900 }}>
            {s.result}
          </div>
          <div className="abs" style={{ left: 368, top: 104, width: 408, fontSize: 20, color: "#93a0b4", lineHeight: "26px", maxHeight: 52, overflow: "hidden" }}>{s.question}</div>
          {(s.lines ?? []).slice(0, 6).map((line, i) => (
            <div key={i} className="abs" style={{ left: 368, top: 170 + i * 34, fontSize: 26, fontWeight: 700 }}>{line}</div>
          ))}
        </>
      )}

      {s.screen === "ended" && (
        <>
          <div className="abs" style={{ left: 0, width: 800, top: 100, textAlign: "center", fontSize: 20, color: "#93a0b4" }}>Final balances</div>
          {(s.lines ?? []).slice(0, 6).map((line, i) => (
            <div key={i} className="abs" style={{ left: 0, width: 800, top: 134 + i * 40, textAlign: "center", fontSize: 28, fontWeight: 700 }}>{line}</div>
          ))}
        </>
      )}

      {s.buttons.map((b, i) => (
        <div
          key={b.id}
          className={`kbtn ${pressed === b.id ? "pressed" : ""}`}
          style={{ left: rects[i].x, width: rects[i].w, background: BTN[b.style ?? "plain"] ?? BTN.plain }}
          onClick={() => onTouch(b.id)}
        >
          {b.label}
        </div>
      ))}

      {error && <div className="toast">{error}</div>}
      {stale && <div className="stale">Reconnecting…</div>}
    </div>
  );
}
