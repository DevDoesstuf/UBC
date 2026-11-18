// GET /api/lobby/ABCD  (header x-player-token optional) -> the lobby as phones and the watch page see it.
import { baseUrl, handle, json, playerToken } from "@/lib/http";
import { ApiError, BUY_OPTIONS, MAX_BUY, MIN_BUY, getLobby, publicView } from "@/lib/lobby";
import { moneyInfo } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found. Pick a game on the kiosk to start a new one.");
    return json({
      ...publicView(l, playerToken(req), baseUrl(req)),
      money: moneyInfo(),
      buy: { options: BUY_OPTIONS, min: MIN_BUY, max: MAX_BUY },
    });
  });
}
