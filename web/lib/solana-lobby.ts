// MONEY_MODE=solana glue between the chain (lib/solana.ts, lib/vault.ts) and lobbies (lib/lobby.ts). Server only.
//
//  - newSolanaDeposit: a Solana Pay transfer request with a fresh reference, recorded on the lobby and in a global
//    reference index (so a QuickNode Stream delivery can find its lobby); optionally shown on the box (boxPay).
//  - creditPayments: THE credit path. Deposit polling (/deposit/sync), the box QR check and the QuickNode webhook
//    all end here: each payment signature is claimed globally in the store and credited once, ever.
//  - syncSolanaDeposits: finds this player's Solana Pay payments by reference and credits them.
//  - checkBoxPay: the throttled check of an open "Pay on the box" request, from the lobby read path.
//  - settlePendingCashouts: a cash-out whose confirmation was unclear is "pending"; this marks it sent once it
//    lands, or puts the money back once its blockhash has expired unseen. Never refunds while it could land.
import { pushChainEvent } from "./chain";
import { ApiError, BOX_CHECK_MS, BOX_PAY_MS, creditDeposit, getLobby, mutate, requirePlayer } from "./lobby";
import { explorerTx, findPayments, newReference, signatureOutcome, transferRequestUrl, treasuryInfo, type FoundPayment, type PaymentRpc } from "./solana";
import { kvGet, kvSet } from "./store";
import type { ChainEvent, Lobby } from "./types";
import { isVault, kickVault } from "./vault";

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

/** Global index reference -> "CODE:playerId", so a Stream delivery (which only knows account keys) finds its lobby. */
export const refKey = (reference: string) => `solref:${reference}`;

export async function lookupRef(reference: string): Promise<{ code: string; playerId: string } | null> {
  const v = await kvGet(refKey(reference));
  if (!v) return null;
  const [code, playerId] = v.split(":");
  return code && playerId ? { code, playerId } : null;
}

export interface NewDeposit {
  url: string;
  reference: string;
  recipient: string;
  mint: string;
  amount: string;
  code: string;
}

/**
 * A Solana Pay transfer request for `cents` with a fresh reference key, recorded like every deposit request.
 * `box`: also put it on the box (lobby.boxPay) for ~90 s.
 */
export async function newSolanaDeposit(code: string, token: string | null, cents: number, opts: { box?: boolean } = {}): Promise<NewDeposit> {
  const reference = await newReference();
  const { address, mint } = await treasuryInfo();
  let code4 = "";
  let playerId = "";
  let url = "";
  const vault = isVault();
  await mutate(code, (l, now) => {
    const p = requirePlayer(l, token);
    if (l.phase === "ended") throw new ApiError(400, "This session has ended. Cash out instead");
    code4 = l.code;
    playerId = p.id;
    addSolanaRef(l, p.id, reference, cents, now);
    url = transferRequestUrl({
      recipient: address, cents, mint, reference, label: "Huddle",
      message: vault ? `Huddle lobby ${l.code} (party vault)` : `Huddle lobby ${l.code}`, memo: `huddle-${l.code}`,
    });
    if (opts.box) l.boxPay = { playerId: p.id, name: p.name, cents, url, reference, at: now, until: now + BOX_PAY_MS, paidAt: null };
  });
  await kvSet(refKey(reference), `${code4}:${playerId}`, { px: REF_TTL_MS });
  return { url, reference, recipient: address, mint, amount: (cents / 100).toFixed(2), code: code4 };
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

export type Found = { ref: string; pays: FoundPayment[]; paid: boolean };

/**
 * Credits found payments to one player, each signature once (claimed globally first, then keyed `sol-<sig>` on the
 * lobby). Closes paid references, marks an open box payment as paid, records the chain event, and in vault mode
 * starts the sweep into the party vault. Shared by polling, the box check and the QuickNode webhook.
 */
export async function creditPayments(code: string, playerId: string, found: Found[], via: NonNullable<ChainEvent["via"]>): Promise<SyncResult> {
  const owner = `${code}:${playerId}`;
  const ours = new Set<string>();
  for (const f of found) for (const pay of f.pays) if (await claimSignature(pay.signature, owner)) ours.add(pay.signature);
  const out: SyncResult = { credited: 0, pending: 0, payments: [] };
  await mutate(code, (lobby, at) => {
    const me = lobby.players[playerId];
    if (!me) throw new ApiError(401, "Join the lobby first");
    for (const { ref, pays, paid } of found) {
      for (const pay of pays) {
        if (!ours.has(pay.signature)) continue;
        if (creditDeposit(lobby, me.id, pay.cents, "solana", `sol-${pay.signature}`, at)) {
          out.credited += pay.cents;
          out.payments.push({ signature: pay.signature, cents: pay.cents });
          pushChainEvent(lobby, { at, kind: "deposit", sig: pay.signature, explorer: explorerTx(pay.signature), playerId: me.id, cents: pay.cents, via });
        } else if (via === "quicknode") {
          pushChainEvent(lobby, { at, kind: "deposit", sig: pay.signature, explorer: explorerTx(pay.signature), playerId: me.id, cents: pay.cents, via });
        }
        if (pay.from && !me.solanaAddress) me.solanaAddress = pay.from;
      }
      if (paid && lobby.solanaRefs) delete lobby.solanaRefs[ref];
      if (paid && lobby.boxPay && lobby.boxPay.reference === ref && !lobby.boxPay.paidAt) lobby.boxPay.paidAt = at;
    }
  });
  out.pending = found.filter((f) => !f.paid).length;
  if (out.credited) await kickVault(code);
  return out;
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
  const found: Found[] = [];
  for (const [ref] of refs) {
    let known = false;
    const skip = (sig: string) => (l.deposits[`sol-${sig}`] ? (known = true) : false);
    const pays = await findPayments(ref, { rpc: opts.rpc, treasury: opts.treasury, mint: opts.mint, skip });
    found.push({ ref, pays, paid: known || pays.length > 0 });
  }
  const r = await creditPayments(l.code, p.id, found, "sync");
  await mutate(l.code, (lobby, at) => {
    const me = lobby.players[p.id];
    if (me) me.lastSyncAt = at;
  });
  return r;
}

/**
 * The lobby read path's check of an open "Pay on the box" request: at most once per BOX_CHECK_MS per lobby
 * (claimed in the store, so many readers never stampede the RPC). Returns true when it credited something.
 */
export async function checkBoxPay(l: Lobby, opts: { rpc?: PaymentRpc; treasury?: string; mint?: string } = {}): Promise<boolean> {
  const bp = l.boxPay;
  if (!bp || bp.paidAt || Date.now() > bp.until) return false;
  if (!(await kvSet(`boxpaycheck:${l.code}`, "1", { nx: true, px: BOX_CHECK_MS }))) return false;
  let known = false;
  const skip = (sig: string) => (l.deposits[`sol-${sig}`] ? (known = true) : false);
  const pays = await findPayments(bp.reference, { ...opts, skip });
  if (!pays.length && !known) return false;
  const r = await creditPayments(l.code, bp.playerId, [{ ref: bp.reference, pays, paid: true }], "box");
  return r.credited > 0 || known;
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
      if (o === "landed") {
        w.status = "sent";
        pushChainEvent(lobby, { at: Date.now(), kind: "cashout", sig: w.txHash, explorer: explorerTx(w.txHash), playerId: w.playerId, cents: w.cents, via: "server" });
      }
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
