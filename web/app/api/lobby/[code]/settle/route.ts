// POST /api/lobby/ABCD/settle  (no body)
// SETTLEMENT=vault: runs the party vault forward right now and waits for it: sweeps credited deposits into the vault
// and, once the session has ended, tops up, closes, submits every signed final balance (Ed25519-verified on chain),
// finalizes and pays each player with a known wallet. Idempotent (each step re-reads the program accounts), so
// anyone may call it; reads of the lobby run the same thing in the background anyway.
// -> {"ok":true,"ran":bool,"status":"open"|"closing"|"finalized"|"settled"|null,"chain":{...},"error"?}
import { baseUrl, handle, json } from "@/lib/http";
import { ApiError, getLobby, publicView } from "@/lib/lobby";
import { advanceVault, isVault } from "@/lib/vault";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    if (!isVault()) throw new ApiError(400, "On-chain settlement needs SETTLEMENT=vault with MONEY_MODE=solana");
    const r = await advanceVault(code, { waitMs: 45_000 });
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    return json({ ok: true, ran: r.ran, status: l.vault?.status ?? null, chain: publicView(l, null, baseUrl(req)).chain, ...(r.error ? { error: r.error } : {}) });
  });
}
