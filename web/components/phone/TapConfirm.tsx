"use client";
// Tap-to-confirm (lib/hw.ts). With "Tap the box to confirm" switched on, a bet is parked (~20 s) instead of placed;
// the box shows it, and tapping the phone on the box's NFC sticker opens /k/<kiosk>, which comes back here with
// ?tap=1 and this component places it. Phones without NFC get a "Confirm here" button.
import { useEffect, useRef, useState } from "react";
import { api } from "@/components/client";

const FLAG = "huddle:tapconfirm";

/** Extra body for the buy request: {confirm:"tap"} when this phone confirms bets on the box. */
export function tapBody(): { confirm?: "tap" } {
  try {
    return localStorage.getItem(FLAG) === "1" ? { confirm: "tap" } : {};
  } catch {
    return {};
  }
}

type Pending = { side: "yes" | "no"; cents: number; until: number } | null | undefined;

export function TapConfirm({ code, token, pending }: { code: string; token: string | null; pending: Pending }) {
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const tried = useRef(false);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(FLAG) === "1");
    } catch {
      /* private mode */
    }
  }, []);
  const confirm = async () => {
    try {
      await api(`/api/lobby/${code}/confirm`, { body: {}, token });
      setMsg("Bet placed. Tapped in!");
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
  const toggle = () => {
    const v = !on;
    setOn(v);
    try {
      localStorage.setItem(FLAG, v ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="ph-tapconfirm" data-testid="tap-confirm" style={{ fontSize: 13, display: "grid", gap: 6 }}>
      {pending ? (
        <div role="status">
          ${(pending.cents / 100).toFixed(2)} on {pending.side.toUpperCase()}: tap your phone on the box to confirm.{" "}
          <button className="hd-btn" onClick={confirm} data-testid="tap-confirm-here">
            Confirm here
          </button>
        </div>
      ) : msg ? (
        <div role="status">{msg}</div>
      ) : null}
      <label style={{ opacity: 0.8 }}>
        <input type="checkbox" checked={on} onChange={toggle} /> Tap the box to confirm bets
      </label>
    </div>
  );
}
