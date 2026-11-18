"use client";
import { useState } from "react";
import { api, usePoll, useQueryParam } from "@/components/client";

type Health = {
  storage: string;
  money: { mode: string; sandbox: boolean; realMoney: boolean; payouts: string };
  kioskKey: boolean;
  warnings: string[];
};

export default function Home() {
  const [code, setCode] = useState("");
  const noKiosk = useQueryParam("nokiosk");
  const { data: health } = usePoll(() => api<Health>("/api/health"), 15000);
  const clean = code.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);

  return (
    <main className="wrap wide">
      <div className="home-hero">
        <h1 style={{ fontSize: 34 }}>Live Lines</h1>
        <p>
          Turn a watch party into a tiny prediction market. Pick a game on the kiosk, tap your phone to join, then buy
          YES or NO on one question at a time while the clip plays. Prices move with every trade.
        </p>
      </div>

      {noKiosk && (
        <div className="banner info">Kiosk {noKiosk} has no game running yet. Pick a game on the kiosk screen first, then tap again.</div>
      )}

      <div className="links">
        <div className="card stack">
          <h2>Join a lobby</h2>
          <div className="dim">Tap the kiosk with your phone, scan its QR code, or type the 4-letter code.</div>
          <div className="row">
            <input className="grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD" aria-label="Lobby code" autoCapitalize="characters" />
            <a className="btn btn-primary" href={clean ? `/l/${clean}` : undefined} aria-disabled={!clean}>Join</a>
          </div>
        </div>
        <div className="card stack">
          <h2>Watch page (laptop / TV)</h2>
          <div className="dim">Plays the clip with the live price on top.</div>
          <div className="row">
            <a className="btn" href={clean ? `/watch/${clean}` : undefined} aria-disabled={!clean}>Open watch page{clean ? ` for ${clean}` : ""}</a>
          </div>
        </div>
        <div className="card stack">
          <h2>Kiosk screen (web)</h2>
          <div className="dim">The same screen the ESP32 kiosk draws. Use it to test without hardware, or on a tablet.</div>
          <div className="row">
            <a className="btn" href="/kiosk?id=1">Open kiosk 1</a>
          </div>
        </div>
      </div>

      <div className="card small dim" style={{ marginTop: 12 }}>
        {health ? (
          <>
            <div>
              Storage: <b>{health.storage}</b> · Money: <b>{health.money.mode}</b>
              {health.money.mode === "coinbase" && <> ({health.money.realMoney ? "REAL money" : "sandbox"}, payouts {health.money.payouts})</>}
              {" "}· Kiosk key: <b>{health.kioskKey ? "on" : "off"}</b>
            </div>
            {health.warnings.map((w) => (
              <div key={w} style={{ color: "#f0c36b", marginTop: 4 }}>⚠ {w}</div>
            ))}
          </>
        ) : (
          "Checking server…"
        )}
      </div>
    </main>
  );
}
