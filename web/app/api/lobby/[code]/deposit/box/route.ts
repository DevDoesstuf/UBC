// POST /api/lobby/ABCD/deposit/box  {"cents":500}  (header x-player-token)
// "Pay on the box" (MONEY_MODE=solana only): the box shows the Solana Pay QR for this player's deposit, so a friend's
// phone (or the player's own wallet on another device) can scan it there. Same transfer request as /deposit (fresh
// reference, recorded in solanaRefs), plus lobby.boxPay = {playerId, name, cents, url, reference, at, until (~90 s),
// paidAt: null}. One box payment at a time: a new request replaces the last one.
// The payment is credited once by whichever sees it first: /deposit/sync, the QuickNode webhook, or the lobby read
// path (checks every 3 s while boxPay is open). Then paidAt is set and boxPay clears itself ~4 s later.
// The box clears it early on touch `pay:close`.
// -> {"ok":true,"url","reference","recipient","mint","amount","until"}
import { handle, json, playerToken, readBody } from "@/lib/http";
import { ApiError, BOX_PAY_MS } from "@/lib/lobby";
import { DEPOSIT_OPTIONS, MONEY_MODE } from "@/lib/money";
import { newSolanaDeposit } from "@/lib/solana-lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const cents = Number(body.cents);
    if (MONEY_MODE !== "solana") throw new ApiError(400, "Pay on the box needs Solana money (MONEY_MODE=solana)");
    if (!DEPOSIT_OPTIONS.includes(cents)) throw new ApiError(400, "Pick one of the listed amounts");
    const d = await newSolanaDeposit(code, playerToken(req), cents, { box: true });
    return json({ ok: true, url: d.url, reference: d.reference, recipient: d.recipient, mint: d.mint, amount: d.amount, until: Date.now() + BOX_PAY_MS });
  });
}
