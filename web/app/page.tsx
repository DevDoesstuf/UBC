"use client";
import { useState } from "react";
import { api, usePoll, useQueryParam } from "@/components/client";
import { Icon, Wordmark } from "@/components/ui";

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
    <main className="home" id="main">
      <div className="home-top">
        <Wordmark size={26} />
        <a className="btn btn-text" href="/kiosk?id=1">Open the box screen</a>
      </div>

      {noKiosk && (
        <div className="banner" role="status">Box {noKiosk} has no game running yet. Pick a game on its screen first, then tap again.</div>
      )}

      <section className="home-hero">
        <div>
          <h1>Call the next play with your friends.</h1>
          <p>Huddle turns a watch party into a tiny prediction market. Pick a game on the box, tap your phone to join, and buy Yes or No on one question at a time while the clip plays. A winning share pays $1.</p>
        </div>
        <form
          className="home-join"
          onSubmit={(e) => {
            e.preventDefault();
            if (clean) window.location.href = `/l/${clean}`;
          }}
        >
          <label className="field" htmlFor="code">
            Lobby code
            <input
              id="code"
              name="lobby-code"
              className="code-in"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ABCD"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              maxLength={6}
            />
          </label>
          <button className="btn-green btn-block" disabled={!clean}>
            Join {clean || "lobby"} <Icon name="arrow-right" size={16} />
          </button>
          <p className="hint" style={{ marginTop: 0, textAlign: "center" }}>Or tap your phone on the box, or scan its code.</p>
        </form>
      </section>

      <div className="home-links">
        <a className="home-link" href={clean ? `/watch/${clean}` : undefined} aria-disabled={!clean}>
          <span className="t">Watch on the TV {clean ? clean : ""} <Icon name="arrow-right" size={16} /></span>
          <span className="d">{clean ? "Plays the clip with the live price, the countdown and the leaderboard." : "Type a lobby code above to open its TV page."}</span>
        </a>
        <a className="home-link" href="/kiosk?id=1">
          <span className="t">Box screen <Icon name="arrow-right" size={16} /></span>
          <span className="d">Exactly what the 800×480 box draws. Use it to host without the hardware.</span>
        </a>
      </div>

      <div className="how">
        <div><span className="n">01</span><h3>Pick a game</h3><p>On the box. Everyone taps a phone on it or scans the code.</p></div>
        <div><span className="n">02</span><h3>Buy Yes or No</h3><p>Prices move with every trade, like a real market. 62¢ means the room thinks 62% likely.</p></div>
        <div><span className="n">03</span><h3>Watch the play</h3><p>Trading locks before the play. Each winning share pays $1.</p></div>
      </div>

      <div className="health" role="status">
        {health ? (
          <>
            <div>
              Server: storage {health.storage} · money {health.money.mode}
              {health.money.mode === "coinbase" && <> ({health.money.realMoney ? "real money" : "test mode"}, payouts {health.money.payouts})</>}
              {" "}· box key {health.kioskKey ? "on" : "off"}
            </div>
            {health.warnings.map((w) => (
              <div key={w} className="warn">{w}</div>
            ))}
          </>
        ) : (
          "Checking the server…"
        )}
      </div>
    </main>
  );
}
