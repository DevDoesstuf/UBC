// ElevenLabs text to speech for announcer captions (ported from Huddle packages/announcer/src/tts.ts).
//
// Endpoint (checked against the ElevenLabs API reference, Nov 18 2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128 (TV) | pcm_22050 (speaker)
//   header xi-api-key: <key>
//   body   { text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost, speed } }
//   200 -> audio/mpeg bytes, or raw PCM S16LE mono 22.05 kHz for pcm_22050 (wrapped into a WAV here)
// Model: eleven_flash_v2_5 (ElevenLabs' ~100 ms low-latency model; ELEVENLABS_TTS_MODEL overrides, e.g.
// eleven_v4_turbo). Flash leaves text normalization off by default, so lines arrive with numbers already in words
// (lib/announcer.ts toSpeech).
// Clips are cached by a hash of (voice, model, settings, text) in the store (Redis or memory) for 24 h,
// so each caption is synthesized once no matter how many TVs ask for it.
import { createHash } from "crypto";
import { kvGet, kvSet } from "./store";
import type { Persona } from "./announcer";

/** ELEVENLABS_BASE_URL overrides (a regional host such as https://api.us.elevenlabs.io, or a local mock). */
export const ELEVENLABS_BASE_URL = ((process.env.ELEVENLABS_BASE_URL || "").trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
/** For the speaker ESP32 (README: 22 kHz mono WAV): raw 16-bit PCM from ElevenLabs, wrapped in a WAV header here. */
export const TTS_WAV_FORMAT = "pcm_22050";
export type AudioFormat = "mp3" | "wav";

/**
 * 44-byte RIFF header for 16-bit mono PCM (exactly what firmware/speaker/speaker.ino parses: RIFF/WAVE, a 16-byte
 * "fmt " chunk with format 1, then "data" with its real size). An odd trailing byte (half a sample) is dropped.
 */
export function wavFromPcm(pcm: Uint8Array, sampleRate = 22050): Uint8Array {
  if (pcm.byteLength & 1) pcm = pcm.subarray(0, pcm.byteLength - 1);
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
export const MAX_TTS_CHARS = 300;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

/**
 * Stock voices from the ElevenLabs default (premade) library, never a cloned or celebrity voice:
 *   nfl    Brian   nPczCjzI2devNBz1zQrb  deep American, the play-by-play voice
 *   soccer George  JBFqnCBsd6RMkjVDRZzb  warm British, the touchline voice
 *   calm   Eric    cjVigY5qzO86Huf0OWal  friendly, even American
 * Override per persona with ELEVENLABS_VOICE_NFL / _SOCCER / _CALM (any voice id in your ElevenLabs account).
 */
const VOICES: Record<Persona, { env: string; id: string; settings: VoiceSettings }> = {
  nfl: { env: "ELEVENLABS_VOICE_NFL", id: "nPczCjzI2devNBz1zQrb", settings: { stability: 0.45, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.02 } },
  soccer: { env: "ELEVENLABS_VOICE_SOCCER", id: "JBFqnCBsd6RMkjVDRZzb", settings: { stability: 0.35, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.08 } },
  calm: { env: "ELEVENLABS_VOICE_CALM", id: "cjVigY5qzO86Huf0OWal", settings: { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.96 } },
};

export function ttsEnabled(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY || "").trim();
}

// ---- a key ElevenLabs rejects
// An invalid (or revoked, or out of quota) key answers 401/403 on every call. After one such answer we remember it
// for a few minutes, in this instance and in the store (other serverless instances), keyed by a fingerprint of the
// key (never the key itself): /api/tts answers 204 and /api/kiosk/audio lists no announcer lines, exactly as with
// no key, so the TV uses Web Speech and the speaker plays its sound effects instead of failing on every caption.
export const BAD_KEY_MS = 5 * 60_000;
let badKey: { fp: string; until: number } | null = null;

function keyFingerprint(key: string): string {
  return createHash("sha256").update(`huddle-tts|${key}`).digest("hex").slice(0, 16);
}

async function markKeyBad(key: string, now: number): Promise<void> {
  const fp = keyFingerprint(key);
  badKey = { fp, until: now + BAD_KEY_MS };
  await kvSet(`tts:badkey:${fp}`, String(now + BAD_KEY_MS), { px: BAD_KEY_MS }).catch(() => undefined);
}

/** True when the configured key was rejected by ElevenLabs in the last BAD_KEY_MS. */
export async function ttsKeyRejected(now: number = Date.now()): Promise<boolean> {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) return false;
  const fp = keyFingerprint(key);
  if (badKey && badKey.fp === fp && badKey.until > now) return true;
  const hit = await kvGet(`tts:badkey:${fp}`).catch(() => null);
  const until = hit ? Number(hit) : NaN;
  if (Number.isFinite(until) && until > now) {
    badKey = { fp, until };
    return true;
  }
  return false;
}

/** A key is set and ElevenLabs has not just rejected it: the announcer can speak. */
export async function ttsAvailable(now: number = Date.now()): Promise<boolean> {
  return ttsEnabled() && !(await ttsKeyRejected(now));
}

/** Tests: forget a rejected key. */
export async function resetTtsKeyCheck(): Promise<void> {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (badKey && key && badKey.fp === keyFingerprint(key)) await kvSet(`tts:badkey:${badKey.fp}`, "0", { px: 1 }).catch(() => undefined);
  badKey = null;
}

