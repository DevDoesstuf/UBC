// POST /api/lobby/ABCD/deposit  {"cents":500}  (header x-player-token)
//   demo mode     -> credits test money right away: {"ok":true,"credited":500}
//   coinbase mode -> {"ok":true,"url":"https://pay.coinbase.com/..."}; the phone opens it, then comes back to
//                    /l/ABCD?deposit=1 and calls /deposit/sync until Coinbase reports the payment as done.
import { baseUrl, clientIp, handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { DEPOSIT_OPTIONS, MONEY_MODE, createOnrampUrl, moneyProblems } from "@/lib/money";
import { newReference, transferRequestUrl, treasuryInfo } from "@/lib/solana";
//   solana mode   -> {"ok":true,"url":"solana:<treasury>?amount=5&spl-token=<mint>&reference=<key>&label=Huddle...",
//                    "solanaPay":true,"reference"}; show it as a QR / "Open in wallet" link, then call /deposit/sync.

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

    if (MONEY_MODE === "solana") {
      // Solana Pay transfer request: a unique reference key tags the payment so /deposit/sync can find it.
      const reference = await newReference();
      const { address, mint } = await treasuryInfo();
      let code4 = "";
      await mutate(code, (l, now) => {
        const p = requirePlayer(l, token);
        code4 = l.code;
        const refs = (l.solanaRefs ??= {});
        for (const [k, v] of Object.entries(refs)) if (now - v.at > 60 * 60 * 1000) delete refs[k];
        refs[reference] = { playerId: p.id, cents, at: now };
      });
      const url = transferRequestUrl({ recipient: address, cents, mint, reference, label: "Huddle", message: `Huddle lobby ${code4}`, memo: `huddle-${code4}` });
      return json({ ok: true, url, solanaPay: true, reference, recipient: address, mint, amount: (cents / 100).toFixed(2) });
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
