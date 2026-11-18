// POST /api/lobby/ABCD/offer  {"side":"yes"|"no","cents":500,"odds":1.8}  (header x-player-token)
// Head-to-head questions only: back `side` with `cents` at decimal `odds` (1.80 = stake $5 to win $4).
// The stake leaves your balance now; whatever nobody takes comes back when trading locks.
// -> {"ok":true,"offer":{id,by,side,cents,odds,open}}
import { handle, json, playerToken, readBody } from "@/lib/http";
import { makeOffer, mutate, requirePlayer } from "@/lib/lobby";
import type { Offer, Side } from "@/lib/types";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    let offer: Offer | null = null;
    await mutate(code, (l, now) => {
      const p = requirePlayer(l, token);
      offer = makeOffer(l, p, body.side as Side, Number(body.cents), Number(body.odds), now);
    });
    const o = offer as unknown as Offer;
    return json({ ok: true, offer: { id: o.id, by: o.by, name: o.name, side: o.side, cents: o.cents, odds: o.odds, open: o.open } });
  });
}
