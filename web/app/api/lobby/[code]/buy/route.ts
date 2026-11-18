// POST /api/lobby/ABCD/buy  {"side":"yes"|"no","cents":200}  (header x-player-token)
import { handle, json, playerToken, readBody } from "@/lib/http";
import { buy, mutate, requirePlayer } from "@/lib/lobby";
import type { Side } from "@/lib/types";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    let result = { shares: 0, priceAfter: 0.5 };
    await mutate(code, (l, now) => {
      const p = requirePlayer(l, token);
      result = buy(l, p, body.side as Side, Number(body.cents), now);
    });
    return json({ ok: true, ...result });
  });
}
