// Speaker ESP32. GET /api/kiosk/audio?kiosk=1&after=<last id played>
//   after=-1 (at boot)  -> {"id": <latest id>, "url": null}   remember id, play nothing
//   new sound waiting   -> {"id": 1731900000123, "url": "https://.../sounds/win.wav", "text": "YES! Sam wins $3.20"}
//   nothing new         -> {"id": <after>, "url": null}
// Ids only ever increase (they are timestamps), even across games. Sounds are 22 kHz mono WAV.
//
// With ELEVENLABS_API_KEY set, the announcer speaks too: every caption is also a sound, with
// url = /api/tts?code=..&id=<caption id>&format=wav (ElevenLabs, 22 kHz mono WAV, cached), so the speaker plays
// the sound effect of an event and then the announcer's line. Without a key, or while ElevenLabs is rejecting the
// key (lib/tts.ts ttsAvailable), this is exactly the old behaviour.
import { baseUrl, handle, json } from "@/lib/http";
import { getKioskLobby, normKiosk } from "@/lib/lobby";
import { ttsAvailable } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const q = new URL(req.url).searchParams;
    const kiosk = normKiosk(q.get("kiosk"));
    const after = Number(q.get("after") ?? -1);
    const l = await getKioskLobby(kiosk);
    const base = baseUrl(req);
    const items: { id: number; url: string; text: string }[] = (l?.events ?? [])
      .filter((e) => e.sound)
      .map((e) => ({ id: e.id, url: `${base}/sounds/${e.sound}.wav`, text: e.text }));
    // No key, or a key ElevenLabs just rejected (401/403, remembered a few minutes): sound effects only.
    if (l && (await ttsAvailable())) {
      for (const c of l.captions ?? []) {
        items.push({ id: c.id, url: `${base}/api/tts?code=${l.code}&id=${c.id}&format=wav`, text: c.text });
      }
    }
    items.sort((a, b) => a.id - b.id);
    const latest = items.length ? items[items.length - 1].id : 0;
    if (!Number.isFinite(after) || after < 0) return json({ id: latest, url: null });
    const next = items.find((e) => e.id > after);
    if (!next) return json({ id: after, url: null });
    return json(next);
  });
}
