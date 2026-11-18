// Speaker ESP32 (not built yet). GET /api/kiosk/audio?kiosk=1&after=<last id played>
//   after=-1 (at boot)  -> {"id": <latest id>, "url": null}   remember id, play nothing
//   new sound waiting   -> {"id": 1731900000123, "url": "https://.../sounds/win.wav", "text": "YES! Sam wins $3.20"}
//   nothing new         -> {"id": <after>, "url": null}
// Ids only ever increase (they are timestamps), even across games. Sounds are 22 kHz mono WAV in public/sounds.
import { baseUrl, handle, json } from "@/lib/http";
import { getKioskLobby, normKiosk } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(async () => {
    const q = new URL(req.url).searchParams;
    const kiosk = normKiosk(q.get("kiosk"));
    const after = Number(q.get("after") ?? -1);
    const l = await getKioskLobby(kiosk);
    const withSound = (l?.events ?? []).filter((e) => e.sound);
    const latest = withSound.length ? withSound[withSound.length - 1].id : 0;
    if (!Number.isFinite(after) || after < 0) return json({ id: latest, url: null });
    const next = withSound.find((e) => e.id > after);
    if (!next) return json({ id: after, url: null });
    return json({ id: next.id, url: `${baseUrl(req)}/sounds/${next.sound}.wav`, text: next.text });
  });
}
