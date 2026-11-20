"use client";
// The TV's sound, mirrored on the box's speaker ESP32. The speaker walks lib/speaker.ts's queue (every event sound,
// then the announcer's line for it) one item at a time, skipping anything stale. With sound on, the TV builds the
// very same queue from the lobby it already polls and walks it with the same rules (nextForSpeaker). It plays
// the same files (the sport's whistle, drums or buzzer, and the same cached ElevenLabs WAV for each line) in
// the same order at about the same moment, so the box and the TV say the same thing together.
//
// Playback goes through one Web Audio context, unlocked by the "Turn sound on" click. Safari blocks any
// `new Audio().play()` made later, outside a click, which used to leave the TV silent. If a line has no
// ElevenLabs audio (204, no key), the browser's own voice reads it instead.
import { useCallback, useEffect, useRef, useState } from "react";
import { nextForSpeaker, soundFile, speakerQueue, voiceToPrewarm, type SpeakerItem, type SpeakerSource } from "@/lib/speaker";
import type { SoundName } from "@/lib/types";

const forSpeech = (text: string) => text.replace(/\$(\d+)\.(\d\d)/g, "$1 dollars $2").replace(/¢/g, " cents");
const PRELOAD: SoundName[] = ["start", "lock", "lastcall", "win", "lose", "siren", "cheer", "tap"];
const MAX_VOICE_BUFFERS = 24;

type Ctx = AudioContext;
type Ctor = typeof AudioContext;

export function useRoomAudio(l: (SpeakerSource & { game?: { sport?: string | null } | null }) | null, enabled: boolean, clockOffset: number) {
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const ctx = useRef<Ctx | null>(null);
  const after = useRef(-1);
  const busy = useRef(false);
  const gen = useRef(0);
  const items = useRef<SpeakerItem[]>([]);
  const offset = useRef(clockOffset);
  const enabledRef = useRef(enabled);
  const buffers = useRef(new Map<string, Promise<AudioBuffer | null>>());
  const stopNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    offset.current = clockOffset;
    enabledRef.current = enabled;
  });

  const load = useCallback((url: string): Promise<AudioBuffer | null> => {
    const c = ctx.current;
    if (!c) return Promise.resolve(null);
    const hit = buffers.current.get(url);
    if (hit) return hit;
    const p = fetch(url, { cache: "force-cache" })
      .then((r) => (r.status === 200 ? r.arrayBuffer() : null))
      .then((b) => (b ? c.decodeAudioData(b) : null))
      .catch(() => null);
    buffers.current.set(url, p);
    // Voice lines are one-offs: keep the newest few (the sounds are reused all game).
    const voices = [...buffers.current.keys()].filter((k) => !k.startsWith("/sounds/"));
    for (const k of voices.slice(0, Math.max(0, voices.length - MAX_VOICE_BUFFERS))) buffers.current.delete(k);
    return p;
  }, []);

  const playBuffer = useCallback((buf: AudioBuffer) => {
    const c = ctx.current!;
    return new Promise<void>((done) => {
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        clearTimeout(watchdog);
        stopNow.current = null;
        done();
      };
      const watchdog = setTimeout(finish, buf.duration * 1000 + 800);
      src.onended = finish;
      stopNow.current = () => {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        finish();
      };
      src.start();
    });
  }, []);

  const speak = useCallback((text: string) => {
    return new Promise<void>((done) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return done();
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        clearTimeout(watchdog);
        stopNow.current = null;
        done();
      };
      const watchdog = setTimeout(finish, 3000 + text.length * 110);
      const u = new SpeechSynthesisUtterance(forSpeech(text));
      u.rate = 1.05;
      u.onend = finish;
      u.onerror = finish;
      stopNow.current = () => {
        window.speechSynthesis.cancel();
        finish();
      };
      window.speechSynthesis.speak(u);
    });
  }, []);

  /** Play whatever the speaker would play next, one item at a time, until nothing fresh is left. */
  const pump = useCallback(async () => {
    if (busy.current || !enabledRef.current || !ctx.current) return;
    const g = gen.current;
    busy.current = true;
    try {
      if (ctx.current.state === "suspended") ctx.current.resume().catch(() => {});
      for (;;) {
        const now = Date.now() + offset.current;
        const { reply, item } = nextForSpeaker(items.current, after.current, now);
        after.current = reply.id;
        if (!item) break;
        const warm = voiceToPrewarm(items.current, item, now);
        if (warm) load(warm.url);
        const buf = await load(item.url);
        if (g !== gen.current) return;
        // Fetching a fresh line can take a moment; the speaker would have skipped it by now too.
        if (Date.now() + offset.current - item.id > item.ttl + 2000) continue;
        if (item.kind === "voice") setSpeakingId(item.id);
        if (buf) await playBuffer(buf);
        else if (item.kind === "voice") await speak(item.text);
        if (g !== gen.current) return;
        if (item.kind === "voice") setSpeakingId(null);
      }
    } finally {
      if (g === gen.current) busy.current = false;
    }
  }, [load, playBuffer, speak]);

  // New lobby data: rebuild the speaker's queue, start fetching fresh voice lines, play what is due.
  const sport = l?.game?.sport ?? null;
  useEffect(() => {
    if (!l) return;
    items.current = speakerQueue(l, "", true, sport);
    if (!enabled || !ctx.current) return;
    const now = Date.now() + offset.current;
    for (const i of items.current) if (i.kind === "voice" && i.id > after.current && now - i.id <= i.ttl) load(i.url);
    pump();
  }, [l, sport, enabled, load, pump]);

  /** Call from the "Turn sound on" click: unlocks audio (Safari needs the click), remembers the latest item. */
  const unlock = useCallback(() => {
    if (typeof window === "undefined") return;
    const W = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    const AC = W.AudioContext ?? W.webkitAudioContext;
    if (!AC) return;
    if (!ctx.current) ctx.current = new AC();
    ctx.current.resume().catch(() => {});
    // A silent blip inside the click keeps iOS/Safari from muting the context.
    const blip = ctx.current.createBuffer(1, 1, 22050);
    const s = ctx.current.createBufferSource();
    s.buffer = blip;
    s.connect(ctx.current.destination);
    s.start();
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    // Like the speaker at boot: nothing already said is replayed.
    after.current = items.current.length ? items.current[items.current.length - 1].id : 0;
    for (const name of PRELOAD) load(`/sounds/${soundFile(name, sport)}`);
    load(`/sounds/tap.wav`).then((b) => {
      const c = ctx.current;
      if (!b || !c) return;
      const t = c.createBufferSource();
      t.buffer = b;
      t.connect(c.destination);
      t.start();
    });
  }, [load, sport]);

  /** Sound off: stop now and forget the queue. */
  const stop = useCallback(() => {
    gen.current++;
    busy.current = false;
    stopNow.current?.();
    stopNow.current = null;
    setSpeakingId(null);
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => stop, [stop]);
  return { speakingId, unlock, stop };
}
