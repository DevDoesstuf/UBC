// "Pay instantly": Solana money for players without a wallet app. Server only.
//
// Every player of a Solana lobby gets an embedded devnet wallet: a keypair derived from the treasury secret, the
// lobby code and the player id (HMAC-SHA512 -> ed25519 seed), so nothing new is stored and only this server can
// sign for it. Only its public address leaves the server (player.solanaAddress, player.wallet = "huddle").
//
// A deposit is ONE treasury-paid devnet transaction that looks exactly like a Solana Pay wallet payment on chain:
//   create the player's USDC token account (idempotent) -> mintTo it `cents` of test USDC (treasury = mint authority)
//   -> transferChecked player -> treasury token account, with a fresh reference key as a read-only non-signer.
// The reference is recorded like any /deposit request, so the usual credit path (creditPayments: once per
// signature), /deposit/sync, the QuickNode webhook and the vault sweep all treat it as an ordinary payment.
// Idempotency: the client sends a nonce; one request per (player, nonce) ever builds a transaction, and its signature
// is written to the lobby before it is sent. A retry waits for / re-reads that same transaction.
import { createHmac } from "node:crypto";
import type { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ApiError, getLobby, mutate, requirePlayer } from "./lobby";
import { lobbyMoneyMode } from "./money";
import { explorerAddress, explorerTx, mint, mintInfo, connection, paymentBySignature, treasury, UNITS_PER_CENT, USDC_DECIMALS } from "./solana";
import { addSolanaRef, creditPayments, refKey, REF_TTL_MS } from "./solana-lobby";
import { kvSet } from "./store";

const web3 = () => import("@solana/web3.js");
const splToken = () => import("@solana/spl-token");

/** How long /deposit/instant waits for confirmation before answering "pending" (sync finishes it). */
export const INSTANT_CONFIRM_MS = 20_000;

/** The 32-byte ed25519 seed of a player's embedded wallet. Pure: same inputs, same wallet; any change, another. */
export function playerSeed(treasurySecret: Uint8Array, code: string, playerId: string): Uint8Array {
  const mac = createHmac("sha512", Buffer.from(treasurySecret)).update(`huddle-player-wallet-v1|${code.toUpperCase()}|${playerId}`).digest();
  return new Uint8Array(mac.subarray(0, 32));
}

export async function playerWallet(code: string, playerId: string): Promise<Keypair> {
  const { Keypair } = await web3();
  return Keypair.fromSeed(playerSeed((await treasury()).secretKey, code, playerId));
}

export async function playerWalletAddress(code: string, playerId: string): Promise<string> {
  return (await playerWallet(code, playerId)).publicKey.toBase58();
}

/**
 * The instructions of one instant deposit (fee payer and mint authority: the treasury; the player's wallet signs
 * the transfer). The reference rides on the transferChecked as a read-only non-signer, like Solana Pay.
 */
export async function instantPayIxs(o: { treasury: PublicKey; player: PublicKey; mint: PublicKey; reference: PublicKey; units: bigint; tokenProgram?: PublicKey }): Promise<TransactionInstruction[]> {
  const spl = await splToken();
  const prog = o.tokenProgram ?? spl.TOKEN_PROGRAM_ID;
  const from = spl.getAssociatedTokenAddressSync(o.mint, o.player, false, prog);
  const to = spl.getAssociatedTokenAddressSync(o.mint, o.treasury, false, prog);
  const transfer = spl.createTransferCheckedInstruction(from, o.mint, to, o.player, o.units, USDC_DECIMALS, [], prog);
  transfer.keys.push({ pubkey: o.reference, isSigner: false, isWritable: false });
  return [
    spl.createAssociatedTokenAccountIdempotentInstruction(o.treasury, from, o.player, o.mint, prog),
    spl.createMintToCheckedInstruction(o.mint, from, o.treasury, o.units, USDC_DECIMALS, [], prog),
    transfer,
  ];
}

/** The RPC calls an instant deposit makes (a web3.js Connection, or a mock in tests). */
export interface InstantRpc {
  getLatestBlockhash(c?: "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Buffer | Uint8Array, opts?: { preflightCommitment?: "confirmed"; maxRetries?: number }): Promise<string>;
  getSignatureStatus(sig: string, opts?: { searchTransactionHistory: boolean }): Promise<{ value: { err: unknown; confirmationStatus?: string } | null }>;
  getParsedTransaction: Connection["getParsedTransaction"];
}

export interface InstantResult {
  ok: true;
  credited: number;
  cents: number;
  signature: string;
  explorer: string;
  wallet: string;
  walletExplorer: string;
  pending?: true;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

/** Waits up to `ms` for the signature: "landed", "failed" or "pending" (still unknown). */
async function waitFor(rpc: InstantRpc, signature: string, ms: number): Promise<"landed" | "failed" | "pending"> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await rpc.getSignatureStatus(signature, { searchTransactionHistory: true }).catch(() => null);
    const v = s?.value;
    if (v?.err) return "failed";
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return "landed";
    if (Date.now() >= end) return "pending";
    await new Promise((r) => setTimeout(r, Math.min(600, Math.max(0, end - Date.now()))));
  }
}

/**
 * POST /deposit/instant. Solana lobbies only; the amount is checked by the route (depositProblem).
 * `nonce`: the client's id for this payment; a retry with the same nonce never pays twice.
 */
