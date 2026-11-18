"use client";
// Draws a kiosk screen JSON at 800 x 480 with the SAME geometry and colours as the ESP32 firmware
// (firmware/kiosk_screen/ui.cpp). The firmware is fixed: if something here differs from what the board draws,
// change this file, never the board. Fonts: F_TITLE fub30, F_BODY helvB18 (bold), F_LARGE helvB24 (bold),
// F_SMALL helvR14, F_PRICE logisoso92, F_CLOCK logisoso32, F_RESULT logisoso58. Firmware text is placed by
// baseline; the `top` values below are those baselines minus the font's ascent.
import type { KioskScreen } from "./client";
import { fmtClock } from "./client";

// Firmware colour constants (ui.cpp K_* and headerColor/buttonColor).
const K = {
  bg: "#0b0f17", card: "#151b26", line: "#273042", text: "#eef2f8", dim: "#93a0b4", yes: "#1d9e75", yesDark: "#0e4a37",
  no: "#d85a30", noDark: "#5a2414", blue: "#378add", tile: "#1f4f80", tileOff: "#1b2331", offText: "#6b778a",
  amber: "#c98a1a", redText: "#e0675b", pink: "#f4a3a3", mint: "#7fe0bd", subtitle: "#c9d2df",
};
const HEADER: Record<string, string> = { blue: "#123a63", amber: "#5a3d08", red: "#5a1f1a", green: "#0e4a37", gray: "#2a3140" };
const BTN: Record<string, string> = { primary: K.blue, yes: K.yes, no: K.no, plain: K.line };

export const BUTTON_Y = 400;
export const BUTTON_H = 64;

export function buttonRects(n: number) {
  const gap = 16;
  const w = n ? Math.floor((768 - (n - 1) * gap) / n) : 0;
  return Array.from({ length: n }, (_, i) => ({ x: 16 + i * (w + gap), y: BUTTON_Y, w, h: BUTTON_H }));
}

