// POST /api/lobby/ABCD/buy  {"side":"yes"|"no","cents":200}  (header x-player-token)
import { handle, json, playerToken, readBody } from "@/lib/http";
import { buy, mutate, pendingBuy, requirePlayer } from "@/lib/lobby";
import type { Side } from "@/lib/types";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    let result = { shares: 0, priceAfter: 0.5 };
    // {"confirm":"tap"}: park the bet until the phone taps the box (see ../pending).
    if (body.confirm === "tap") {
      let until = 0;
      await mutate(code, (l, now) => {
        until = pendingBuy(l, requirePlayer(l, token), body.side as Side, Number(body.cents), now).until;
      });
      return json({ ok: true, pending: true, until, shares: 0, priceAfter: null });
    }
    await mutate(code, (l, now) => {
      const p = requirePlayer(l, token);
      result = buy(l, p, body.side as Side, Number(body.cents), now);
    });
    return json({ ok: true, ...result });
  });
}
