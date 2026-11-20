// GET /api/tts?text=<line>&persona=nfl|soccer|calm      -> audio/mpeg (ElevenLabs), cached by hash
// GET /api/tts?code=ABCD&id=<caption id>                -> the same for one of the lobby's captions (persona from the game)
// &format=wav                                            -> 22 kHz mono 16-bit WAV (the speaker ESP32's format) instead of MP3
// 204 (no body) when ELEVENLABS_API_KEY is not set, or ElevenLabs rejected it (401/403) in the last 5 minutes: the TV
// then reads the caption with the browser's Web Speech.
// 502/504 when ElevenLabs fails: also fall back to Web Speech.
import { handle, json } from "@/lib/http";
import { ApiError, getLobby, personaOf, voiceOf } from "@/lib/lobby";
import { MAX_TTS_CHARS, TtsError, asPersona, synthesize, ttsEnabled, ttsKeyRejected } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    if (!ttsEnabled()) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "x-tts": "off" } });
    // ElevenLabs rejected the key a moment ago (401/403): behave as if there were no key for a few minutes.
    if (await ttsKeyRejected()) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "x-tts": "rejected-key" } });
    const q = new URL(req.url).searchParams;
    let text = (q.get("text") || "").trim();
    let persona = asPersona(q.get("persona"));
    let voiceId: string | null = null;
    const code = q.get("code");
    if (code) {
      const l = await getLobby(code);
      if (!l) throw new ApiError(404, "Lobby not found");
      // An id names one caption (the URL is cached as immutable, so it must never answer with another line);
      // without an id, the newest caption.
      const idParam = q.get("id");
      const caps = l.captions ?? [];
      const cap = idParam ? caps.find((c) => c.id === Number(idParam)) : caps[caps.length - 1];
      if (!cap) throw new ApiError(404, idParam ? "No caption with that id (it may have rolled off)" : "No caption yet");
      // The spoken version (short, numbers in words); older lobbies only have the screen text.
      text = cap.say || cap.text;
      if (!q.get("persona")) {
        persona = personaOf(l);
        voiceId = voiceOf(l);
      }
    }
    if (!text) throw new ApiError(400, "Pass text or code+id");
    if (text.length > MAX_TTS_CHARS) throw new ApiError(400, `Keep it under ${MAX_TTS_CHARS} characters`);
    try {
      const { audio, cached, id, contentType } = await synthesize(text, persona, { format: q.get("format") === "wav" ? "wav" : "mp3", voiceId });
      return new Response(Buffer.from(audio), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(audio.byteLength),
          // Same text -> same audio: let browsers and the CDN keep it.
          "Cache-Control": "public, max-age=86400, immutable",
          "x-tts-cache": cached ? "hit" : "miss",
          "x-tts-id": id,
        },
      });
    } catch (e) {
      if (e instanceof TtsError) return json({ error: e.message, fallback: "webspeech" }, e.status);
      throw e;
    }
  });
}
