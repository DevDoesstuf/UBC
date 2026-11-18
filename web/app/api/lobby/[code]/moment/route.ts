// POST /api/lobby/ABCD/moment  {"kind":"penalty"}  (or "moment:penalty")  -> {"ok":true,"market":{text,yesCents,model,lockIn}}
// "Call it": opens a market for a moment right now (between questions only). Same as the kiosk's moment:<kind>
// buttons; needs x-kiosk-key when KIOSK_KEY is set. GET lists the moments the lobby's game offers.
import { checkKioskKey, handle, json, readBody } from "@/lib/http";
import { ApiError, getLobby, momentsFor, mutate, openMoment } from "@/lib/lobby";
import * as lmsr from "@/lib/lmsr";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const l = await getLobby(code);
    if (!l) throw new ApiError(404, "Lobby not found");
    return json({ ok: true, moments: momentsFor(l) });
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    checkKioskKey(req);
    const { code } = await params;
    const body = await readBody(req);
    const l = await mutate(code, (lobby, now) => openMoment(lobby, String(body.kind ?? body.id ?? ""), now));
    const m = l.market!;
    return json({
      ok: true,
      market: { text: m.text, yesCents: lmsr.toCents(lmsr.priceYes(m.yes, m.no, m.b)), model: m.model ?? null, lockIn: Math.max(0, Math.ceil((m.lockAt - Date.now()) / 1000)) },
    });
  });
}
