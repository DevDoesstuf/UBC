// POST /api/lobby/ABCD/deposit/sync  (header x-player-token)
// Asks Coinbase for this player's Onramp transactions and credits any successful one we have not credited yet.
// -> {"ok":true,"credited":<cents added now>,"pending":<transactions still in flight>}
import { handle, json, playerToken } from "@/lib/http";
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { MONEY_MODE, fetchDeposits } from "@/lib/money";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const token = playerToken(req);
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    const p = requirePlayer(l, token);
    if (MONEY_MODE !== "coinbase") return json({ ok: true, credited: 0, pending: 0 });
    if (p.lastSyncAt && Date.now() - p.lastSyncAt < 2500) return json({ ok: true, credited: 0, pending: -1 });

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
