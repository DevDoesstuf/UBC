"use client";
// Home: a kinetic headline, the party code in the thumb zone, and the host's way in (box screen, TV page).
import { useState } from "react";
import "@/components/phone/phone.css";
import "./home.css";
import { api, usePoll, useQueryParam } from "@/components/client";
import { Aurora, Icon, Kinetic, Mark, SplitBar, Wordmark } from "@/components/huddle";

type Health = {
  storage: string;
  money: { mode: string; sandbox: boolean; realMoney: boolean; payouts: string };
  kioskKey: boolean;
  warnings: string[];
};

const d = (ms: number) => ({ ["--d" as string]: `${ms}ms` }) as React.CSSProperties;

export default function Home() {
  const [code, setCode] = useState("");
  const [tv, setTv] = useState("");
  const [tried, setTried] = useState(false);
  const noKiosk = useQueryParam("nokiosk");
  const { data: health } = usePoll(() => api<Health>("/api/health"), 15000);
  const clean = code.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const tvClean = tv.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6);
  const ready = clean.length >= 3;

  return (
    <div className="ph-screen hm">
      <Aurora fixed className="hd-fade" />
      <div className="hm-wrap">
        <header className="hm-top">
          <Wordmark className="hd-pop hm-wordmark" lit={3} />
          <a className="hd-btn hd-btn-quiet" href="/kiosk?id=1">
            <Mark size="1.2rem" lit={1} className="hm-mark-sm" /> Box screen
          </a>
        </header>

        {noKiosk && (
          <p className="hm-banner hd-drop" role="status">
            <Icon name="warn" size={18} /> Box {noKiosk} has no game running yet. Pick a game on its screen first, then tap again.
          </p>
        )}

        <main id="main" className="hm-grid">
          <section className="hm-hero" aria-labelledby="hm-h">
            <Kinetic as="h1" id="hm-h" text="Call the next play with your friends." className="hd-q hm-h" delay={120} stagger={60} />
            <p className="hd-rise hm-lead" style={d(520)}>
              Huddle turns a watch party into a tiny market. Pick a game on the box, tap your phone to join, and buy Yes or No on one question at a time. A winning call pays $1 a share.
            </p>
          </section>

          <div className="hm-demo-slot">
            <div className="hm-demo hd-card hd-rise" style={d(640)} aria-hidden="true">
              <div className="hm-demo-top">
                <span className="ph-moment-badge">
                  <Icon name="bolt" size={13} /> Penalty!
                </span>
                <span className="hm-demo-clock hd-num">0:14</span>
              </div>
              <p className="hd-q hm-demo-q">Will Ronaldo score this penalty?</p>
              <SplitBar parts={[{ id: "y", label: "Yes", p: 0.72 }, { id: "n", label: "No", p: 0.28 }]} className="ph-split" />
              <div className="hm-demo-tiles">
                <span className="ph-tile yes small"><span className="ph-tile-label">Yes</span><span className="hd-num hm-demo-pct">72%</span></span>
                <span className="ph-tile no small"><span className="ph-tile-label">No</span><span className="hd-num hm-demo-pct">28%</span></span>
              </div>
            </div>
          </div>

          <aside className="hm-side">
            <form
              className="hm-join hd-card hd-rise"
              style={d(380)}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                setTried(true);
                if (ready) window.location.href = `/l/${clean}`;
              }}
            >
              <label htmlFor="code" className="ph-label">
                Got a code? It’s on the box.
              </label>
              <div className="hm-code-row">
                <input
                  id="code"
                  name="party-code"
                  className="hd-field hd-num hm-code"
                  value={clean}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setTried(false);
                  }}
                  placeholder="ABCD"
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  aria-invalid={tried && !ready}
                  aria-describedby="code-hint"
                  translate="no"
                />
                <button type="submit" className="hd-btn hd-btn-prime hm-join-btn">
                  Join
                </button>
              </div>
              <p id="code-hint" className="ph-hint hm-hint">
                {tried && !ready ? (
                  <span className="ph-hot">
                    <Icon name="warn" size={16} /> Party codes are at least 3 letters.
                  </span>
                ) : (
                  <>
                    <Icon name="nfc" size={16} /> Or tap your phone on the box, or scan its code.
                  </>
                )}
              </p>
            </form>

            <div className="hm-host hd-card hd-rise" style={d(480)}>
              <h2 className="ph-h3">Hosting tonight?</h2>
              <a className="hm-link" href="/kiosk?id=1">
                <span>
                  <b>Box screen</b>
                  <span className="hm-link-d">Exactly what the box on the table draws. Host without the hardware.</span>
                </span>
                <Icon name="arrowRight" size={18} />
              </a>
              <form
                className="hm-tv"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tvClean.length >= 3) window.location.href = `/watch/${tvClean}`;
                }}
              >
                <label htmlFor="tv" className="hm-link-d">
                  <b className="hm-b">TV page</b> The game with the live price and the board, for the big screen.
                </label>
                <div className="hm-code-row">
                  <input
                    id="tv"
                    name="tv-code"
                    className="hd-field hd-num hm-code sm"
                    value={tvClean}
                    onChange={(e) => setTv(e.target.value)}
                    placeholder="Code…"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    translate="no"
                  />
                  <button className="hd-btn hd-btn-secondary" disabled={tvClean.length < 3}>
                    Open TV
                  </button>
                </div>
              </form>
            </div>
          </aside>
        </main>

        <ol className="hm-how">
          {[
            ["Pick a game", "On the box. Everyone taps a phone on it or scans the code."],
            ["Buy Yes or No", "Prices move with every trade. 62¢ means the room thinks 62% likely."],
            ["Watch the play", "Trading locks before the play. Each winning share pays $1."],
          ].map(([t, b], i) => (
            <li key={t} className="hd-rise" style={d(700 + i * 90)}>
              <span className="hd-num hm-how-n">{i + 1}</span>
              <h3 className="ph-h3">{t}</h3>
              <p className="ph-hint">{b}</p>
            </li>
          ))}
        </ol>

      </div>
    </div>
  );
}
