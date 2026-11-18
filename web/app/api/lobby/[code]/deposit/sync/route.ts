// POST /api/lobby/ABCD/deposit/sync  (header x-player-token)
// Coinbase: asks Coinbase for this player's Onramp transactions and credits any successful one not credited yet.
// Solana:   looks up this player's open Solana Pay references on devnet and credits each payment that moved
//           USDC into the treasury, once per transaction signature.
// -> {"ok":true,"credited":<cents added now>,"pending":<deposits still in flight>}
import { handle, json, playerToken } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { MONEY_MODE, fetchDeposits } from "@/lib/money";
import { findPayments, type FoundPayment } from "@/lib/solana";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const token = playerToken(req);
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    const p = requirePlayer(l, token);
    if (MONEY_MODE === "demo") return json({ ok: true, credited: 0, pending: 0 });
    if (p.lastSyncAt && Date.now() - p.lastSyncAt < 2500) return json({ ok: true, credited: 0, pending: -1 });

    if (MONEY_MODE === "solana") {
      const refs = Object.entries(l.solanaRefs ?? {}).filter(([, v]) => v.playerId === p.id);
      const found: { ref: string; pays: FoundPayment[] }[] = [];
      for (const [ref] of refs) found.push({ ref, pays: await findPayments(ref) });
      let credited = 0;
      await mutate(l.code, (lobby, now) => {
        const me = requirePlayer(lobby, token);
        me.lastSyncAt = now;
        for (const { ref, pays } of found) {
          for (const pay of pays) {
            if (creditDeposit(lobby, me.id, pay.cents, "solana", `sol-${pay.signature}`, now)) credited += pay.cents;
            if (pay.from && !me.solanaAddress) me.solanaAddress = pay.from;
          }
          if (pays.length && lobby.solanaRefs) delete lobby.solanaRefs[ref];
        }
      });
      const pending = found.filter((f) => !f.pays.length).length;
      return json({ ok: true, credited, pending });
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
