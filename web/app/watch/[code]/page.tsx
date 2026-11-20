"use client";
// Laptop / TV page: /watch/ABCD. The room's big screen, after the box (dark, Kalshi-style: black canvas, beige
// ink, muted green/red): a market takeover with a huge "% chance" over the live price chart, slim Yes/No pills
// and a thin countdown, the trade ticker and leaderboard, the announcer's caption bar (read out with "Sound on"),
// the result flood, "Who's smarter?" and the podium. Clip games play the YouTube clip in sync with the market.
// Readable from across a room at 1280x720 and 1920x1080 (the layout scales with the viewport, no scroll).
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { HttpError, api, useNow, usePoll, type LobbyData } from "@/components/client";
import { useRoomAudio } from "@/components/tv/roomAudio";
import {
  CaptionBar,
  EndStage,
  IdleStage,
  JoinChip,
  LeaderRail,
  Leaderboard,
  LobbyStage,
  MarketStage,
  OffersCard,
  PriceChart,
  ResultReveal,
  Scorebug,
  ScorecardPanel,
  SoundToggle,
  TradeTicker,
  ranked,
  type Clock,
  type Player,
  type Ranked,
} from "@/components/tv/board";
import { Aurora, BrandLoader, Icon, Kinetic, Wordmark, withAlpha, type AuroraBlob } from "@/components/huddle";
import { loadYouTube, type YTPlayer } from "@/components/tv/youtube";

/** "#003594" + alpha -> rgba(); unknown colours fall back to the brand green. */
const hexA = (hex: string | undefined, a: number) =>
  /^#?[0-9a-f]{6}$/i.test(hex ?? "") ? withAlpha(hex!, a) : `rgba(31,214,127,${a})`;

