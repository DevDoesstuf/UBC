// POST /api/lobby/ABCD/take  {"offerId":"a1b2c3","cents":400}  (header x-player-token)
// Takes the other side of an offer with up to `cents` (partial takes are fine; any amount above what is
// left of the offer is not used). Winner of each matched pair gets both stakes.
// -> {"ok":true,"offerId","takerCents","makerCents","complete"}
import { handle, json, playerToken, readBody } from "@/lib/http";
import { mutate, requirePlayer, takeOffer } from "@/lib/lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    let result: ReturnType<typeof takeOffer> | null = null;
    await mutate(code, (l, now) => {
      const p = requirePlayer(l, token);
      result = takeOffer(l, p, String(body.offerId ?? ""), Number(body.cents), now);
    });
    return json({ ok: true, ...(result as unknown as ReturnType<typeof takeOffer>) });
  });
}