export function asPersona(v: unknown): Persona {
  return v === "soccer" || v === "calm" ? v : "nfl";
}

/** Text the low-latency models read well: plain ASCII-ish, single spaces, capped. */
export function speakable(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TTS_CHARS);
}

export function audioId(voiceId: string, modelId: string, settings: VoiceSettings, text: string, format: AudioFormat = "mp3"): string {
  const f = format === "wav" ? TTS_WAV_FORMAT : TTS_OUTPUT_FORMAT;
  return createHash("sha256").update([voiceId, modelId, JSON.stringify(settings), f, text].join("\u0000")).digest("hex").slice(0, 32);
}

export class TtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Synth = { audio: Uint8Array; cached: boolean; id: string; contentType: string };

// One ElevenLabs request per clip per instance: the speaker's own request for a line that /api/kiosk/audio is
// pre-warming waits for that request instead of starting a second one.
const inflight = new Map<string, Promise<Synth>>();

/** The speaker gives up on a sound download after 10 s (speaker.ino playUrl); answer well before that. */
export const WAV_TIMEOUT_MS = 8000;

/** MP3 (or, with format "wav", 22 kHz mono WAV) bytes for a line, from the cache or ElevenLabs. Throws TtsError. */
export async function synthesize(rawText: string, persona: Persona, opts: { fetch?: typeof fetch; timeoutMs?: number; format?: AudioFormat; voiceId?: string | null } = {}): Promise<Synth> {
  const format: AudioFormat = opts.format === "wav" ? "wav" : "mp3";
  const contentType = format === "wav" ? "audio/wav" : "audio/mpeg";
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) throw new TtsError(503, "ElevenLabs is not configured");
  const text = speakable(rawText);
  if (!text) throw new TtsError(400, "Nothing to say");
  const v = VOICES[persona];
  // A game can bring its own voice (games.json "voice", e.g. the Spanish-accented caller for Portugal v Spain).
  const voiceId = (opts.voiceId || "").trim() || (process.env[v.env] || "").trim() || v.id;
  const modelId = (process.env.ELEVENLABS_TTS_MODEL || "").trim() || DEFAULT_TTS_MODEL;
  const id = audioId(voiceId, modelId, v.settings, text, format);
  const cacheKey = `tts:${id}`;
  const hit = await kvGet(cacheKey).catch(() => null);
  if (hit) return { audio: new Uint8Array(Buffer.from(hit, "base64")), cached: true, id, contentType };
  if (await ttsKeyRejected()) throw new TtsError(503, "ElevenLabs rejected the API key recently; using Web Speech");
  const pending = inflight.get(id);
  if (pending) return pending;
  const job = callElevenLabs({ key, voiceId, modelId, settings: v.settings, text, format, id, contentType, cacheKey, fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? (format === "wav" ? WAV_TIMEOUT_MS : 12_000) });
  inflight.set(id, job);
  try {
    return await job;
  } finally {
    inflight.delete(id);
  }
}

/** Synthesizes a line into the cache ahead of time (the speaker asks for it a moment later). Never throws. */
export async function prewarm(text: string, persona: Persona, format: AudioFormat = "wav", voiceId?: string | null): Promise<void> {
  if (!(await ttsAvailable())) return;
  await synthesize(text, persona, { format, voiceId }).catch(() => undefined);
}

async function callElevenLabs(o: {
  key: string; voiceId: string; modelId: string; settings: VoiceSettings; text: string; format: AudioFormat; id: string; contentType: string; cacheKey: string;
  fetch?: typeof fetch; timeoutMs: number;
}): Promise<Synth> {
  const { key, voiceId, modelId, text, format, id, contentType, cacheKey } = o;
  const v = { settings: o.settings };
  const opts = { fetch: o.fetch };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
  try {
    const r = await (opts.fetch ?? fetch)(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${format === "wav" ? TTS_WAV_FORMAT : TTS_OUTPUT_FORMAT}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "xi-api-key": key, "content-type": "application/json", accept: format === "wav" ? "*/*" : "audio/mpeg" },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: v.settings }),
      cache: "no-store",
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) await markKeyBad(key, Date.now());
      let detail = "";
      try {
        const j = (await r.json()) as { detail?: unknown };
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? "").slice(0, 160);
      } catch {
        /* not JSON */
      }
      throw new TtsError(502, `ElevenLabs HTTP ${r.status}${detail ? ` (${detail})` : ""}`);
    }
    const raw = new Uint8Array(await r.arrayBuffer());
    if (!raw.byteLength) throw new TtsError(502, "ElevenLabs returned no audio");
    // pcm_22050 is raw signed 16-bit little-endian mono samples (no header): wrap it. Should ElevenLabs ever send
    // a WAV already, pass it through as is (the speaker parses any PCM WAV).
    const isWav = raw.byteLength > 12 && Buffer.from(raw.subarray(0, 4)).toString("latin1") === "RIFF";
    const audio = format === "wav" && !isWav ? wavFromPcm(raw) : raw;
    await kvSet(cacheKey, Buffer.from(audio).toString("base64"), { px: CACHE_TTL_MS }).catch(() => undefined);
    return { audio, cached: false, id, contentType };
  } catch (e) {
    if (e instanceof TtsError) throw e;
    throw new TtsError(504, ctrl.signal.aborted ? "ElevenLabs timed out" : e instanceof Error ? e.message : "ElevenLabs unreachable");
  } finally {
    clearTimeout(timer);
  }
}
