// POST /api/lobby/ABCD/cashout  {"address":"0x..."}  (header x-player-token)
// Takes the player's whole balance out of the game.
//   test payouts   -> balance goes to zero, nothing is sent (demo / Coinbase sandbox).
//   PAYOUTS=onchain with real money -> sends USDC on Base from the treasury to `address`.
//                    If the transfer fails, the balance is put back.
//   MONEY_MODE=solana -> sends test USDC on Solana devnet from the treasury to `address` (a Solana wallet
//                    address), or, when no address is given, to the wallet the player deposited from / got faucet
//                    money at. One transaction; the treasury pays the fee and the token account rent.
//                    Failed for sure -> balance put back (502). Unclear (RPC dropped mid-confirmation) -> 200 with
//                    "pending": true; it is settled on the next cash-out or /deposit/sync (marked sent, or the
//                    money comes back once the transaction can no longer land). Never paid twice.
import { handle, json, playerToken, readBody } from "@/lib/http";
import { SolanaSendError, destinationProblem, explorerTx, sendUsdc as sendSolanaUsdc } from "@/lib/solana";
import { settlePendingCashouts } from "@/lib/solana-lobby";
import { ApiError, getLobby, mutate, requirePlayer } from "@/lib/lobby";
import { isEvmAddress, moneyInfo, sendUsdc } from "@/lib/money";
import type { WithdrawalRecord } from "@/lib/types";
import { reserveWithdrawal } from "@/lib/lobby";
import { pushChainEvent } from "@/lib/chain";
import { advanceVault, isVault } from "@/lib/vault";

//   SETTLEMENT=vault -> the money is in the party's huddle_vault on chain and only the program can pay it out, after
//                    the game ended and settled. Before that: 400. After: runs the settlement (idempotent) and pays
//                    the player's payout from the vault to `address` (or the wallet they paid from) in one
//                    transaction. Most players never need this: settlement pays everyone with a known wallet.
export const maxDuration = 60;

async function vaultCashout(code: string, token: string | null, address: string) {
  const l = await getLobby(code);
  if (!l) throw new ApiError(404, "Lobby not found");
  const p = requirePlayer(l, token);
  const done = l.vault?.payouts[p.id];
  if (done) return { ok: true, cents: done.cents, mode: "solana", vault: true, to: done.to, txHash: done.sig, explorer: done.explorer };
  if (l.phase !== "ended") throw new ApiError(400, "Your money is in this party's vault on Solana. It pays out to your wallet when the host ends the game");
  if (p.balance <= 0 && !l.vault) throw new ApiError(400, "Nothing to cash out");
  if (address) {
    const problem = await destinationProblem(address);
    if (problem) throw new ApiError(400, problem);
    await mutate(code, (lobby) => {
      const me = requirePlayer(lobby, token);
      me.solanaAddress = address;
    });
  } else if (!p.solanaAddress) {
    throw new ApiError(400, "Enter the Solana address of your wallet");
  }
  const r = await advanceVault(code, { waitMs: 45_000 });
  const after = await getLobby(code);
  const paid = after?.vault?.payouts[p.id];
  if (paid) return { ok: true, cents: paid.cents, mode: "solana", vault: true, to: paid.to, txHash: paid.sig, explorer: paid.explorer };
  if (r.error) throw new ApiError(502, `Settling on Solana failed, nothing was lost; try again. ${r.error}`);
  return { ok: true, cents: 0, mode: "solana", vault: true, pending: true, status: after?.vault?.status ?? null };
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handle(async () => {
    const { code } = await params;
    const body = await readBody(req);
    const token = playerToken(req);
    const lobby = await getLobby(code, { gemini: false });
    if (!lobby) throw new ApiError(404, "Lobby not found");
    const money = moneyInfo(lobby);
    const solana = money.payouts === "solana";
    const onchain = money.payouts === "onchain" || solana;
    const address = String(body.address ?? "").trim();
    if (onchain && !solana && !isEvmAddress(address)) throw new ApiError(400, "Enter the 0x address of your wallet on Base");

    if (solana && isVault(lobby)) return json(await vaultCashout(code, token, address));

    if (solana) {
      const l = await getLobby(code);
      if (!l) throw new ApiError(404, "Lobby not found");
      const p = requirePlayer(l, token);
      await settlePendingCashouts(l.code, p.id).catch(() => 0);
      // Nothing to send: say so before asking the RPC about the address (which fails while the RPC is down).
      const fresh = await getLobby(code);
      if (fresh && requirePlayer(fresh, token).balance <= 0) throw new ApiError(400, "Nothing to cash out");
      const to = address || p.solanaAddress || "";
      if (!to) throw new ApiError(400, "Enter the Solana address of your wallet");
      const problem = await destinationProblem(to);
      if (problem) throw new ApiError(400, problem);
    }

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
      await mutate(code, (l, now) => {
        const r = l.withdrawals.find(same);
        if (r) Object.assign(r, { status: "sent", txHash });
        if (solana) pushChainEvent(l, { at: now, kind: "cashout", sig: txHash, explorer: explorerTx(txHash), playerId: rec.playerId, cents: rec.cents, via: "server" });
      });
      const explorer = solana ? explorerTx(txHash) : `https://basescan.org/tx/${txHash}`;
      return json({ ok: true, cents: rec.cents, mode: solana ? "solana" : "onchain", to: rec.to, txHash, explorer });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof SolanaSendError && e.landed === null && e.signature) {
        // Unknown whether it landed: keep the money out of the balance until we know (never pay twice).
        const txHash = e.signature;
        await mutate(code, (l) => {
          const r = l.withdrawals.find(same);
          if (r) Object.assign(r, { status: "pending", txHash, validUntil: e.lastValidBlockHeight, error });
        });
        return json({ ok: true, cents: rec.cents, mode: "solana", to: rec.to, txHash, explorer: explorerTx(txHash), pending: true });
      }
      await mutate(code, (l) => {
        const r = l.withdrawals.find(same);
        if (r) Object.assign(r, { status: "failed", error, ...(e instanceof SolanaSendError && e.signature ? { txHash: e.signature } : {}) });
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