function PricePanel({ x, label, value, up, yes }: { x: number; label: string; value: number; up: boolean; yes: boolean }) {
  return (
    <div className="abs" style={{ left: x, top: 180, width: 250, height: 200, borderRadius: 16, background: yes ? K.yesDark : K.noDark, border: `2px solid ${yes ? K.yes : K.no}` }}>
      <div className="abs" style={{ left: 18, top: 10, fontSize: 24, fontWeight: 700 }}>{label}</div>
      {up && <div className="abs" style={{ right: 9, top: 12, width: 0, height: 0, borderLeft: "14px solid transparent", borderRight: "14px solid transparent", borderBottom: `22px solid ${K.mint}` }} />}
      <div className="abs" style={{ left: 0, right: 0, top: 54, textAlign: "center", fontSize: 92, fontWeight: 800, lineHeight: "100px", fontVariantNumeric: "tabular-nums" }}>
        {value}<span style={{ fontSize: 24, marginLeft: 6 }}>¢</span>
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
    <svg className="abs" style={{ left: 556, top: 180 }} width={w} height={h} aria-hidden="true">
      <rect x="0.5" y="0.5" width={w - 1} height={h - 1} rx="10" fill={K.card} stroke={K.line} />
      <line x1="6" x2={w - 6} y1={y(50)} y2={y(50)} stroke={K.line} strokeDasharray="4 4" />
      <polyline points={pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={K.yes} strokeWidth="2" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="4" fill={K.yes} />
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
  const press = (id: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onTouch(id);
    }
  };
  return (
    <div className="kiosk" role="application" aria-label="Kiosk screen preview">
      <div className="hdr" style={{ background: HEADER[s.color] ?? HEADER.blue }}>
        <div className="t">{s.title}</div>
        <div className="s">{s.subtitle}</div>
        <div className="f">{s.footer}</div>
        <div className={`live-dot ${stale ? "stale" : ""}`} />
      </div>

      {s.screen === "select" &&
        (s.tiles ?? []).slice(0, 4).map((t, i) => (
          <div
            key={t.id}
            className={`tile ${t.enabled ? "" : "off"} ${pressed === t.id ? "pressed" : ""}`}
            style={{ left: 16 + (i % 2) * 392, top: 100 + Math.floor(i / 2) * 192, width: 376, height: 176 }}
            role={t.enabled ? "button" : undefined}
            tabIndex={t.enabled ? 0 : undefined}
            onClick={() => t.enabled && onTouch(t.id)}
            onKeyDown={t.enabled ? press(t.id) : undefined}
          >
            <div className="l">{t.label}</div>
            <div className="sub">{t.sub}</div>
            {t.enabled && <div className="live">LIVE</div>}
          </div>
        ))}

      {s.screen === "lobby" && (
        <>
          <div className="abs" style={{ left: 24, top: 100, width: 230, height: 230, background: "#fff", borderRadius: 8, display: "grid", placeItems: "center" }}>
            {s.qr && (
              <svg width={Math.floor(230 / (s.qr.size + 4)) * s.qr.size} height={Math.floor(230 / (s.qr.size + 4)) * s.qr.size} viewBox={`0 0 ${s.qr.size} ${s.qr.size}`} shapeRendering="crispEdges" aria-label="Join QR code" role="img">
                {s.qr.rows.flatMap((row, r) => [...row].map((c, col) => (c === "1" ? <rect key={`${r}-${col}`} x={col} y={r} width="1" height="1" fill="#000" /> : null)))}
              </svg>
            )}
          </div>
          <div className="abs" style={{ left: 24, top: 338, width: 230, textAlign: "center", fontSize: 24, fontWeight: 700 }}>Code {s.code}</div>
          <div className="abs" style={{ left: 4, top: 372, width: 270, textAlign: "center", fontSize: 14, color: K.dim, overflow: "hidden", textOverflow: "ellipsis" }}>{s.joinUrl}</div>
          <div className="abs" style={{ left: 280, top: 102, fontSize: 24, fontWeight: 700 }}>Players ({s.players?.length ?? 0})</div>
          {s.players?.length ? (
            s.players.slice(0, 7).map((p, i) => (
              <div key={i} className="abs" style={{ left: 280, top: 136 + i * 30, width: 496, fontSize: 24, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{p}</div>
            ))
          ) : (
            <div className="abs" style={{ left: 280, top: 142, fontSize: 18, fontWeight: 700, color: K.dim }}>Waiting for players...</div>
          )}
          {s.question && (
            <div className="abs" style={{ left: 280, top: 352, width: 496, fontSize: 18, fontWeight: 700, color: K.dim, overflow: "hidden", textOverflow: "ellipsis" }}>
              First up: {s.question}
            </div>
          )}
        </>
      )}

      {(s.screen === "market" || s.screen === "locked") && (
        <>
          <div className="abs" style={{ left: 24, top: 100, width: 752, height: 72, fontSize: 30, fontWeight: 700, lineHeight: "34px", overflow: "hidden", whiteSpace: "pre-wrap" }}>{s.question}</div>
          <PricePanel x={24} label="YES" value={s.yes ?? 50} up={s.move === 1} yes />
          <PricePanel x={290} label="NO" value={s.no ?? 50} up={s.move === -1} yes={false} />
          <Chart points={s.history ?? [50]} />
          <div className="abs" style={{ left: 556, top: 302, fontSize: 18, fontWeight: 700 }}>{s.traded}</div>
          {s.screen === "market" ? (
            <>
              <div className="abs" style={{ left: 556, top: 333, fontSize: 14, color: K.dim }}>Locks in</div>
              <div className="abs" style={{ left: 556, top: 354, fontSize: 34, lineHeight: "34px", fontWeight: 800, fontVariantNumeric: "tabular-nums", color: (s.lockIn ?? 0) <= 10 ? K.pink : K.text }}>{fmtClock(s.lockIn ?? 0)}</div>
            </>
          ) : (
            <div className="abs" style={{ left: 556, top: 352, fontSize: 30, fontWeight: 700, color: K.redText }}>CLOSED</div>
          )}
        </>
      )}

      {s.screen === "result" && (
        <>
          <div className="abs" style={{ left: 24, top: 100, width: 320, height: 284, borderRadius: 16, background: s.result === "YES" ? K.yes : K.no, display: "grid", placeItems: "center", fontSize: 80, fontWeight: 800, color: "#fff" }}>
            {s.result}
          </div>
          <div className="abs" style={{ left: 368, top: 106, width: 408, fontSize: 18, fontWeight: 700, color: K.dim, lineHeight: "26px", maxHeight: 52, overflow: "hidden", whiteSpace: "pre-wrap" }}>{s.question}</div>
          {(s.lines ?? []).slice(0, 6).map((line, i) => (
            <div key={i} className="abs" style={{ left: 368, top: 176 + i * 34, width: 408, fontSize: 24, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>{line}</div>
          ))}
        </>
      )}

      {s.screen === "ended" && (
        <>
          <div className="abs" style={{ left: 0, width: 800, top: 103, textAlign: "center", fontSize: 18, fontWeight: 700, color: K.dim }}>Final balances</div>
          {(s.lines ?? []).slice(0, 6).map((line, i) => (
            <div key={i} className="abs" style={{ left: 0, width: 800, top: 142 + i * 40, textAlign: "center", fontSize: 24, fontWeight: 700 }}>{line}</div>
          ))}
        </>
      )}

      {s.buttons.map((b, i) => (
        <div
          key={b.id}
          className={`kbtn ${pressed === b.id ? "pressed" : ""}`}
          style={{ left: rects[i].x, width: rects[i].w, background: BTN[b.style ?? "plain"] ?? BTN.plain }}
          role="button"
          tabIndex={0}
          onClick={() => onTouch(b.id)}
          onKeyDown={press(b.id)}
        >
          {b.label}
        </div>
      ))}

      {error && <div className="toast-k" role="alert">{error}</div>}
      {stale && <div className="stale">Reconnecting…</div>}
    </div>
  );
}
