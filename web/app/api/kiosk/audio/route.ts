// Speaker ESP32 (firmware/speaker/speaker.ino). GET /api/kiosk/audio?kiosk=1&after=<last id played>
//   after=-1 (at boot)  -> {"id": <latest id>, "url": null}   remember id, play nothing
//   new sound waiting   -> {"id": 1731900000123, "url": "https://.../sounds/win.wav", "text": "YES! Sam wins $3.20", "kind": "sound"}
//   nothing new         -> {"id": <after, or past skipped stale items>, "url": null}
// Ids only ever increase (they are timestamps), even across games. Event sounds are 22 kHz mono 16-bit WAV
// (lastcall.wav is 8 kHz to stay small); the speaker switches rate per file.
//
// With ELEVENLABS_API_KEY set, the announcer speaks too: every caption is also an item, url =
// /api/tts?code=..&id=<caption id>&format=wav (ElevenLabs, 22 kHz mono WAV, cached), so the speaker plays the
// sound effect of an event and then the announcer's line. Without a key, or while ElevenLabs is rejecting the key
// (lib/tts.ts ttsAvailable), only the sound effects play.
//
// Ordering, skipping stale items when the speaker falls behind, and pre-warming: lib/speaker.ts.
import { after as afterResponse } from "next/server";
import { baseUrl, handle, json } from "@/lib/http";
import { getKioskLobby, normKiosk, personaOf, sportOf, voiceOf } from "@/lib/lobby";
import { nextForSpeaker, speakerQueue, voiceToPrewarm } from "@/lib/speaker";
import { getGame } from "@/lib/games";
import { prewarm, ttsAvailable } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const q = new URL(req.url).searchParams;
    const kiosk = normKiosk(q.get("kiosk"));
    const after = Number(q.get("after") ?? -1);
    // The speaker waits on this answer: never on a Gemini quote (the lobby's timers still run).
    const l = await getKioskLobby(kiosk, { gemini: false });
    const voice = !!l && (await ttsAvailable());
    const items = speakerQueue(l, baseUrl(req), voice, l ? sportOf(getGame(l.gameId)) : null);
    const now = Date.now();
    const { reply, item } = nextForSpeaker(items, after, now);
    // While the speaker plays this item, synthesize the next voice line so it is cached when the speaker asks.
    const warm = l ? voiceToPrewarm(items, item, now) : null;
    if (l && warm) {
      const cap = l.captions?.find((c) => c.id === warm.id);
      const persona = personaOf(l);
      if (cap) {
        try {
          afterResponse(() => prewarm(cap.say || cap.text, persona, "wav", voiceOf(l)));
        } catch {
          /* outside a request (tests): skip the pre-warm */
        }
      }
    }
    return json(reply);
  });
}
