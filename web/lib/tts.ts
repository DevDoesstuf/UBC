// ElevenLabs text to speech for announcer captions (ported from Huddle packages/announcer/src/tts.ts).
//
// Endpoint (checked against the ElevenLabs API reference, Nov 2026):
//   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128
//   header xi-api-key: <key>
//   body   { text, model_id, voice_settings: { stability, similarity_boost, style, use_speaker_boost, speed } }
//   200 -> audio/mpeg bytes
// Clips are cached by a hash of (voice, model, settings, text) in the store (Redis or memory) for 24 h,
// so each caption is synthesized once no matter how many TVs ask for it.
import { createHash } from "crypto";
import { kvGet, kvSet } from "./store";
import type { Persona } from "./announcer";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";
export const TTS_OUTPUT_FORMAT = "mp3_44100_128";
export const MAX_TTS_CHARS = 300;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface VoiceSettings {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
  speed: number;
}

/** Stock voices from the ElevenLabs default library (never a cloned or celebrity voice). Override with env vars. */
const VOICES: Record<Persona, { env: string; id: string; settings: VoiceSettings }> = {
  nfl: { env: "ELEVENLABS_VOICE_NFL", id: "nPczCjzI2devNBz1zQrb", settings: { stability: 0.45, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.02 } },
  soccer: { env: "ELEVENLABS_VOICE_SOCCER", id: "JBFqnCBsd6RMkjVDRZzb", settings: { stability: 0.35, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 1.08 } },
  calm: { env: "ELEVENLABS_VOICE_CALM", id: "cjVigY5qzO86Huf0OWal", settings: { stability: 0.7, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 0.96 } },
};

export function ttsEnabled(): boolean {
  return !!(process.env.ELEVENLABS_API_KEY || "").trim();
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

export function audioId(voiceId: string, modelId: string, settings: VoiceSettings, text: string): string {
  return createHash("sha256").update([voiceId, modelId, JSON.stringify(settings), TTS_OUTPUT_FORMAT, text].join("\u0000")).digest("hex").slice(0, 32);
}

export class TtsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** MP3 bytes for a line, from the cache or ElevenLabs. Throws TtsError. */
export async function synthesize(rawText: string, persona: Persona, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ audio: Uint8Array; cached: boolean; id: string }> {
  const key = (process.env.ELEVENLABS_API_KEY || "").trim();
  if (!key) throw new TtsError(503, "ElevenLabs is not configured");
  const text = speakable(rawText);
  if (!text) throw new TtsError(400, "Nothing to say");
  const v = VOICES[persona];
  const voiceId = (process.env[v.env] || "").trim() || v.id;
  const modelId = (process.env.ELEVENLABS_TTS_MODEL || "").trim() || DEFAULT_TTS_MODEL;
  const id = audioId(voiceId, modelId, v.settings, text);
  const cacheKey = `tts:${id}`;
  const hit = await kvGet(cacheKey).catch(() => null);
  if (hit) return { audio: new Uint8Array(Buffer.from(hit, "base64")), cached: true, id };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000);
  try {
    const r = await (opts.fetch ?? fetch)(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${TTS_OUTPUT_FORMAT}`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: modelId, voice_settings: v.settings }),
      cache: "no-store",
    });
    if (!r.ok) {
      let detail = "";
      try {
        const j = (await r.json()) as { detail?: unknown };
        detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? "").slice(0, 160);
      } catch {
        /* not JSON */
      }
      throw new TtsError(502, `ElevenLabs HTTP ${r.status}${detail ? ` (${detail})` : ""}`);
    }
    const audio = new Uint8Array(await r.arrayBuffer());
    if (!audio.byteLength) throw new TtsError(502, "ElevenLabs returned no audio");
    await kvSet(cacheKey, Buffer.from(audio).toString("base64"), { px: CACHE_TTL_MS }).catch(() => undefined);
    return { audio, cached: false, id };
  } catch (e) {
    if (e instanceof TtsError) throw e;
    throw new TtsError(504, ctrl.signal.aborted ? "ElevenLabs timed out" : e instanceof Error ? e.message : "ElevenLabs unreachable");
  } finally {
    clearTimeout(timer);
  }
}
