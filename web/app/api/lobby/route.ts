// POST /api/lobby  {"game":"nfl-replay","kiosk":"1","mode":"pool"}  -> {"ok":true,"code":"ABCD","mode":"pool"}
// Same as tapping a game tile on the kiosk, plus an optional trading mode (market | pool | h2h; default:
// the game's `mode` in config/games.json, else market). Needs x-kiosk-key when KIOSK_KEY is set.
import { checkKioskKey, handle, json, readBody } from "@/lib/http";
import { ApiError, createLobby, getKioskCode, getLobby, normKiosk, parseMode } from "@/lib/lobby";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handle(async () => {
    checkKioskKey(req);
    const body = await readBody(req);
    const kiosk = normKiosk(body.kiosk as string);
    const gameId = String(body.game ?? body.gameId ?? "");
    if (!gameId) throw new ApiError(400, "Pass game");
    if (body.mode !== undefined && !parseMode(body.mode)) throw new ApiError(400, "mode must be market, pool or h2h");
    const current = await getKioskCode(kiosk);
    const running = current ? await getLobby(current) : null;
    if (running && running.phase !== "ended") throw new ApiError(400, `Kiosk ${kiosk} is already running lobby ${running.code}`);
    const l = await createLobby(kiosk, gameId, parseMode(body.mode));
    return json({ ok: true, code: l.code, kiosk, mode: l.mode });
  });
}