export async function instantDeposit(
  code: string,
  token: string | null,
  cents: number,
  nonce: string,
  opts: { rpc?: InstantRpc; tokenProgram?: PublicKey; timeoutMs?: number } = {},
): Promise<InstantResult> {
  const l0 = await getLobby(code, { gemini: false });
  if (!l0) throw new ApiError(404, "Lobby not found");
  const p0 = requirePlayer(l0, token);
  if (lobbyMoneyMode(l0) !== "solana") throw new ApiError(400, "This game plays demo money");
  if (l0.phase === "ended") throw new ApiError(400, "This session has ended. Cash out instead");
  const { PublicKey, Transaction } = await web3();
  const bs58 = (await import("bs58")).default;
  const rpc: InstantRpc = opts.rpc ?? ((await connection()) as unknown as InstantRpc);
  const timeoutMs = opts.timeoutMs ?? INSTANT_CONFIRM_MS;
  const kp = await playerWallet(l0.code, p0.id);
  const wallet = kp.publicKey.toBase58();
  const key = `${p0.id}:${nonce}`;
  const out = (signature: string, credited: number, c: number, pending?: boolean): InstantResult => ({
    ok: true, credited, cents: c, signature, explorer: explorerTx(signature), wallet, walletExplorer: explorerAddress(wallet), ...(pending ? { pending: true as const } : {}),
  });

  // Credits a landed instant payment through the shared path (once per signature, vault sweep, chain event).
  const credit = async (signature: string, reference: string, c: number): Promise<InstantResult> => {
    const pay = await paymentBySignature(signature, reference, { rpc }).catch(() => null);
    if (!pay) return out(signature, 0, c, true); // landed but not readable yet: /deposit/sync credits it
    const r = await creditPayments(l0.code, p0.id, [{ ref: reference, pays: [pay], paid: true }], "instant");
    return out(signature, r.credited, pay.cents);
  };

  // One request per (lobby, player, nonce) ever builds a transaction.
  const claimKey = `instant:${l0.code}:${key}`;
  if (!(await kvSet(claimKey, "1", { nx: true, px: REF_TTL_MS }))) {
    const prev = (await getLobby(l0.code, { gemini: false }))?.instantPays?.[key];
    if (!prev?.signature) throw new ApiError(409, "That payment is already on its way");
    if (prev.cents !== cents) throw new ApiError(409, "That payment was for another amount");
    const status = await waitFor(rpc, prev.signature, timeoutMs);
    if (status === "failed") throw new ApiError(502, "That payment did not go through. Nothing was charged");
    if (status === "pending") return out(prev.signature, 0, cents, true);
    return credit(prev.signature, prev.reference, cents);
  }

  try {
    const t = await treasury();
    const mintPk = await mint();
    const tokenProgram = opts.tokenProgram ?? (await (async () => {
      const mi = await mintInfo();
      if (!mi.treasuryIsAuthority) throw new ApiError(503, "Pay instantly needs Huddle's test USDC mint (the treasury must be its mint authority)");
      return mi.tokenProgram;
    })());
    const referenceKp = (await web3()).Keypair.generate();
    const reference = referenceKp.publicKey.toBase58();
    const units = BigInt(cents) * BigInt(UNITS_PER_CENT);
    const ixs = await instantPayIxs({ treasury: t.publicKey, player: kp.publicKey, mint: mintPk, reference: new PublicKey(reference), units, tokenProgram });
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: t.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
    tx.sign(t, kp);
    const signature = bs58.encode(tx.signature!);

    // Record the request (reference like any deposit request, the signature before it is sent) and the wallet.
    await mutate(l0.code, (l, now) => {
      const p = requirePlayer(l, token);
      if (l.phase === "ended") throw new ApiError(400, "This session has ended. Cash out instead");
      if (lobbyMoneyMode(l) !== "solana") throw new ApiError(400, "This game plays demo money");
      addSolanaRef(l, p.id, reference, cents, now);
      const pays = (l.instantPays ??= {});
      for (const [k, v] of Object.entries(pays)) if (now - v.at > REF_TTL_MS) delete pays[k];
      pays[key] = { playerId: p.id, cents, reference, signature, at: now };
      if (!p.solanaAddress) {
        p.solanaAddress = wallet;
        p.wallet = "huddle";
      }
    });
    await kvSet(refKey(reference), `${l0.code}:${p0.id}`, { px: REF_TTL_MS });

    try {
      await rpc.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
    } catch (e) {
      const msg = errText(e);
      // A failed simulation was never forwarded: nothing was charged; forget the request.
      if (/simulat|preflight|insufficient|custom program error|Attempt to debit|invalid/i.test(msg)) {
        await mutate(l0.code, (l) => {
          if (l.solanaRefs) delete l.solanaRefs[reference];
          if (l.instantPays) delete l.instantPays[key];
        }).catch(() => undefined);
        console.error("[deposit/instant]", msg);
        throw new ApiError(502, "Solana refused that payment. Nothing was charged; try again");
      }
      // Unclear (the RPC went away): it may still land; confirmation below decides.
    }
    const status = await waitFor(rpc, signature, timeoutMs);
    if (status === "failed") throw new ApiError(502, "That payment did not go through. Nothing was charged");
    if (status === "pending") return out(signature, 0, cents, true);
    return credit(signature, reference, cents);
  } catch (e) {
    // Nothing was recorded for this nonce yet (built nothing / failed before the record): let a retry try again.
    const rec = (await getLobby(l0.code, { gemini: false }).catch(() => null))?.instantPays?.[key];
    if (!rec) await kvSet(claimKey, "", { px: 1 }).catch(() => undefined);
    throw e;
  }
}

