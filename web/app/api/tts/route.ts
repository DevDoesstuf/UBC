// GET /api/tts?text=<line>&persona=nfl|soccer|calm      -> audio/mpeg (ElevenLabs), cached by hash
// GET /api/tts?code=ABCD&id=<caption id>                -> the same for one of the lobby's captions (persona from the game)
// 204 (no body) when ELEVENLABS_API_KEY is not set: the TV then reads the caption with the browser's Web Speech.
// 502/504 when ElevenLabs fails: also fall back to Web Speech.
import { handle, json } from "@/lib/http";
import { ApiError, getLobby, personaOf } from "@/lib/lobby";
import { MAX_TTS_CHARS, TtsError, asPersona, synthesize, ttsEnabled } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    if (!ttsEnabled()) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "x-tts": "off" } });
    const q = new URL(req.url).searchParams;
    let text = (q.get("text") || "").trim();
    let persona = asPersona(q.get("persona"));
    const code = q.get("code");
    if (code) {
      const l = await getLobby(code);
      if (!l) throw new ApiError(404, "Lobby not found");
      const id = Number(q.get("id"));
      const cap = (l.captions ?? []).find((c) => c.id === id) ?? (l.captions ?? [])[l.captions!.length - 1];
      if (!cap) throw new ApiError(404, "No caption yet");
      text = cap.text;
      if (!q.get("persona")) persona = personaOf(l);
    }
    if (!text) throw new ApiError(400, "Pass text or code+id");
    if (text.length > MAX_TTS_CHARS) throw new ApiError(400, `Keep it under ${MAX_TTS_CHARS} characters`);
    try {
      const { audio, cached, id } = await synthesize(text, persona);
      return new Response(Buffer.from(audio), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
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
