// What the speaker ESP32 plays next (firmware/speaker/speaker.ino, via GET /api/kiosk/audio). Pure module.
//
// The queue is every lobby event that has a sound (web/public/sounds/<sound>.wav) plus, when the announcer can
// speak (ELEVENLABS_API_KEY set and not just rejected), every caption as a voice line (/api/tts ... &format=wav).
// Items are ordered by id. Ids are millisecond timestamps of when the item was made and only ever increase
// (events and captions share one counter, across games too), and a caption is always made right after the event
// it narrates, so the speaker hears the sound effect first and then the announcer's line.
//
// The speaker blocks while it plays (a voice line is 2-5 s), so it can fall behind a busy game. Rule, applied on
// every poll, deterministic: the next item is the oldest one newer than `after` that is still fresh; anything
// older than its time-to-live is skipped (and the speaker's `after` moves past it). Time-to-live: 8 s for voice
// lines and sound effects, 1.2 s for the last-call tick (it must end at the lock, so late = pointless). And a
// voice line more than 2.5 s late is skipped when a newer voice line is already waiting ("Nine seconds!" for a
// market that has locked since is wrong, and the newer line says what matters now). Sound effects are short
// (under 1.3 s) and always play while fresh. The backlog is therefore never more than about 8 s, the announcer
// stays close to live, and nothing old is ever replayed.
import type { Lobby, SoundName } from "./types";

export const VOICE_TTL_MS = 8000;
export const SOUND_TTL_MS = 8000;
export const LASTCALL_TTL_MS = 1200;
export const CATCHUP_MS = 2500;

export interface SpeakerItem {
  id: number;
  url: string;
  /** What the serial log prints: the event text, or the spoken line. */
  text: string;
  kind: "sound" | "voice";
  sound?: SoundName;
  ttl: number;
}

/** Sounds that have a version per sport (public/sounds/<sound>-<sport>.wav): the whistle, the drums, the buzzer. */
const SPORT_SOUNDS: Partial<Record<SoundName, string[]>> = {
  start: ["soccer", "nfl", "nba"],
  lock: ["soccer", "nfl", "nba"],
  siren: ["soccer", "nfl", "nba"],
  cheer: ["soccer", "nfl", "nba"],
};

/** The file for `sound` in a game of `sport`, e.g. soundFile("start", "soccer") = "start-soccer.wav" (the kickoff whistle). */
export function soundFile(sound: SoundName, sport?: string | null): string {
  return sport && SPORT_SOUNDS[sound]?.includes(sport) ? `${sound}-${sport}.wav` : `${sound}.wav`;
}

export function speakerQueue(l: Lobby | null, base: string, voice: boolean, sport?: string | null): SpeakerItem[] {
  if (!l) return [];
  const items: SpeakerItem[] = [];
  for (const e of l.events ?? []) {
    if (!e.sound) continue;
    items.push({ id: e.id, url: `${base}/sounds/${soundFile(e.sound, sport)}`, text: e.text, kind: "sound", sound: e.sound, ttl: e.sound === "lastcall" ? LASTCALL_TTL_MS : SOUND_TTL_MS });
  }
  if (voice) {
    for (const c of l.captions ?? []) {
      items.push({ id: c.id, url: `${base}/api/tts?code=${l.code}&id=${c.id}&format=wav`, text: c.say || c.text, kind: "voice", ttl: VOICE_TTL_MS });
    }
  }
  return items.sort((a, b) => a.id - b.id);
}

export type SpeakerReply = { id: number; url: null } | { id: number; url: string; text: string; kind: "sound" | "voice" };

/**
 * The answer to one poll. after < 0 (boot): the latest id, nothing to play. Otherwise the next fresh item, or
 * {id, url: null} where id is past every skipped (stale) item so the speaker never asks about them again.
 */
export function nextForSpeaker(items: SpeakerItem[], after: number, now: number): { reply: SpeakerReply; item: SpeakerItem | null } {
  const latest = items.length ? items[items.length - 1].id : 0;
  if (!Number.isFinite(after) || after < 0) return { reply: { id: latest, url: null }, item: null };
  const newer = items.filter((i) => i.id > after);
  const next = newer.find((i, k) => {
    const age = now - i.id;
    if (age > i.ttl) return false;
    // Catching up: a voice line that is already late is dropped when a newer one is waiting behind it.
    if (i.kind === "voice" && age > CATCHUP_MS && newer.slice(k + 1).some((j) => j.kind === "voice")) return false;
    return true;
  });
  if (!next) return { reply: { id: newer.length ? Math.max(after, newer[newer.length - 1].id) : after, url: null }, item: null };
  return { reply: { id: next.id, url: next.url, text: next.text, kind: next.kind }, item: next };
}

/** The voice line to synthesize ahead of time while the speaker plays `item`: the next voice item after it. */
export function voiceToPrewarm(items: SpeakerItem[], item: SpeakerItem | null, now: number): SpeakerItem | null {
  if (!item) return null;
  return items.find((i) => i.id > item.id && i.kind === "voice" && now - i.id <= i.ttl) ?? null;
}
