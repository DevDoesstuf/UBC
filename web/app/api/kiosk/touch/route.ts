// POST /api/kiosk/touch  body {"kiosk":"1","id":"<button or tile id>"}  -> the new screen.
// On a refused action it still returns the current screen, plus "error", so the kiosk can show the message.
// Optional: {"mode":"market"|"pool"|"h2h"} with a game:<id> tap sets the new lobby's trading mode (the ESP32
// never sends it; the web kiosk or a host screen can).
import { baseUrl, checkKioskKey, json, readBody } from "@/lib/http";
import { kioskScreen, kioskTouch } from "@/lib/kiosk";
import { ApiError, getKioskCode, mutate, normKiosk, parseMode, setMode } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await readBody(req);
  const kiosk = normKiosk((body.kiosk as string) ?? new URL(req.url).searchParams.get("kiosk"));
  try {
    checkKioskKey(req);
    const id = String(body.id ?? "");
    const screen = await kioskTouch(kiosk, id, baseUrl(req));
    const mode = parseMode(body.mode);
    if (mode && id.startsWith("game:")) {
      const code = await getKioskCode(kiosk);
      if (code) await mutate(code, (l) => setMode(l, mode));
    }
    return json(screen);
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 500;
    const error = e instanceof Error ? e.message : String(e);
    if (status === 500) console.error("[kiosk touch]", error);
    const screen = await kioskScreen(kiosk, baseUrl(req)).catch(() => null);
    return json({ ...(screen ?? {}), error }, status);
  }
}
