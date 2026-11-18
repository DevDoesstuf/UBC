// MONEY_MODE=solana glue between the chain (lib/solana.ts) and lobbies (lib/lobby.ts). Server only.
//
//  - syncSolanaDeposits: finds this player's Solana Pay payments by reference and credits each signature once.
//    A signature is also claimed globally in the store, so one transaction carrying references from two
//    lobbies (the spec allows several references) can never be credited twice.
//  - settlePendingCashouts: a cash-out whose confirmation was unclear is "pending"; this marks it sent once it
//    lands, or puts the money back once its blockhash has expired unseen. Never refunds while it could land.
import { ApiError, creditDeposit, getLobby, mutate, requirePlayer } from "./lobby";
import { findPayments, signatureOutcome, type FoundPayment, type PaymentRpc } from "./solana";
import { kvGet, kvSet } from "./store";
import type { Lobby } from "./types";

/** Unpaid deposit requests older than this are forgotten (the QR is dead after that). */
export const REF_TTL_MS = 60 * 60 * 1000;
/** Each player keeps at most this many open deposit requests (newest win). */
export const MAX_REFS_PER_PLAYER = 4;
const CLAIM_TTL_MS = 120 * 24 * 60 * 60 * 1000;

/** Records a new deposit request on the lobby (inside mutate), pruning expired and excess ones. */
export function addSolanaRef(l: Lobby, playerId: string, reference: string, cents: number, now: number): void {
  const refs = (l.solanaRefs ??= {});
  for (const [k, v] of Object.entries(refs)) if (now - v.at > REF_TTL_MS) delete refs[k];
  refs[reference] = { playerId, cents, at: now };
  const mine = Object.entries(refs).filter(([, v]) => v.playerId === playerId).sort((a, b) => b[1].at - a[1].at);
  for (const [k] of mine.slice(MAX_REFS_PER_PLAYER)) delete refs[k];
}

/** Claims a signature for one lobby+player across all lobbies. True when it is ours (new, or claimed by us before). */
export async function claimSignature(signature: string, owner: string): Promise<boolean> {
  const key = `solsig:${signature}`;
  if (await kvSet(key, owner, { nx: true, px: CLAIM_TTL_MS })) return true;
  return (await kvGet(key)) === owner;
}

export interface SyncResult {
  credited: number;
  pending: number;
  /** Newly credited payments. */
  payments: { signature: string; cents: number }[];
}

/**
 * Checks the player's open deposit requests (or just `onlyRef`) on chain and credits what arrived.
 * Idempotent: retries, parallel calls and repeated polling credit each signature exactly once.
 */
export async function syncSolanaDeposits(code: string, token: string | null, opts: { onlyRef?: string; rpc?: PaymentRpc; treasury?: string; mint?: string } = {}): Promise<SyncResult> {
  const l = await getLobby(code);
  if (!l) throw new ApiError(404, "Lobby not found");
  const p = requirePlayer(l, token);
  const now = Date.now();
  let refs = Object.entries(l.solanaRefs ?? {}).filter(([, v]) => v.playerId === p.id && now - v.at <= REF_TTL_MS);
  if (opts.onlyRef) refs = refs.filter(([r]) => r === opts.onlyRef);
  // `paid`: the reference has a payment, new or already credited (then the request is done either way).
  const found: { ref: string; pays: FoundPayment[]; paid: boolean }[] = [];
  for (const [ref] of refs) {
    let known = false;
    const skip = (sig: string) => (l.deposits[`sol-${sig}`] ? (known = true) : false);
    const pays = await findPayments(ref, { rpc: opts.rpc, treasury: opts.treasury, mint: opts.mint, skip });
    found.push({ ref, pays, paid: known || pays.length > 0 });
  }
  const owner = `${l.code}:${p.id}`;
  const ours = new Set<string>();
  for (const f of found) for (const pay of f.pays) if (await claimSignature(pay.signature, owner)) ours.add(pay.signature);

  const out: SyncResult = { credited: 0, pending: 0, payments: [] };
  await mutate(l.code, (lobby, at) => {
    const me = requirePlayer(lobby, token);
    me.lastSyncAt = at;
    for (const { ref, pays, paid } of found) {
      for (const pay of pays) {
        if (!ours.has(pay.signature)) continue;
        if (creditDeposit(lobby, me.id, pay.cents, "solana", `sol-${pay.signature}`, at)) {
          out.credited += pay.cents;
          out.payments.push({ signature: pay.signature, cents: pay.cents });
        }
        if (pay.from && !me.solanaAddress) me.solanaAddress = pay.from;
      }
      if (paid && lobby.solanaRefs) delete lobby.solanaRefs[ref];
    }
  });
  out.pending = found.filter((f) => !f.paid).length;
  return out;
}

/** Settles this player's pending Solana cash-outs. Returns how many cents came back to the balance. */
export async function settlePendingCashouts(code: string, playerId: string): Promise<number> {
  const l = await getLobby(code);
  const pend = (l?.withdrawals ?? []).filter((w) => w.playerId === playerId && w.status === "pending" && w.txHash);
  if (!pend.length) return 0;
  const outcomes = new Map<string, "landed" | "failed" | "pending">();
  for (const w of pend) outcomes.set(w.txHash!, await signatureOutcome(w.txHash!, w.validUntil).catch(() => "pending" as const));
  let refunded = 0;
  await mutate(code, (lobby) => {
    for (const w of lobby.withdrawals) {
      if (w.status !== "pending" || !w.txHash) continue;
      const o = outcomes.get(w.txHash);
      if (o === "landed") w.status = "sent";
      if (o === "failed") {
        w.status = "failed";
        w.error = "The cash-out transaction never landed; the money was put back";
        const p = lobby.players[w.playerId];
        if (p) {
          p.balance += w.cents;
          p.withdrawn -= w.cents;
          refunded += w.cents;
        }
      }
    }
  });
  return refunded;
}