export default function WatchPage() {
  const params = useParams<{ code: string }>();
  const code = String(params.code || "").toUpperCase();
  const [sound, setSound] = useState(false);
  // With sound on, poll a little faster than the box's speaker (700 ms) so the TV keeps time with it.
  const { data: l, error, lastOk } = usePoll(() => api<LobbyData>(`/api/lobby/${code}`), sound ? 500 : 1000);
  const now = useNow(250);
  const [playerReady, setPlayerReady] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const standings = useRef<{ code: string; rows: Ranked[] } | null>(null);
  const videoId = l?.game?.youtubeId ?? null;
  // The same sounds and announcer lines as the box's speaker, in the same order (components/tv/roomAudio.ts).
  const announcer = useRoomAudio(l, sound, l ? l.now - lastOk : 0);

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

  function toggleSound() {
    const on = !sound;
    setSound(on);
    try {
      if (on) {
        announcer.unlock();
        player.current?.unMute();
        player.current?.setVolume(100);
      } else {
        player.current?.mute();
        announcer.stop();
      }
    } catch {
      /* player not ready yet */
    }
  }

  if (!l) {
    const notFound = error instanceof HttpError && error.status === 404;
    const head = error ? (notFound ? `No game called ${code}` : "Can’t reach Huddle") : "Getting the game on screen";
    return (
      <div className="tvk tvk-state">
        <Aurora />
        <BrandLoader
          size="lg"
          spin={!error}
          className="tvk-state-body"
          label={<Kinetic text={head} />}
          detail={error ? (notFound ? "Pick a game on the box first, then open this page again." : `${error.message}. Trying again every second.`) : null}
        />
      </div>
    );
  }

  const m = l.market;
  const serverNow = now + (l.now - lastOk);
  const score = l.game?.score ?? null;
  const live = !!m && (l.phase === "open" || l.phase === "locked");
  const showResult = !!m && l.phase === "result" && (!!m.outcome || !!m.voided);
  const preGame = l.phase === "lobby" && !m && !l.parked && l.results.length === 0 && !score?.started;
  const takeover = preGame ? "lobby" : l.phase === "ended" ? "end" : null;
  const layout = takeover ? "full" : videoId ? "video" : "board";
  const players = l.players;

  // Freeze the final standings when the game ends, so cash-outs do not reshuffle the podium.
  if (l.phase === "ended") {
    if (!standings.current || standings.current.code !== code) standings.current = { code, rows: ranked(players) };
    else {
      const have = new Set(standings.current.rows.map((p) => p.id));
      const late = players.filter((p) => !have.has(p.id));
      const rows = standings.current.rows;
      if (late.length) standings.current = { code, rows: [...rows, ...ranked(late).map((p, i) => ({ ...p, rank: rows.length + i + 1, lead: false }))] };
    }
  } else if (standings.current) standings.current = null;

  const clock: Clock = (() => {
    if (!m) return { lockIn: 0, fraction: 0, state: "locked" };
    const left = m.lockAt - serverNow;
    const span = Math.max(1000, m.lockAt - m.openedAt);
    const lockIn = Math.max(0, Math.ceil(left / 1000));
    if (l.phase !== "open") return { lockIn: 0, fraction: 0, state: "locked" };
    return { lockIn, fraction: Math.max(0, left / span), state: lockIn <= 5 ? "urgent" : "open" };
  })();

  const caps = l.captions ?? [];
  const cap = caps.length ? caps.reduce((a, b) => (b.id > a.id ? b : a)) : null;
  const lastEv = l.events.length ? l.events[l.events.length - 1] : null;
  const captionText = cap?.text ?? lastEv?.text ?? null;
  const captionId = cap ? `c${cap.id}` : lastEv ? `e${lastEv.id}` : "none";

  const blobs: AuroraBlob[] | undefined = live
    ? [
        { c: hexA(l.game?.color, 0.10), x: "-14vmax", y: "-10vmax", s: "58vmax", mx: "6vmax", my: "5vmax", dur: "18s" },
        { c: "rgba(31,214,127,0.06)", x: "58vw", y: "20vh", s: "58vmax", mx: "-6vmax", my: "-5vmax", dur: "22s", d: "-5s" },
        { c: "rgba(217,179,108,0.05)", x: "20vw", y: "50vh", s: "48vmax", mx: "5vmax", my: "-4vmax", dur: "26s", d: "-9s" },
      ]
    : l.phase === "ended"
      ? [
          { c: "rgba(217,179,108,0.12)", x: "5vw", y: "-25vmax", s: "60vmax", mx: "6vmax", my: "6vmax", dur: "24s" },
          { c: "rgba(31,214,127,0.07)", x: "-15vmax", y: "35vh", s: "55vmax", mx: "8vmax", my: "-5vmax", dur: "28s", d: "-6s" },
        ]
      : undefined;

  const marketKey = m ? `${m.qIndex}:${m.openedAt}` : "none";
  let stage: React.ReactNode = null;
  let side: React.ReactNode = null;
  if (layout === "board") {
    if (live && m) stage = <MarketStage key={marketKey} l={l} m={m} clock={clock} />;
    else if (showResult && m) stage = <ResultReveal key={`r${marketKey}`} m={m} />;
    else stage = <IdleStage key={`idle${l.qIndex}`} l={l} />;
    side = (
      <>
        {m && showResult ? (
          <section className="hd-rise tv-card tv-chart-card"><PriceChart key={marketKey} m={m} /></section>
        ) : l.scorecard && l.scorecard.n > 0 ? (
          <section className="hd-rise tv-card"><ScorecardPanel card={l.scorecard} compact /></section>
        ) : null}
        {m && live && m.mode === "h2h" && <OffersCard m={m} />}
        <Leaderboard players={players} max={m && live && m.mode === "h2h" ? 4 : showResult ? 5 : 7} />
      </>
    );
  } else if (layout === "video") {
    if (live && m) side = <MarketStage key={marketKey} l={l} m={m} clock={clock} compact chart={m.mode === "h2h" ? <OffersCard m={m} compact locked={l.phase !== "open"} /> : <PriceChart key={marketKey} m={m} compact />} />;
    else if (showResult && m) side = <ResultReveal key={`r${marketKey}`} m={m} compact />;
    else side = <IdleStage key={`idle${l.qIndex}`} l={l} compact />;
  }

  const trades = m && (live || showResult) ? m.trades : [];
  const lastPlay = score?.lastPlay ?? null;

  return (
    <div className={`tvk layout-${layout}`}>
      <Aurora key={live ? "live" : l.phase === "ended" ? "end" : "calm"} blobs={blobs} className="hd-fade" />
      <header className="tv-topbar">
        <Wordmark className="tv-wordmark" lit={Math.max(1, Math.min(12, players.length))} />
        <span className="tv-title">
          <b>{l.game?.title ?? "Huddle"}</b>
          {l.game?.kind === "replay" && <span className="tv-tag">Replay</span>}
        </span>
        <span className="tv-topbar-mid">{score && <Scorebug score={score} persona={l.game?.persona} sport={l.game?.sport} league={l.game?.league} />}</span>
        {error && (
          <span className="hd-pop tv-offline" role="status"><Icon name="wifiOff" /> Reconnecting</span>
        )}
        {!preGame && <JoinChip code={l.code} joinUrl={l.joinUrl} />}
        <SoundToggle on={sound} onToggle={toggleSound} />
      </header>

      <main className="tv-main" id="main">
        {videoId && (
          <div className={`tv-video ${layout === "video" ? "" : "off"}`} aria-hidden={layout !== "video"}>
            <div className="tv-video-frame" ref={holder} />
          </div>
        )}
        {takeover === "lobby" && <LobbyStage l={l} />}
        {takeover === "end" && <EndStage l={l} standings={standings.current?.rows ?? ranked(players)} />}
        {layout === "board" && <div className="tv-stage">{stage}</div>}
        {layout !== "full" && <aside className="tv-side" aria-label="Market details">{side}</aside>}
      </main>

      {layout !== "full" && (
        <footer className="tv-rail">
          {layout === "video" ? (
            <LeaderRail players={players} />
          ) : lastPlay ? (
            <span key={lastPlay} className="hd-slide-l tv-lastplay"><span className="live-dot" aria-hidden="true" /><span>{lastPlay}</span></span>
          ) : null}
          <TradeTicker trades={trades} mode={m?.mode} />
        </footer>
      )}

      <CaptionBar
        text={captionText}
        id={captionId}
        speaking={!!cap && announcer.speakingId === cap.id}
        source={cap ? "announcer" : lastEv ? "event" : null}
      />
    </div>
  );
}
