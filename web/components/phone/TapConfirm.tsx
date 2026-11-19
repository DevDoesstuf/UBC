"use client";
// Tap-to-confirm (lib/hw.ts). With "Tap the box to confirm" switched on, a bet is parked (~20 s) instead of placed;
// the box shows it, and tapping the phone on the box's NFC sticker opens /k/<kiosk>, which comes back here with
// ?tap=1 and this component places it. Phones without NFC get a "Confirm here" button.
import { useEffect, useRef, useState } from "react";
import { api } from "@/components/client";

const FLAG = "huddle:tapconfirm";

/** Extra body for the buy request: bets are confirmed by tapping the box by default ({confirm:"tap"}). */
export function tapBody(): { confirm?: "tap" } {
  try {
    return localStorage.getItem(FLAG) === "0" ? {} : { confirm: "tap" };
  } catch {
    return { confirm: "tap" };
  }
}

type Pending = { side: "yes" | "no"; cents: number; until: number } | null | undefined;

export function TapConfirm({ code, token, pending }: { code: string; token: string | null; pending: Pending }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const tried = useRef(false);
  const confirm = async () => {
    try {
      await api(`/api/lobby/${code}/confirm`, { body: {}, token });
      setMsg("Locked in!");
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not confirm");
    }
  };
  // Came here from the box's NFC sticker: confirm once, then drop ?tap=1 from the address.
  useEffect(() => {
    if (tried.current || !token) return;
    if (new URLSearchParams(window.location.search).get("tap") !== "1") return;
    tried.current = true;
    window.history.replaceState(null, "", `/l/${code}`);
    if (pending) void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, pending, code]);
  useEffect(() => {
    if (!pending) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((pending.until - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [pending]);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2500);
    return () => clearTimeout(t);
  }, [msg]);
  if (!pending) return msg ? <div className="ph-tapconfirm hd-pop" role="status" data-testid="tap-confirm" style={{ fontWeight: 700, textAlign: "center", padding: 10 }}>{msg}</div> : null;
  const yes = pending.side === "yes";
  return (
    <div
      className="ph-tapconfirm hd-pop"
      data-testid="tap-confirm"
      role="status"
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 18,
        background: "var(--k-ink, #10261C)",
        color: "#fff",
      }}
    >
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <path d="M6 8.5a6 6 0 0 1 0 7M9 6a9.5 9.5 0 0 1 0 12M12.5 4a13 13 0 0 1 0 16" />
      </svg>
      <div style={{ display: "grid", gap: 2 }}>
        <strong style={{ fontSize: 17 }}>Tap the box</strong>
        <span style={{ fontSize: 14, opacity: 0.85 }}>
          ${(pending.cents / 100).toFixed(2)} on <b style={{ color: yes ? "#7CDCA8" : "#FFA08F" }}>{yes ? "YES" : "NO"}</b> · {left}s
        </span>
      </div>
      <button className="hd-btn" onClick={confirm} data-testid="tap-confirm-here" style={{ fontSize: 13, padding: "8px 12px" }}>
        Confirm here
      </button>
    </div>
  );
}
