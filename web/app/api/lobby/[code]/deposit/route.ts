// POST /api/lobby/ABCD/deposit  {"cents":500}  (header x-player-token)
//   demo mode     -> credits test money right away: {"ok":true,"credited":500}
//   coinbase mode -> {"ok":true,"url":"https://pay.coinbase.com/..."}; the phone opens it, then comes back to
//                    /l/ABCD?deposit=1 and calls /deposit/sync until Coinbase reports the payment as done.
import { baseUrl, clientIp, handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { depositProblem, createOnrampUrl, lobbyMoneyMode, moneyProblems } from "@/lib/money";
import { newSolanaDeposit } from "@/lib/solana-lobby";
import { isVault } from "@/lib/vault";
//   solana mode   -> {"ok":true,"url":"solana:<treasury>?amount=5&spl-token=<mint>&reference=<key>&label=Huddle...",
//                    "solanaPay":true,"reference","recipient","mint","amount"}; show it as a QR / "Open in wallet"
//                    link, then call /deposit/sync (optionally with {"reference"}) every 3 s.

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const cents = Number(body.cents);
    const token = playerToken(req);
    const bad = depositProblem(body.cents);
    if (bad) throw new ApiError(400, bad);

    const lobby = await getLobby(code, { gemini: false });
    if (!lobby) throw new ApiError(404, "Lobby not found");
    const mode = lobbyMoneyMode(lobby);
    if (mode === "demo") {
      let credited = 0;
      await mutate(code, (l, now) => {
        const p = requirePlayer(l, token);
        if (l.phase === "ended") throw new ApiError(400, "This session has ended. Cash out instead");
        if (creditDeposit(l, p.id, cents, "demo", `demo-${p.id}-${now}`, now)) credited = cents;
      });
      return json({ ok: true, credited });
    }

    if (mode === "solana") {
      // Solana Pay transfer request: a unique reference key tags the payment so /deposit/sync (or the QuickNode
      // webhook) can find it. SETTLEMENT=vault sweeps it into the party vault as soon as it is credited.
      const d = await newSolanaDeposit(code, token, cents);
      return json({ ok: true, url: d.url, solanaPay: true, reference: d.reference, recipient: d.recipient, mint: d.mint, amount: d.amount, vault: isVault(lobby) });
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
