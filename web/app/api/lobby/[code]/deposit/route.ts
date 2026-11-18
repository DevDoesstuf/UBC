// POST /api/lobby/ABCD/deposit  {"cents":500}  (header x-player-token)
//   demo mode     -> credits test money right away: {"ok":true,"credited":500}
//   coinbase mode -> {"ok":true,"url":"https://pay.coinbase.com/..."}; the phone opens it, then comes back to
//                    /l/ABCD?deposit=1 and calls /deposit/sync until Coinbase reports the payment as done.
import { baseUrl, clientIp, handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { DEPOSIT_OPTIONS, MONEY_MODE, createOnrampUrl, moneyProblems } from "@/lib/money";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const cents = Number(body.cents);
    const token = playerToken(req);
    if (!DEPOSIT_OPTIONS.includes(cents)) throw new ApiError(400, "Pick one of the listed amounts");

    if (MONEY_MODE === "demo") {
      await mutate(code, (l, now) => {
        const p = requirePlayer(l, token);
        creditDeposit(l, p.id, cents, "demo", `demo-${p.id}-${now}`, now);
      });
      return json({ ok: true, credited: cents });
    }

    const problems = moneyProblems();
    if (problems.length) throw new ApiError(500, `Coinbase is not set up: ${problems.join("; ")}`);
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    const p = requirePlayer(l, token);
    const url = await createOnrampUrl({
      code: l.code,
      playerId: p.id,
      cents,
      clientIp: clientIp(req),
      redirectUrl: `${baseUrl(req)}/l/${l.code}?deposit=1`,
    });
    return json({ ok: true, url });
  });
}
