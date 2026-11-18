"use client";
// Laptop / TV page: /watch/ABCD. Plays the game's YouTube clip in sync with the market (the video jumps to the
// question's startAt when trading opens) next to the live price, the countdown and the leaderboard. With
// "Sound on" it plays the announcement sounds and reads the announcer (or the result) out loud.
// Dark, readable from across a room; one thing moves at a time and only when the game state changes.
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Qr } from "@/components/Qr";
import { Spark } from "@/components/Spark";
import { HttpError, api, fmtClock, useNow, usePoll, usd, type LobbyData } from "@/components/client";
import { gameScore, latestCaption, marketGemini, marketMode, marketModel, marketPool, probCents, scorecard } from "@/components/extras";
import { Avatar, CountUp, Icon, Roll, Wordmark, useNewIds } from "@/components/ui";

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  unMute(): void;
  mute(): void;
  setVolume(v: number): void;
  destroy(): void;
};
type YTNamespace = { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer };
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytPromise: Promise<YTNamespace> | null = null;
function loadYouTube(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!ytPromise) {
    ytPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT as YTNamespace);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(s);
    });
  }
  return ytPromise;
}

const SIDE = { yes: "Yes", no: "No" } as const;

export default function WatchPage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code || "").toUpperCase();
  const { data: l, error, lastOk } = usePoll(() => api<LobbyData>(`/api/lobby/${code}`), 1000);
  const now = useNow(250);
  const [sound, setSound] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const lastEvent = useRef<number | null>(null);
  const lastCaption = useRef<number | null>(null);
  const videoId = l?.game?.youtubeId ?? null;
  const freshPlayers = useNewIds(l?.players.map((p) => p.id) ?? []);

  // Create the YouTube player once we know the clip.
  useEffect(() => {
    if (!videoId || !holder.current) return;
    let cancelled = false;
    const el = document.createElement("div");
    holder.current.appendChild(el);
    loadYouTube().then((YT) => {
      if (cancelled) return;
      player.current = new YT.Player(el, {
        videoId,
        width: "100%",
        height: "100%",
        playerVars: { controls: 1, rel: 0, playsinline: 1, mute: 1, modestbranding: 1 },
        events: { onReady: () => setPlayerReady(true) },
      });
    });
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
      setPlayerReady(false);
      el.remove();
    };
  }, [videoId]);

  // Keep the video where the market says it should be.
  useEffect(() => {
    const p = player.current;
    if (!l || !p || !playerReady) return;
    const m = l.market;
    if (m && (l.phase === "open" || l.phase === "locked")) {
      const serverNow = Date.now() + (l.now - lastOk);
      const target = m.startAt + (serverNow - m.openedAt) / 1000;
      if (Math.abs((p.getCurrentTime?.() ?? 0) - target) > 2.5) p.seekTo(target, true);
      if (p.getPlayerState?.() !== 1) p.playVideo();
    } else if (l.phase === "lobby" || l.phase === "ended") {
      if (p.getPlayerState?.() === 1) p.pauseVideo();
    }
  }, [l, playerReady, lastOk]);

  // Sounds, spoken results and spoken announcer lines for new events (only with sound on).
  useEffect(() => {
    if (!l) return;
    const newest = l.events.length ? l.events[l.events.length - 1].id : 0;
    const cap = latestCaption(l);
    if (lastEvent.current === null) {
      lastEvent.current = newest; // do not replay old events when the page opens
      lastCaption.current = cap?.id ?? 0;
      return;
    }
    const fresh = l.events.filter((e) => e.id > (lastEvent.current as number));
    lastEvent.current = Math.max(lastEvent.current, newest);
    const newCaption = cap && cap.id > (lastCaption.current ?? 0) ? cap : null;
    if (cap) lastCaption.current = Math.max(lastCaption.current ?? 0, cap.id);
    if (!sound) return;
    const speak = (text: string, delay: number) => {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text.replace(/\$(\d+)\.(\d\d)/g, "$1 dollars $2"));
      setTimeout(() => window.speechSynthesis.speak(u), delay);
    };
    for (const e of fresh) {
      if (e.sound) new Audio(`/sounds/${e.sound}.wav`).play().catch(() => {});
      // The announcer speaks when there is one; otherwise read the result out.
      if (e.kind === "result" && !cap) speak(e.text, 900);
    }
    if (newCaption) speak(newCaption.text, fresh.length ? 700 : 0);
  }, [l, sound]);

  function toggleSound() {
    const on = !sound;
    setSound(on);
    try {
      if (on) {
        player.current?.unMute();
        player.current?.setVolume(100);
        new Audio("/sounds/tap.wav").play().catch(() => {});
      } else {
        player.current?.mute();
        if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      }
    } catch {
      /* player not ready yet */
    }
  }

  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    return (
      <div className="tv">
        <div className="tv-top"><Wordmark size={28} /></div>
        <div className="tv-center" role="status">
          <div>
            <h1 style={{ color: "var(--ink)", fontSize: "2em" }}>{error ? (notFound ? `No lobby called ${code}` : "Can’t reach Huddle") : "Loading…"}</h1>
            {error && <p style={{ marginTop: "0.4em" }}>{notFound ? "Pick a game on the box first, then open this page again." : `${error.message}. Retrying…`}</p>}
          </div>
        </div>
      </div>
    );
  }

  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const lockIn = m ? Math.max(0, Math.ceil((m.lockAt - serverNow) / 1000)) : 0;
  const window_ = m ? Math.max(1, Math.round((m.lockAt - m.openedAt) / 1000)) : 1;
  const live = !!m && (l.phase === "open" || l.phase === "locked" || l.phase === "result");
  const caption = latestCaption(l);
  const lastEventText = l.events.length ? l.events[l.events.length - 1] : null;
  const score = gameScore(l);
  const mode = marketMode(l);
  const pool = marketPool(l);
  const model = marketModel(l);
  const gemini = marketGemini(l);
  const card = scorecard(l);
  const board = [...l.players].sort((a, b) => b.balance - a.balance);

  return (
    <div className="tv">
      <header className="tv-top">
        <Wordmark size={28} />
        {l.game && <span className="game">{l.game.title}</span>}
        <span className="chip code" translate="no">{l.code}</span>
        {score && (
          <span className="scorebug" aria-label={`${score.home} ${score.homeScore}, ${score.away} ${score.awayScore}`}>
            <span>{score.home}</span><span className="sc">{score.homeScore} – {score.awayScore}</span><span>{score.away}</span>
            {score.clock && <span className="clk tnum">{score.clock}</span>}
          </span>
        )}
        <span className="spacer" />
        <button className="tv-sound" aria-pressed={sound} onClick={toggleSound}>
          <Icon name={sound ? "sound" : "mute"} size={18} /> {sound ? "Sound on" : "Sound off"}
        </button>
      </header>

      {/* ---------------- stage: the clip (or the game card), with the join panel / final board over it */}
      <main className="stage" id="main">
        <div className="screen">
          <div className="player" ref={holder} />
          {!videoId && (
            <div className="card-fill">
              <div>
                <h2>{l.game?.title ?? "Huddle"}</h2>
                <p>{l.game?.subtitle || "Watch along on the big screen."}</p>
              </div>
            </div>
          )}
          {l.phase === "lobby" && (
            <div className="over">
              <div className="joinpanel">
                <div className="qr"><Qr text={l.joinUrl} size={260} /></div>
                <div>
                  <h1>Join the huddle</h1>
                  <p className="lead">Scan the code or tap your phone on the box.</p>
                  <div className="code"><span className="mute">Code</span><b translate="no">{l.code}</b></div>
                  <div className="url">{l.joinUrl.replace(/^https?:\/\//, "")}</div>
                  <div className="people" aria-live="polite">
                    {l.players.length ? (
                      l.players.map((p) => (
                        <span key={p.id} className={`person ${freshPlayers.has(p.id) ? "new" : ""}`}>
                          <Avatar name={p.name} size={24} />{p.name}
                        </span>
                      ))
                    ) : (
                      <span className="mute">Waiting for the first player…</span>
                    )}
                  </div>
                  {l.nextQuestion && <p className="first"><b>First up:</b> {l.nextQuestion}</p>}
                </div>
              </div>
            </div>
          )}
          {l.phase === "ended" && (
            <div className="over">
              <div className="final">
                <h1>Final standings</h1>
                <p className="lead">Thanks for playing. Cash out on your phone.</p>
                <ol className="rows">
                  {[...l.players].sort((a, b) => b.balance - a.balance).map((p, i) => (
                    <li key={p.id}>
                      <span className="rank">{i + 1}</span>
                      {i === 0 && <Icon name="trophy" size={20} className="ink2" />}
                      <span className="grow">{p.name}</span>
                      <span className="amt">{usd(p.balance)}</span>
                    </li>
                  ))}
                </ol>
                {card && (
                  <div className="scorecard">
                    <div className="compare">
                      <div className="me"><div className="k">Room</div><div className="v tnum">{card.room === null ? "–" : card.room.toFixed(3)}</div></div>
                      <div><div className="k">Model</div><div className="v tnum">{card.model === null ? "–" : card.model.toFixed(3)}</div></div>
                      <div><div className="k">Gemini</div><div className="v tnum">{card.gemini === null ? "–" : card.gemini.toFixed(3)}</div></div>
                    </div>
                    <p className="verdict">{card.verdict ? `${card.verdict} ` : ""}Brier score over {card.n} {card.n === 1 ? "question" : "questions"}, lower is better.</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ---------------- rail: market, leaderboard, join */}
      <aside className="rail" aria-label="Market">
        {live && m ? (
          <section className="rcard" aria-labelledby="tvq">
            <div className="meta">
              <span>Question {m.qIndex + 1} of {l.questionCount}</span>
              {l.phase === "open" && <span className={`status ${lockIn <= 10 ? "soon" : "open"}`}><Icon name="clock" size={14} /> Live</span>}
              {l.phase === "locked" && <span className="status closed snap"><Icon name="lock" size={14} /> Closed</span>}
              {l.phase === "result" && m.outcome && <span className="status closed"><Icon name="check" size={14} /> {SIDE[m.outcome]} won</span>}
            </div>
            <h1 className="q" id="tvq">{m.text}</h1>

            {l.phase === "result" && m.outcome ? (
              <>
                <div className="outcome">
                  {(["yes", "no"] as const).map((side) => {
                    const win = side === m.outcome;
                    return (
                      <div key={side} className={`orow ${side} ${win ? "win" : "lose"}`}>
                        {win && <span className="fill" aria-hidden="true" />}
                        <span className="lbl">{win ? <Icon name="check" size={18} /> : <Icon name="x" size={18} />} {SIDE[side]}</span>
                        <span className="tag">{win ? "Pays $1" : "$0"}</span>
                      </div>
                    );
                  })}
                </div>
                <ul className="rows" style={{ marginTop: "0.8em" }} aria-live="polite">
                  {m.winners.length ? (
                    m.winners.slice(0, 4).map((w) => (
                      <li key={w.name}>
                        <span className="grow">{w.name}</span>
                        <span className="amt" style={{ color: "var(--green-ink)" }}>+<CountUp cents={w.cents} format={usd} /></span>
                      </li>
                    ))
                  ) : (
                    <li><span className="grow mute">Nobody called it this time.</span></li>
                  )}
                </ul>
              </>
            ) : (
              <>
                <div className="prices" aria-live="polite">
                  <div className="tprice yes">
                    <div className="k"><span className="sw" aria-hidden="true" />Yes</div>
                    <div className="v"><Roll text={String(m.yesCents)} value={m.yesCents} arrow label={`Yes ${m.yesCents} cents`} /><span className="c">¢</span></div>
                    <div className="p">{m.yesCents}% chance</div>
                  </div>
                  <div className="tprice no">
                    <div className="k"><span className="sw" aria-hidden="true" />No</div>
                    <div className="v"><Roll text={String(m.noCents)} value={m.noCents} label={`No ${m.noCents} cents`} /><span className="c">¢</span></div>
                    <div className="p">{mode === "pool" ? "Winners split the pot" : "A winning share pays $1"}</div>
                  </div>
                </div>
                <div className="chart"><Spark points={m.history} height={72} /></div>
                {l.phase === "open" ? (
                  <>
                    <div className={`countdown ${lockIn <= 10 ? "urgent" : ""}`}>
                      <span className="k">Trading locks in</span>
                      <span className="v">{fmtClock(lockIn)}</span>
                    </div>
                    <div className="track" aria-hidden="true"><span style={{ transform: `scaleX(${Math.min(1, lockIn / window_)})` }} /></div>
                  </>
                ) : (
                  <div className="countdown"><span className="k">Trading closed. Watch the play.</span><Icon name="lock" size={22} /></div>
                )}
              </>
            )}

            {mode === "pool" && pool && (
              <div className="pool">
                <div className="bar" aria-hidden="true">
                  <span className="y" style={{ width: `${(pool.yesCents / Math.max(1, pool.yesCents + pool.noCents)) * 100}%` }} />
                  <span className="n" style={{ flex: 1 }} />
                </div>
                <div className="legend"><span className="tnum">Yes {usd(pool.yesCents)}</span><span className="tnum">No {usd(pool.noCents)}</span></div>
              </div>
            )}
            {(model !== null || gemini) && (
              <div className="compare" aria-label="Room, model and Gemini prices for Yes">
                <div className="me"><div className="k">Room</div><div className="v tnum">{m.yesCents}¢</div></div>
                <div><div className="k">Model</div><div className="v tnum">{model !== null ? `${probCents(model)}¢` : "–"}</div></div>
                <div><div className="k">Gemini</div><div className="v tnum">{gemini ? `${probCents(gemini.prob)}¢` : "–"}</div></div>
              </div>
            )}
            <div className="stats"><span><b className="tnum">{usd(m.volume)}</b> traded</span><span>{m.trades.length} trades</span></div>
          </section>
        ) : l.phase === "ended" ? (
          <section className="rcard" aria-labelledby="tvresults">
            <h2 id="tvresults">Results</h2>
            <ul className="rows" style={{ marginTop: "0.4em" }}>
              {l.results.map((r, i) => (
                <li key={i}>
                  <span className="grow" style={{ whiteSpace: "normal" }}>{r.text}</span>
                  <span className={`side-tag ${r.outcome}`}><Icon name="check" size={12} />&nbsp;{SIDE[r.outcome]}</span>
                </li>
              ))}
              {l.results.length === 0 && <li><span className="grow mute">No questions were played.</span></li>}
            </ul>
          </section>
        ) : (
          <section className="rcard">
            <h2>Up next</h2>
            <p className="q" style={{ fontSize: "1.25em" }}>{l.nextQuestion ?? "The host starts the next question from the box."}</p>
          </section>
        )}

        {l.phase !== "ended" && <section className="rcard board" aria-labelledby="tvboard">
          <h2 id="tvboard">Leaderboard</h2>
          <ol className="rows" style={{ marginTop: "0.4em" }}>
            {board.slice(0, 8).map((p, i) => (
              <li key={p.id} className={freshPlayers.has(p.id) ? "new" : ""}>
                <span className="rank">{i + 1}</span>
                <span className="grow">{p.name}</span>
                <span className="amt">{usd(p.balance)}</span>
              </li>
            ))}
            {board.length === 0 && <li><span className="grow mute">Nobody yet</span></li>}
          </ol>
        </section>}

        {l.phase !== "lobby" && l.phase !== "ended" && (
          <section className="rcard mini-join">
            <span className="qr"><Qr text={l.joinUrl} size={72} /></span>
            <div>
              <h2>Join on your phone</h2>
              <b translate="no">{l.code}</b>
            </div>
          </section>
        )}
      </aside>

      {/* ---------------- one caption line: the announcer, or the latest thing that happened */}
      <footer className="tv-caption" aria-live="polite">
        <Icon name={caption ? "sound" : "arrow-right"} size={20} className="mute" />
        {caption ? (
          <span key={`c${caption.id}`} className="txt fresh">{caption.text}</span>
        ) : lastEventText ? (
          <span key={`e${lastEventText.id}`} className="txt fresh">{lastEventText.text}</span>
        ) : (
          <span className="txt mute">Waiting for the host…</span>
        )}
        {caption && <span className="src">Announcer</span>}
      </footer>
    </div>
  );
}
