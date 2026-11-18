// POST /api/lobby/ABCD/mode  {"mode":"market"|"pool"|"h2h"}
// Sets how the next questions trade (between questions only). Like kiosk taps, it needs x-kiosk-key when
// KIOSK_KEY is set, so only the host's screens can change it.
import { checkKioskKey, handle, json, readBody } from "@/lib/http";
import { ApiError, mutate, parseMode, setMode } from "@/lib/lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    checkKioskKey(req);
    const { code } = await params;
    const body = await readBody(req);
    const mode = parseMode(body.mode);
    if (!mode) throw new ApiError(400, "mode must be market, pool or h2h");
    const l = await mutate(code, (lobby) => setMode(lobby, mode));
    return json({ ok: true, mode: l.mode });
  });
}
