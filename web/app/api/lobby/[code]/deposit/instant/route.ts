// POST /api/lobby/ABCD/deposit/instant  {"cents":500,"nonce":"<client id for this payment>"}  (header x-player-token)
// Solana lobbies only: "Pay instantly" from the player's embedded devnet wallet (no wallet app needed). ONE
// treasury-paid transaction mints `cents` of test USDC to that wallet and transfers it to the treasury with a fresh
// Solana Pay reference, then it is credited like any wallet payment (once per signature; the vault sweeps it).
// Same amount limits as /deposit. A retry with the same nonce never pays twice.
// -> {ok, credited, cents, signature, explorer, wallet, walletExplorer}; `pending: true` (credited 0) when the
//    transaction was not confirmed within ~20 s: /deposit/sync credits it once it lands.
import { randomUUID } from "node:crypto";
import { handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError } from "@/lib/lobby";
import { depositProblem } from "@/lib/money";
import { instantDeposit } from "@/lib/instant";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const bad = depositProblem(body.cents);
    if (bad) throw new ApiError(400, bad);
    const raw = typeof body.nonce === "string" ? body.nonce.trim() : "";
    if (raw && !/^[A-Za-z0-9_-]{4,64}$/.test(raw)) throw new ApiError(400, "Bad nonce");
    return json(await instantDeposit(code, playerToken(req), Number(body.cents), raw || randomUUID()));
  });
}
