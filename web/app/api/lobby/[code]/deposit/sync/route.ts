// POST /api/lobby/ABCD/deposit/sync  (header x-player-token)  optional body {"reference":"<key from /deposit>"}
// Coinbase: asks Coinbase for this player's Onramp transactions and credits any successful one not credited yet.
// Solana:   looks up this player's open Solana Pay references (or just `reference`) on chain and credits each
//           payment that moved USDC into the treasury, once per transaction signature (also across lobbies).
//           Also settles a cash-out whose confirmation was unclear.
// -> {"ok":true,"credited":<cents added now>,"pending":<deposit requests not paid yet>}
//    solana adds "payments":[{"signature","cents","explorer"}] for what was credited now.
//    "pending":-1 means "asked too soon, try again in 3 s" (one check per 2.5 s per player).
import { handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { MONEY_MODE, fetchDeposits } from "@/lib/money";
import { explorerTx } from "@/lib/solana";
import { settlePendingCashouts, syncSolanaDeposits } from "@/lib/solana-lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const token = playerToken(req);
    const body = await readBody(req);
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    const p = requirePlayer(l, token);
    if (MONEY_MODE === "demo") return json({ ok: true, credited: 0, pending: 0 });
    if (p.lastSyncAt && Date.now() - p.lastSyncAt < 2500) return json({ ok: true, credited: 0, pending: -1 });

    if (MONEY_MODE === "solana") {
      const onlyRef = typeof body.reference === "string" && body.reference ? body.reference : undefined;
      // Stamp the check first, so the 2.5 s throttle also holds while the RPC is failing (no RPC storm).
      await mutate(l.code, (lobby, now) => {
        requirePlayer(lobby, token).lastSyncAt = now;
      });
      let r: Awaited<ReturnType<typeof syncSolanaDeposits>>;
      try {
        r = await syncSolanaDeposits(l.code, token, { onlyRef });
      } catch (e) {
        console.error("[deposit/sync]", e instanceof Error ? e.message : e);
        throw new ApiError(502, "Can't reach Solana right now. Any payment you made is safe; this checks again by itself.");
      }
      const refunded = await settlePendingCashouts(l.code, p.id).catch(() => 0);
      return json({
        ok: true,
        credited: r.credited,
        pending: r.pending,
        payments: r.payments.map((x) => ({ ...x, explorer: explorerTx(x.signature) })),
        ...(refunded ? { refunded } : {}),
      });
    }

    const { completed, pending } = await fetchDeposits(l.code, p.id);
    let credited = 0;
    await mutate(l.code, (lobby, now) => {
      const me = requirePlayer(lobby, token);
      me.lastSyncAt = now;
      for (const t of completed) if (creditDeposit(lobby, me.id, t.cents, "coinbase", `cb-${t.id}`, now)) credited += t.cents;
    });
    return json({ ok: true, credited, pending });
  });
}
