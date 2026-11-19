// POST /api/lobby/ABCD/faucet  {"address":"<Solana wallet address>"}  (header x-player-token)
// MONEY_MODE=solana only: sends the player's wallet $20 of test USDC (devnet) plus a pinch of SOL for
// transfer fees (only when the wallet has less than 0.005 SOL), in one transaction, once per player per lobby.
// The player then deposits with the Solana Pay link as usual.
// -> {"ok":true,"cents":2000,"usdcSig","solSig" (same signature, or null when no SOL was needed),"explorer"}
import { handle, json, playerToken, readBody } from "@/lib/http";
import { pushChainEvent } from "@/lib/chain";
import { ApiError, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { lobbyMoneyMode } from "@/lib/money";
import { FAUCET_CENTS, SolanaSendError, destinationProblem, explorerTx, faucet } from "@/lib/solana";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    if (lobbyMoneyMode(await getLobby(code, { gemini: false })) !== "solana") throw new ApiError(400, "The faucet is only for Solana games; demo money is free");
    const body = await readBody(req);
    const token = playerToken(req);
    const address = String(body.address ?? "").trim();
    if (!address) throw new ApiError(400, "Enter the Solana address of your wallet");
    const problem = await destinationProblem(address);
    if (problem) throw new ApiError(400, problem);
    let playerId = "";
    await mutate(code, (l) => {
      const p = requirePlayer(l, token);
      if (p.fauceted) throw new ApiError(400, "You already got test money in this lobby");
      p.fauceted = true;
      if (!p.solanaAddress) {
        p.solanaAddress = address;
        p.wallet = "own";
      }
      playerId = p.id;
    });
    try {
      const r = await faucet(address, FAUCET_CENTS);
      await mutate(code, (l, now) => {
        pushChainEvent(l, { at: now, kind: "faucet", sig: r.usdcSig, explorer: explorerTx(r.usdcSig), playerId, cents: FAUCET_CENTS, via: "server" });
      }).catch(() => null);
      return json({ ok: true, cents: FAUCET_CENTS, ...r, explorer: explorerTx(r.usdcSig) });
    } catch (e) {
      // Unclear whether it landed: keep it marked as used (it is test money; never mint twice).
      if (!(e instanceof SolanaSendError && e.landed === null)) {
        await mutate(code, (l) => {
          const p = l.players[playerId];
          if (p) p.fauceted = false;
        });
      }
      throw new ApiError(502, `Faucet failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
