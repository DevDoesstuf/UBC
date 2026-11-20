"use client";
// The box's speaker, in the browser: the /kiosk preview plays exactly what the speaker ESP32 plays
// (firmware/speaker/speaker.ino). Same endpoint, same loop: GET /api/kiosk/audio?kiosk=<id>&after=<last id>, play the
// item's WAV (the sport's sound effects and the ElevenLabs announcer line), ask again as soon as it ends, otherwise every
// 700 ms. Starting at after=-1 means nothing already said is replayed.
//
// Sound is on by default. A browser only lets a page play sound after a click or key press on it (unless it allows
// autoplay), so until then the page shows "Tap for sound" and skips what comes in (no backlog to catch up on); the
// first tap anywhere turns it on. ?sound=0 turns it off.
import { useEffect, useRef, useState } from "react";

const POLL_MS = 700;

type Ctor = typeof AudioContext;
type Reply = { id: number; url: string | null; kind?: "sound" | "voice" };

export function useKioskSpeaker(kiosk: string | null, headers: Record<string, string>, enabled: boolean) {
  const [blocked, setBlocked] = useState(false);
  const ctx = useRef<AudioContext | null>(null);
  const headersRef = useRef(headers);
  useEffect(() => {
    headersRef.current = headers;
  });

  // One audio context; resumed by the first tap or key press if the browser started it suspended.
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const W = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const AC = W.AudioContext ?? W.webkitAudioContext;
    if (!AC) return;
    const c = new AC();
    ctx.current = c;
    const sync = () => setBlocked(c.state !== "running");
    c.onstatechange = sync;
    c.resume().then(sync, sync);
    sync();
    const unlock = () => {
      c.resume().then(sync, sync);
      const s = c.createBufferSource();
      s.buffer = c.createBuffer(1, 1, 22050);
      s.connect(c.destination);
      s.start();
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      c.onstatechange = null;
      c.close().catch(() => {});
      ctx.current = null;
    };
  }, [enabled]);

  // The speaker's loop.
  useEffect(() => {
    if (!enabled || !kiosk) return;
    let alive = true;
    let after = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let source: AudioBufferSourceNode | null = null;

    const play = (url: string) =>
      new Promise<void>((done) => {
        const c = ctx.current;
        if (!c || c.state !== "running") return done();
        fetch(url, { cache: "force-cache" })
          .then((r) => (r.status === 200 ? r.arrayBuffer() : null))
          .then((b) => (b ? c.decodeAudioData(b) : null))
          .then((buf) => {
            if (!buf || !alive || c.state !== "running") return done();
            const s = c.createBufferSource();
            s.buffer = buf;
            s.connect(c.destination);
            source = s;
            const watchdog = setTimeout(finish, buf.duration * 1000 + 1000);
            function finish() {
              clearTimeout(watchdog);
              if (source === s) source = null;
              done();
            }
            s.onended = finish;
            s.start();
          })
          .catch(() => done());
      });

    const loop = async () => {
      let next = POLL_MS;
      try {
        const q = `/api/kiosk/audio?kiosk=${encodeURIComponent(kiosk)}&after=${after}`;
        const r = await fetch(q, { headers: headersRef.current, cache: "no-store" });
        if (r.ok) {
          const reply = (await r.json()) as Reply;
          after = reply.id;
          if (reply.url && alive) {
            // Same origin as this page (the server's base URL can differ behind a proxy).
            const u = new URL(reply.url, window.location.href);
            await play(u.origin === window.location.origin ? u.pathname + u.search : reply.url);
            next = 0;
          }
        }
      } catch {
        next = 2000;
      }
      if (alive) timer = setTimeout(loop, next);
    };
    loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      try {
        source?.stop();
      } catch {
        /* already stopped */
      }
    };
  }, [kiosk, enabled]);

  return { blocked };
}
