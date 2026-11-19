// POST /api/lobby/ABCD/pending  {"side":"yes"|"no","cents":200}  (header x-player-token)
// Tap-to-confirm: parks the bet (~20 s). The box shows it; tapping the phone on the box's NFC sticker (/k/<kiosk>)
// or "Confirm here" (POST /api/lobby/ABCD/confirm) places it. Same as /buy with {"confirm":"tap"}.
import { handle, json, playerToken, readBody } from "@/lib/http";
import { mutate, pendingBuy, requirePlayer } from "@/lib/lobby";
import type { Side } from "@/lib/types";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    let until = 0;
    await mutate(code, (l, now) => {
      until = pendingBuy(l, requirePlayer(l, token), body.side as Side, Number(body.cents), now).until;
    });
    return json({ ok: true, pending: true, until, shares: 0, priceAfter: null });
  });
}
