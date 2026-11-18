"use client";
// Laptop / TV page: /watch/ABCD. Plays the game's YouTube clip in sync with the market (the video jumps to the
// question's startAt when trading opens) with the live price on top. Also plays the announcement sounds and
// reads the result out loud, so the demo has audio before the kiosk speaker exists.
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Qr } from "@/components/Qr";
import { Spark } from "@/components/Spark";
import { HttpError, api, fmtClock, useNow, usePoll, usd, type LobbyData } from "@/components/client";

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  unMute(): void;
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

export default function WatchPage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code || "").toUpperCase();
  const { data: l, error, lastOk } = usePoll(() => api<LobbyData>(`/api/lobby/${code}`), 1000);
  const now = useNow(250);
  const [started, setStarted] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const lastEvent = useRef<number | null>(null);
  const videoId = l?.game?.youtubeId ?? null;

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

  // Sounds and spoken results for new events.
  useEffect(() => {
    if (!l) return;
    const newest = l.events.length ? l.events[l.events.length - 1].id : 0;
    if (lastEvent.current === null) {
      lastEvent.current = newest; // do not replay old events when the page opens
      return;
    }
    const fresh = l.events.filter((e) => e.id > (lastEvent.current as number));
    lastEvent.current = Math.max(lastEvent.current, newest);
    if (!started) return;
    for (const e of fresh) {
      if (e.sound) new Audio(`/sounds/${e.sound}.wav`).play().catch(() => {});
      if (e.kind === "result" && "speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(e.text.replace(/\$(\d+)\.(\d\d)/g, "$1 dollars $2"));
        setTimeout(() => window.speechSynthesis.speak(u), 900);
      }
    }
  }, [l, started]);

  function start() {
    setStarted(true);
    try {
      player.current?.unMute();
      player.current?.setVolume(100);
    } catch {
      /* player not ready yet */
    }
    new Audio("/sounds/tap.wav").play().catch(() => {});
  }

  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    return (
      <div className="watch">
        <div className="novideo">
          <div>
            <h1>{error ? (notFound ? `No lobby ${code}` : "Can't reach the server") : "Loading…"}</h1>
            {error && <p>{notFound ? "Pick a game on the kiosk first." : error.message}</p>}
          </div>
        </div>
      </div>
    );
  }

  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const lockIn = m ? Math.max(0, Math.ceil((m.lockAt - serverNow) / 1000)) : 0;
  const lastResult = [...l.events].reverse().find((e) => e.kind === "result");
  const showResultSplash = l.phase === "result" && m?.outcome && lastResult && serverNow - lastResult.at < 7000;

  return (
    <div className="watch">
      <div className="player" ref={holder} />
      {!videoId && (
        <div className="novideo">
          <div>
            <h2>{l.game?.title}</h2>
            <p>No clip set for this game yet. Put an 11-character YouTube id in config/games.json.</p>
          </div>
        </div>
      )}

      {/* live price bar */}
      {m && (l.phase === "open" || l.phase === "locked" || l.phase === "result") && (
        <div className="top">
          <div className="grow">
            <div className="dim">Question {m.qIndex + 1} of {l.questionCount} · Lobby {l.code}</div>
            <div className="q">{m.text}</div>
            <div className="countdown" style={{ marginTop: 6 }}>
              {l.phase === "open" && <span style={{ color: lockIn <= 10 ? "#f4a3a3" : undefined }}>Locks in {fmtClock(lockIn)}</span>}
              {l.phase === "locked" && <span style={{ color: "#e0675b" }}>Trading closed · watch the play</span>}
              {l.phase === "result" && m.outcome && <span style={{ color: m.outcome === "yes" ? "#7fe0bd" : "#f4a3a3" }}>{m.outcome.toUpperCase()} won</span>}
            </div>
          </div>
          <div className="tprice">
            <div className="price yes">
              <div className="lbl">YES {m.lastMove === 1 && <span className="arrow-up">▲</span>}</div>
              <div className="num">{m.yesCents}¢</div>
            </div>
            <div className="price no">
              <div className="lbl">NO {m.lastMove === -1 && <span className="arrow-up">▲</span>}</div>
              <div className="num">{m.noCents}¢</div>
            </div>
          </div>
        </div>
      )}

      {/* side panel: join QR, players, trades */}
      {l.phase !== "lobby" && l.phase !== "ended" && (
        <div className="side stack">
          <div className="row">
            <Qr text={l.joinUrl} size={84} />
            <div className="grow">
              <div className="dim small">Join</div>
              <div style={{ fontWeight: 800, fontSize: 22 }}>{l.code}</div>
            </div>
          </div>
          {m && <Spark points={m.history} height={56} />}
          {m && <div className="dim small">{usd(m.volume)} traded</div>}
          <ul className="list small">
            {l.players.map((p) => (
              <li key={p.id}><span>{p.name}</span><span className="mono">{usd(p.balance)}</span></li>
            ))}
          </ul>
          {m && m.trades.length > 0 && (
            <div className="small dim">
              {m.trades.slice(0, 4).map((t) => (
                <div key={t.at + t.name}>{t.name} bought {t.side.toUpperCase()} · {usd(t.cents)}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* lobby: big join card */}
      {l.phase === "lobby" && (
        <div className="center-card">
          <div className="stack">
            <h1 style={{ fontSize: 34 }}>{l.game?.title}</h1>
            <div className="dim">Scan to join, or tap your phone on the kiosk</div>
            <div style={{ display: "grid", placeItems: "center", margin: "12px 0" }}>
              <Qr text={l.joinUrl} size={260} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 800 }}>Code {l.code}</div>
            <div className="dim small">{l.joinUrl}</div>
            <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
              {l.players.length ? l.players.map((p) => <span key={p.id} className="pill">{p.name}</span>) : <span className="dim">Nobody yet</span>}
            </div>
            <div className="dim" style={{ marginTop: 8 }}>{l.nextQuestion ? `First up: ${l.nextQuestion}` : ""}</div>
          </div>
        </div>
      )}

      {/* result splash */}
      {showResultSplash && m && (
        <div className="center-card" style={{ background: "rgba(0,0,0,.55)" }}>
          <div>
            <div className="result-big" style={{ color: m.outcome === "yes" ? "#2bd49b" : "#ff7a4d" }}>{m.outcome?.toUpperCase()}</div>
            <div style={{ fontSize: 22, marginTop: 10 }}>
              {m.winners.length ? m.winners.map((w) => `${w.name} +${usd(w.cents)}`).join(" · ") : "No winners this time"}
            </div>
          </div>
        </div>
      )}

      {/* ended: leaderboard */}
      {l.phase === "ended" && (
        <div className="center-card">
          <div className="stack" style={{ minWidth: 320 }}>
            <h1>Session over</h1>
            <ul className="list" style={{ textAlign: "left" }}>
              {[...l.players].sort((a, b) => b.balance - a.balance).map((p) => (
                <li key={p.id}><span>{p.name}</span><span className="mono">{usd(p.balance)}</span></li>
              ))}
            </ul>
            <div className="dim small">Cash out on your phone.</div>
          </div>
        </div>
      )}

      {!started && (
        <div className="start-overlay">
          <button className="btn-primary" style={{ fontSize: 22, padding: "18px 28px" }} onClick={start}>
            Start the watch party (turns on sound)
          </button>
        </div>
      )}
    </div>
  );
}
