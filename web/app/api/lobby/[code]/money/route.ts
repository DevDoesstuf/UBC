// POST /api/lobby/ABCD/money  {"mode":"demo"|"solana"|"toggle"}
// Picks the money this game plays (lobby phase only, before anyone has paid in): demo money, or test USDC on
// Solana where the server offers it (MONEY_MODE=solana configured). Like /mode it needs x-kiosk-key when
// KIOSK_KEY is set, so only the host's screens can change it.
// -> {"ok":true,"money":{mode,offered,locked,...}}   400 "Money is already in: start a new game to switch"
import { checkKioskKey, handle, json, readBody } from "@/lib/http";
import { ApiError, mutate, parseMoney, setMoney } from "@/lib/lobby";
import { moneyInfo } from "@/lib/money";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    checkKioskKey(req);
    const { code } = await params;
    const body = await readBody(req);
    const want = parseMoney(body.mode);
    if (!want) throw new ApiError(400, "mode must be demo, solana or toggle");
    const l = await mutate(code, (lobby) => setMoney(lobby, want));
    return json({ ok: true, money: moneyInfo(l) });
  });
}
