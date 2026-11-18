// POST /api/lobby/ABCD/cashout  {"address":"0x..."}  (header x-player-token)
// Takes the player's whole balance out of the game.
//   test payouts   -> balance goes to zero, nothing is sent (demo / Coinbase sandbox).
//   PAYOUTS=onchain with real money -> sends USDC on Base from the treasury to `address`.
//                    If the transfer fails, the balance is put back.
//   MONEY_MODE=solana -> sends test USDC on Solana devnet from the treasury to `address` (a Solana address), or,
//                    when no address is given, to the wallet the player deposited from / got faucet money at.
import { handle, json, playerToken, readBody } from "@/lib/http";
import { explorerTx, isSolanaAddress, sendUsdc as sendSolanaUsdc } from "@/lib/solana";
import { ApiError, mutate, requirePlayer } from "@/lib/lobby";
import { isEvmAddress, moneyInfo, sendUsdc } from "@/lib/money";
import type { WithdrawalRecord } from "@/lib/types";
import { reserveWithdrawal } from "@/lib/lobby";

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    const solana = moneyInfo().payouts === "solana";
    const onchain = moneyInfo().payouts === "onchain" || solana;
    const address = String(body.address ?? "").trim();
    if (solana && address && !(await isSolanaAddress(address))) throw new ApiError(400, "That is not a Solana address");
    if (onchain && !solana && !isEvmAddress(address)) throw new ApiError(400, "Enter the 0x address of your wallet on Base");

    let w: WithdrawalRecord | null = null;
    await mutate(code, (l, now) => {
      const p = requirePlayer(l, token);
      const to = solana ? address || p.solanaAddress || "" : address;
      if (solana && !to) throw new ApiError(400, "Enter the Solana address of your wallet");
      if (solana && address) p.solanaAddress = address;
      w = reserveWithdrawal(l, p, onchain ? to : null, now);
    });
    const rec = w as unknown as WithdrawalRecord;
    if (!onchain) return json({ ok: true, cents: rec.cents, mode: "test" });

    const same = (x: WithdrawalRecord) => x.playerId === rec.playerId && x.at === rec.at;
    try {
      const txHash = solana ? await sendSolanaUsdc(rec.to!, rec.cents) : await sendUsdc(address as `0x${string}`, rec.cents);
      await mutate(code, (l) => {
        const r = l.withdrawals.find(same);
        if (r) Object.assign(r, { status: "sent", txHash });
      });
      const explorer = solana ? explorerTx(txHash) : `https://basescan.org/tx/${txHash}`;
      return json({ ok: true, cents: rec.cents, mode: solana ? "solana" : "onchain", to: rec.to, txHash, explorer });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await mutate(code, (l) => {
        const r = l.withdrawals.find(same);
        if (r) Object.assign(r, { status: "failed", error });
        const p = l.players[rec.playerId];
        if (p) {
          p.balance += rec.cents;
          p.withdrawn -= rec.cents;
        }
      });
      throw new ApiError(502, `Payout failed, your balance was put back. ${error}`);
    }
  });
}
