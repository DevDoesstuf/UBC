"use client";
// The announcer voice on the TV. With sound on, the newest caption is read out: the ElevenLabs line from
// /api/tts when it answers 200, otherwise the browser's own voice. One line at a time; if more arrive while a
// line is playing, only the newest waits (a backlog of stale calls is worse than a skipped one).
import { useCallback, useEffect, useRef, useState } from "react";

export type SpokenLine = { id: number; text: string };

const forSpeech = (text: string) => text.replace(/\$(\d+)\.(\d\d)/g, "$1 dollars $2").replace(/¢/g, " cents");

export function useAnnouncer(code: string, enabled: boolean) {
  const [speakingId, setSpeakingId] = useState<number | null>(null);
  const busy = useRef(false);
  const queued = useRef<SpokenLine | null>(null);
  const current = useRef<{ audio?: HTMLAudioElement; url?: string; abort?: AbortController; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  const cleanup = useCallback(() => {
    const c = current.current;
    current.current = null;
    if (!c) return;
    c.abort?.abort();
    if (c.timer) clearTimeout(c.timer);
    if (c.audio) {
      c.audio.onended = null;
      c.audio.onerror = null;
      c.audio.pause();
    }
    if (c.url) URL.revokeObjectURL(c.url);
  }, []);

  const play = useCallback(
    (line: SpokenLine) => {
      busy.current = true;
      setSpeakingId(line.id);
      const slot: NonNullable<typeof current.current> = {};
      current.current = slot;
      let done = false;
      const finish = () => {
        if (done || current.current !== slot) return;
        done = true;
        cleanup();
        busy.current = false;
        setSpeakingId(null);
        const next = queued.current;
        queued.current = null;
        if (next && enabledRef.current) play(next);
      };
      // Watchdog: some browsers never fire `end` on a long utterance.
      slot.timer = setTimeout(finish, 4000 + line.text.length * 110);
      let spoke = false;
      const speak = () => {
        if (current.current !== slot || spoke) return;
        spoke = true;
        slot.audio?.pause();
        if (typeof window === "undefined" || !("speechSynthesis" in window)) return finish();
        const u = new SpeechSynthesisUtterance(forSpeech(line.text));
        u.rate = 1.05;
        u.onend = finish;
        u.onerror = finish;
        window.speechSynthesis.speak(u);
      };
      const abort = new AbortController();
      slot.abort = abort;
      const giveUp = setTimeout(() => abort.abort(), 6000);
      fetch(`/api/tts?code=${encodeURIComponent(code)}&id=${line.id}`, { signal: abort.signal, cache: "force-cache" })
        .then(async (r) => {
          clearTimeout(giveUp);
          if (current.current !== slot) return;
          if (r.status !== 200) return speak();
          const blob = await r.blob();
          if (current.current !== slot) return;
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          slot.audio = audio;
          slot.url = url;
          audio.onended = finish;
          audio.onerror = () => speak();
          await audio.play().catch(() => speak());
        })
        .catch(() => {
          clearTimeout(giveUp);
          speak();
        });
    },
    [code, cleanup],
  );

  /** Read a caption (only while sound is on). */
  const say = useCallback(
    (line: SpokenLine) => {
      if (!enabledRef.current) return;
      if (busy.current) queued.current = line;
      else play(line);
    },
    [play],
  );

  /** Stop talking now and forget the queue. */
  const stop = useCallback(() => {
    queued.current = null;
    cleanup();
    busy.current = false;
    setSpeakingId(null);
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [cleanup]);

  useEffect(() => stop, [stop]);
  return { speakingId, say, stop };
}
