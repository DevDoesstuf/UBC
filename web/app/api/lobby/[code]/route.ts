// GET /api/lobby/ABCD  (header x-player-token optional) -> the lobby as phones and the watch page see it.
// SETTLEMENT=vault: a read also nudges the vault (credited deposits to sweep, an ended game to settle on chain),
// after the response is sent and at most every 5 s per lobby.
import { baseUrl, handle, json, playerToken } from "@/lib/http";
import { ApiError, BUY_OPTIONS, MAX_BUY, MIN_BUY, getLobby, publicView } from "@/lib/lobby";
import { moneyInfo } from "@/lib/money";
import { kickVault, vaultNeedsWork } from "@/lib/vault";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found. Pick a game on the kiosk to start a new one.");
    if (vaultNeedsWork(l)) await kickVault(l.code).catch(() => undefined);
    return json({
      ...publicView(l, playerToken(req), baseUrl(req)),
      money: moneyInfo(l),
      buy: { options: BUY_OPTIONS, min: MIN_BUY, max: MAX_BUY },
    });
  });
}
