// MONEY_MODE=solana: test USDC on Solana devnet through Solana Pay. Server only.
//
// Deposit: the server makes a Solana Pay *transfer request* URL
//   solana:<treasury>?amount=5&spl-token=<USDC_MINT>&reference=<unique pubkey>&label=Huddle&message=...
// (the documented URL scheme, built by hand: no SDK accounts). The phone shows it as a QR / "Open in wallet"
// link (Phantom, Solflare, Backpack on devnet). The wallet sends a transferChecked of exactly `amount` into the
// treasury's associated token account, with the reference key added as a read-only, non-signer account.
// /deposit/sync finds the payment by its reference key (getSignaturesForAddress, like @solana/pay's
// findReference), checks it really moved USDC into a treasury-owned token account, and credits the amount
// received once, keyed by the transaction signature.
// Cash-out: the treasury sends USDC to the Solana address the player pastes (treasury pays the fee and the
// recipient's token account rent), in one transaction. Faucet: new players get test USDC and a pinch of SOL
// for fees, in one transaction.
//
// Env: SOLANA_TREASURY_SECRET_KEY (JSON byte array or base58), USDC_MINT, SOLANA_RPC_URL (default devnet).
// Devnet (or a local validator) only: a mainnet RPC URL or a mainnet genesis hash is refused.
import type { Connection, Keypair, ParsedTransactionWithMeta, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

const env = (k: string) => (process.env[k] || "").trim();

export const DEVNET_RPC = "https://api.devnet.solana.com";
export const SOLANA_RPC_URL = env("SOLANA_RPC_URL") || DEVNET_RPC;
export const USDC_DECIMALS = 6;
/** 1 cent = 10,000 base units of a 6-decimal token. */
export const UNITS_PER_CENT = 10_000;
export const FAUCET_CENTS = 2000;
export const FAUCET_LAMPORTS = 5_000_000; // 0.005 SOL: enough for hundreds of transfer fees
/** Below this the treasury cannot reliably pay fees and token-account rent (about 0.002 SOL each). */
export const MIN_TREASURY_LAMPORTS = 20_000_000; // 0.02 SOL

export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;
export type Cluster = "devnet" | "testnet" | "mainnet" | "localnet";

export function clusterFromGenesis(hash: string): Cluster {
  if (hash === GENESIS.devnet) return "devnet";
  if (hash === GENESIS.testnet) return "testnet";
  if (hash === GENESIS.mainnet) return "mainnet";
  return "localnet";
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Format problems with the treasury secret (never echoes the secret itself). */
export function secretKeyProblem(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "SOLANA_TREASURY_SECRET_KEY is not set";
  if (s.startsWith("[")) {
    try {
      const a = JSON.parse(s) as unknown;
      if (Array.isArray(a) && a.length === 64 && a.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
    } catch {
      /* fall through */
    }
    return "SOLANA_TREASURY_SECRET_KEY is not a 64-number JSON array (the format of a solana-keygen .json file)";
  }
  if (!BASE58.test(s) || s.length < 80 || s.length > 90) return "SOLANA_TREASURY_SECRET_KEY is not a base58 64-byte secret key";
  return null;
}

export function solanaProblems(): string[] {
  const out: string[] = [];
  const kp = secretKeyProblem(env("SOLANA_TREASURY_SECRET_KEY"));
  if (kp) out.push(kp);
  const m = env("USDC_MINT");
  if (!m) out.push("USDC_MINT is not set");
  else if (!BASE58.test(m) || m.length < 32 || m.length > 44) out.push("USDC_MINT is not a Solana address");
  if (/mainnet/i.test(SOLANA_RPC_URL)) out.push("SOLANA_RPC_URL points at mainnet; Huddle only runs on devnet");
  return out;
}

/** Explorer link for an account address, same cluster rules as explorerTx. */
export function explorerAddress(addr: string, rpc = SOLANA_RPC_URL): string {
  return explorerTx(addr, rpc).replace("/tx/", "/address/");
}

/** Explorer link for a signature on whichever cluster SOLANA_RPC_URL points at (a local validator uses a custom URL). */
export function explorerTx(sig: string, rpc = SOLANA_RPC_URL): string {
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (/devnet/i.test(rpc)) return `${base}?cluster=devnet`;
  if (/testnet/i.test(rpc)) return `${base}?cluster=testnet`;
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(rpc)) return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  return `${base}?cluster=devnet`; // a keyed devnet provider (Helius, QuickNode...): devnet is the only cluster we run on
}

async function web3() {
  return import("@solana/web3.js");
}
async function splToken() {
  return import("@solana/spl-token");
}

let conn: Connection | null = null;
export async function connection(): Promise<Connection> {
  if (!conn) {
    const { Connection } = await web3();
    conn = new Connection(SOLANA_RPC_URL, { commitment: "confirmed", disableRetryOnRateLimit: false });
  }
  return conn;
}

/** Parses a secret key given as a JSON byte array ([12,34,...]) or base58. */
export async function parseSecretKey(raw: string): Promise<Uint8Array> {
  const s = raw.trim();
  if (s.startsWith("[")) return Uint8Array.from(JSON.parse(s) as number[]);
  const bs58 = (await import("bs58")).default;
  return bs58.decode(s);
}

let treasuryKp: Keypair | null = null;
export async function treasury(): Promise<Keypair> {
  if (!treasuryKp) {
    const { Keypair } = await web3();
    treasuryKp = Keypair.fromSecretKey(await parseSecretKey(env("SOLANA_TREASURY_SECRET_KEY")));
  }
  return treasuryKp;
}

export async function mint(): Promise<PublicKey> {
  const { PublicKey } = await web3();
  return new PublicKey(env("USDC_MINT"));
}

export async function treasuryInfo(): Promise<{ address: string; mint: string; rpc: string }> {
  return { address: (await treasury()).publicKey.toBase58(), mint: env("USDC_MINT"), rpc: redactRpc(SOLANA_RPC_URL) };
}

export const redactRpc = (u: string) => u.replace(/(api[-_]?key=)[^&]+/i, "$1***");

export async function isSolanaAddress(a: string): Promise<boolean> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return false;
  try {
    const { PublicKey } = await web3();
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
}

/** A fresh reference key for one deposit (only its public key matters; nobody signs with it). */
export async function newReference(): Promise<string> {
  const { Keypair } = await web3();
  return Keypair.generate().publicKey.toBase58();
}

// ---------------------------------------------------------------- Solana Pay transfer request

/** Cents as a Solana Pay `amount`: plain decimal, no exponent, no trailing zeros, at most 2 decimals (5, 10.5, 0.25). */
export function formatAmount(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`Bad amount: ${cents} cents`);
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  if (!frac) return String(whole);
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** RFC 3986 percent-encoding (spaces are %20, never "+", which some wallet parsers keep literally). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Solana Pay transfer request URL (spec: docs.solanapay.com/spec, "Transfer request"):
 * `solana:<recipient>?amount=<decimal>&spl-token=<mint>&reference=<pubkey>&label=<text>&message=<text>&memo=<text>`.
 * The recipient is the treasury *wallet* (the wallet derives its USDC token account), never a token account.
 */
export function transferRequestUrl(o: { recipient: string; cents: number; mint: string; reference: string | string[]; label?: string; message?: string; memo?: string }): string {
  const parts = [`amount=${formatAmount(o.cents)}`, `spl-token=${enc(o.mint)}`];
  for (const r of Array.isArray(o.reference) ? o.reference : [o.reference]) parts.push(`reference=${enc(r)}`);
  parts.push(`label=${enc(o.label ?? "Huddle")}`);
  if (o.message) parts.push(`message=${enc(o.message)}`);
  if (o.memo) parts.push(`memo=${enc(o.memo)}`);
  return `solana:${o.recipient}?${parts.join("&")}`;
}

// ---------------------------------------------------------------- finding deposits

export interface FoundPayment {
  signature: string;
  /** Cents of USDC that landed in the treasury's token account(s). */
  cents: number;
  /** Wallet that paid, when it can be told from the token balances. */
  from?: string;
}

type TokenBalance = NonNullable<NonNullable<ParsedTransactionWithMeta["meta"]>["preTokenBalances"]>[number];
type TxMetaLike = { err: unknown; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null };

/**
 * What a confirmed transaction paid the treasury: the increase of `mint` held in treasury-owned token
 * accounts (any of them, so a payment to a non-associated account still counts), rounded down to the cent.
 * Null when the transaction failed or the treasury did not gain any of that mint.
 */
export function paymentFromMeta(meta: TxMetaLike | null | undefined, treasuryAddr: string, mintAddr: string): { cents: number; from?: string } | null {
  if (!meta || meta.err) return null;
  const mine = (b: TokenBalance) => b.mint === mintAddr && b.owner === treasuryAddr;
  const sum = (list?: TokenBalance[] | null) => (list ?? []).filter(mine).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), BigInt(0));
  const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
  if (delta <= BigInt(0)) return null;
  const cents = Number(delta / BigInt(UNITS_PER_CENT));
  if (cents <= 0) return null;
  // The payer: the owner whose balance of this mint went down the most.
  const pre = new Map<string, bigint>();
  for (const b of meta.preTokenBalances ?? []) if (b.mint === mintAddr && b.owner && b.owner !== treasuryAddr) pre.set(`${b.accountIndex}`, BigInt(b.uiTokenAmount.amount));
  let from: string | undefined;
  let drop = BigInt(0);
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mintAddr || !b.owner || b.owner === treasuryAddr) continue;
    const before = pre.get(`${b.accountIndex}`);
    if (before === undefined) continue;
    const d = before - BigInt(b.uiTokenAmount.amount);
    if (d > drop) {
      drop = d;
      from = b.owner;
    }
  }
  return { cents, from };
}

/** The two RPC calls findPayments needs (a web3.js Connection, or a mock in tests). */
export type PaymentRpc = Pick<Connection, "getSignaturesForAddress" | "getParsedTransaction">;

/**
 * Looks up payments tagged with `reference` and returns those that moved USDC into the treasury.
 * Like @solana/pay's findReference + validateTransfer, but tolerant of over/under-payment (we credit what
 * arrived). `skip` lists signatures already credited, so they are not fetched again.
 */
export async function findPayments(
  reference: string,
  opts: { rpc?: PaymentRpc; treasury?: string; mint?: string; skip?: (signature: string) => boolean } = {},
): Promise<FoundPayment[]> {
  const { PublicKey } = await web3();
  const c = opts.rpc ?? (await connection());
  const t = opts.treasury ?? (await treasury()).publicKey.toBase58();
  const m = opts.mint ?? (await mint()).toBase58();
  const sigs = await c.getSignaturesForAddress(new PublicKey(reference), { limit: 20 }, "confirmed");
  const out: FoundPayment[] = [];
  for (const s of sigs) {
    if (s.err || opts.skip?.(s.signature)) continue;
    const tx = await c.getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const pay = paymentFromMeta(tx?.meta, t, m);
    if (pay) out.push({ signature: s.signature, ...pay });
  }
  return out;
}

/**
 * One known transaction (e.g. from a QuickNode Stream): what it paid the treasury, re-read from our own RPC so a
 * forged webhook body can never credit anything. Null unless it succeeded, carries `reference` as an account key
 * and moved USDC into a treasury-owned token account.
 */
export async function paymentBySignature(
  signature: string,
  reference: string,
  opts: { rpc?: Pick<Connection, "getParsedTransaction">; treasury?: string; mint?: string } = {},
): Promise<FoundPayment | null> {
  const c = opts.rpc ?? (await connection());
  const t = opts.treasury ?? (await treasury()).publicKey.toBase58();
  const m = opts.mint ?? (await mint()).toBase58();
  const tx = await c.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey.toBase58()));
  if (!keys.includes(reference)) return null;
  const pay = paymentFromMeta(tx.meta, t, m);
  return pay ? { signature, ...pay } : null;
}

// ---------------------------------------------------------------- sending from the treasury

/**
 * A send that did not succeed. `landed` is false when the transaction certainly did not and will not land
 * (simulation failed, it failed on chain, or its blockhash expired unseen), null when that is not known yet
 * (the RPC went away mid-send): then never refund right away; settle later with `signatureOutcome`.
 */
export class SolanaSendError extends Error {
  landed: false | null;
  signature?: string;
  lastValidBlockHeight?: number;
  constructor(message: string, landed: false | null, signature?: string, lastValidBlockHeight?: number) {
    super(message);
    this.landed = landed;
    this.signature = signature;
    this.lastValidBlockHeight = lastValidBlockHeight;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 240);

/**
 * Where a treasury transaction stands: "landed" (confirmed, no error), "failed" (failed on chain, or never
 * seen and its blockhash has expired, so it never will land), or "pending" (not seen yet, still valid).
 */
export async function signatureOutcome(signature: string, lastValidBlockHeight?: number, c?: Pick<Connection, "getSignatureStatus" | "getBlockHeight">): Promise<"landed" | "failed" | "pending"> {
  const rpc = c ?? (await connection());
  const s = await rpc.getSignatureStatus(signature, { searchTransactionHistory: true });
  const v = s.value;
  if (v?.err) return "failed";
  if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return "landed";
  if (v) return "pending"; // processed, not yet confirmed
  if (lastValidBlockHeight === undefined) return "pending";
  return (await rpc.getBlockHeight("confirmed")) > lastValidBlockHeight ? "failed" : "pending";
}

/**
 * Signs, sends and confirms one treasury transaction (the treasury is the fee payer; `extraSigners` co-sign,
 * e.g. a vault seat key); the signature is known before it is sent.
 */
export async function sendTreasuryTx(ixs: TransactionInstruction[], extraSigners: Keypair[] = []): Promise<string> {
  const { Transaction } = await web3();
  const bs58 = (await import("bs58")).default;
  const c = await connection();
  const payer = await treasury();
  const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
  const tx: Transaction = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  tx.sign(payer, ...extraSigners);
  const signature = bs58.encode(tx.signature!);
  try {
    await c.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  } catch (e) {
    // A failed preflight simulation means the transaction was never forwarded.
    if (/simulat|preflight|insufficient|custom program error|Attempt to debit|invalid/i.test(errText(e))) throw new SolanaSendError(errText(e), false, signature);
    return settleUnclear(e, signature, lastValidBlockHeight);
  }
  try {
    const r = await c.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (r.value.err) throw new SolanaSendError(`Transaction failed: ${JSON.stringify(r.value.err)}`, false, signature);
    return signature;
  } catch (e) {
    if (e instanceof SolanaSendError) throw e;
    return settleUnclear(e, signature, lastValidBlockHeight);
  }
}

async function settleUnclear(e: unknown, signature: string, lastValidBlockHeight: number): Promise<string> {
  const outcome = await signatureOutcome(signature, lastValidBlockHeight).catch(() => "pending" as const);
  if (outcome === "landed") return signature;
  throw new SolanaSendError(errText(e), outcome === "failed" ? false : null, signature, lastValidBlockHeight);
}

interface MintFacts {
  decimals: number;
  treasuryIsAuthority: boolean;
  tokenProgram: PublicKey;
}
let mintFacts: MintFacts | null = null;
export async function mintInfo(): Promise<MintFacts> {
  if (!mintFacts) {
    const spl = await splToken();
    const c = await connection();
    const mintPk = await mint();
    const acct = await c.getAccountInfo(mintPk);
    if (!acct) throw new Error(`USDC_MINT ${mintPk.toBase58()} does not exist on this cluster`);
    const programId = acct.owner.equals(spl.TOKEN_2022_PROGRAM_ID) ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
    const info = await spl.getMint(c, mintPk, "confirmed", programId);
    mintFacts = { decimals: info.decimals, treasuryIsAuthority: !!info.mintAuthority?.equals((await treasury()).publicKey), tokenProgram: programId };
    if (info.decimals !== USDC_DECIMALS) {
      const d = info.decimals;
      mintFacts = null;
      throw new Error(`USDC_MINT has ${d} decimals; Huddle needs a 6-decimal USDC-style token`);
    }
  }
  return mintFacts;
}

/** Why `to` cannot receive a cash-out or faucet payment, or null when it can (a wallet address). */
export async function destinationProblem(to: string): Promise<string | null> {
  if (!(await isSolanaAddress(to))) return "That is not a Solana address";
  const { PublicKey, SystemProgram } = await web3();
  const spl = await splToken();
  const payer = await treasury();
  if (to === payer.publicKey.toBase58()) return "That is Huddle's own address. Paste your wallet's address";
  if (to === env("USDC_MINT")) return "That is the USDC mint, not a wallet. Paste your wallet's address";
  const acct = await (await connection()).getAccountInfo(new PublicKey(to));
  if (!acct) return null; // a brand-new wallet that has never held anything: fine
  if (acct.owner.equals(spl.TOKEN_PROGRAM_ID) || acct.owner.equals(spl.TOKEN_2022_PROGRAM_ID)) {
    return "That is a token account, not a wallet. Paste your wallet's address (the one your wallet app shows)";
  }
  if (acct.executable) return "That is a program, not a wallet";
  if (!acct.owner.equals(SystemProgram.programId)) return null; // a PDA wallet (multisig vault...): allowed
  return null;
}

/** Instructions that make sure the treasury holds `units` of USDC, minting the shortfall when it is the mint authority. */
export async function treasuryFundsIxs(units: bigint): Promise<{ ixs: TransactionInstruction[]; source: PublicKey }> {
  const spl = await splToken();
  const c = await connection();
  const payer = await treasury();
  const mintPk = await mint();
  const mi = await mintInfo();
  const source = spl.getAssociatedTokenAddressSync(mintPk, payer.publicKey, false, mi.tokenProgram);
  const bal = await c.getTokenAccountBalance(source, "confirmed").then((r) => BigInt(r.value.amount)).catch(() => BigInt(0));
  const ixs: TransactionInstruction[] = [];
  if (bal < units) {
    if (!mi.treasuryIsAuthority) throw new SolanaSendError(`The treasury is out of test USDC (has $${Number(bal / BigInt(UNITS_PER_CENT)) / 100})`, false);
    ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, source, payer.publicKey, mintPk, mi.tokenProgram));
    ixs.push(spl.createMintToCheckedInstruction(mintPk, source, payer.publicKey, units - bal, USDC_DECIMALS, [], mi.tokenProgram));
  }
  return { ixs, source };
}

/** Treasury sends `cents` of USDC to wallet `to`, creating its token account if needed. One transaction. Returns the signature. */
export async function sendUsdc(to: string, cents: number): Promise<string> {
  const { PublicKey } = await web3();
  const spl = await splToken();
  const payer = await treasury();
  const mintPk = await mint();
  const mi = await mintInfo();
  const owner = new PublicKey(to);
  const units = BigInt(cents) * BigInt(UNITS_PER_CENT);
  const { ixs, source } = await treasuryFundsIxs(units);
  const dest = spl.getAssociatedTokenAddressSync(mintPk, owner, true, mi.tokenProgram);
  ixs.push(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, owner, mintPk, mi.tokenProgram));
  ixs.push(spl.createTransferCheckedInstruction(source, mintPk, dest, payer.publicKey, units, USDC_DECIMALS, [], mi.tokenProgram));
  return sendTreasuryTx(ixs);
}

/**
 * Test money for a new player, in one transaction: mints test USDC when the treasury is the mint authority
 * (our own test mint), otherwise sends it from the treasury's balance; plus a little SOL when the wallet has
 * less than that, so it can pay the deposit's fee. `solSig` is the same signature when SOL was sent.
 */
export async function faucet(to: string, cents = FAUCET_CENTS): Promise<{ usdcSig: string; solSig: string | null }> {
  const { PublicKey, SystemProgram } = await web3();
  const spl = await splToken();
  const c = await connection();
  const payer = await treasury();
  const mintPk = await mint();
  const mi = await mintInfo();
  const owner = new PublicKey(to);
  const units = BigInt(cents) * BigInt(UNITS_PER_CENT);
  const dest = spl.getAssociatedTokenAddressSync(mintPk, owner, true, mi.tokenProgram);
  const ixs: TransactionInstruction[] = [spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, dest, owner, mintPk, mi.tokenProgram)];
  if (mi.treasuryIsAuthority) {
    ixs.push(spl.createMintToCheckedInstruction(mintPk, dest, payer.publicKey, units, USDC_DECIMALS, [], mi.tokenProgram));
  } else {
    const funds = await treasuryFundsIxs(units);
    ixs.push(spl.createTransferCheckedInstruction(funds.source, mintPk, dest, payer.publicKey, units, USDC_DECIMALS, [], mi.tokenProgram));
  }
  const lamports = await c.getBalance(owner, "confirmed");
  const sendSol = lamports < FAUCET_LAMPORTS;
  if (sendSol) ixs.push(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: FAUCET_LAMPORTS }));
  const sig = await sendTreasuryTx(ixs);
  return { usdcSig: sig, solSig: sendSol ? sig : null };
}

// ---------------------------------------------------------------- readiness (/api/health)

export interface SolanaReadiness {
  /** Everything needed for deposits, cash-outs and the faucet is in place. */
  ready: boolean;
  cluster: Cluster | null;
  rpc: string;
  treasury: string | null;
  treasurySol: number | null;
  /** Cents of USDC the treasury holds. */
  treasuryUsdcCents: number | null;
  mint: { address: string; exists: boolean; decimals: number | null; treasuryIsMintAuthority: boolean } | null;
  problems: string[];
  /** What a human should do next, in order. */
  nextSteps: string[];
  checkedAt: number;
}

let readinessCache: { at: number; value: SolanaReadiness } | null = null;

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

/** Live checks against the RPC (cached 15 s): cluster, treasury SOL and USDC, the mint's decimals and authority. */
export async function solanaReadiness(force = false): Promise<SolanaReadiness> {
  const now = Date.now();
  if (!force && readinessCache && now - readinessCache.at < 15_000) return readinessCache.value;
  const r: SolanaReadiness = { ready: false, cluster: null, rpc: redactRpc(SOLANA_RPC_URL), treasury: null, treasurySol: null, treasuryUsdcCents: null, mint: null, problems: [...solanaProblems()], nextSteps: [], checkedAt: now };
  if (secretKeyProblem(env("SOLANA_TREASURY_SECRET_KEY"))) {
    r.nextSteps.push("Run `node scripts/solana-setup.mjs` in web/ to create the treasury key, then set SOLANA_TREASURY_SECRET_KEY");
  } else {
    try {
      r.treasury = (await treasury()).publicKey.toBase58();
    } catch {
      r.problems.push("SOLANA_TREASURY_SECRET_KEY does not decode to a keypair");
    }
  }
  if (r.treasury) {
    try {
      const c = await connection();
      r.cluster = clusterFromGenesis(await withTimeout(c.getGenesisHash(), 5000, "RPC"));
      if (r.cluster === "mainnet") r.problems.push("SOLANA_RPC_URL is a mainnet node; Huddle only runs on devnet");
      const { PublicKey, LAMPORTS_PER_SOL } = await web3();
      const lamports = await withTimeout(c.getBalance(new PublicKey(r.treasury), "confirmed"), 5000, "RPC");
      r.treasurySol = lamports / LAMPORTS_PER_SOL;
      if (lamports < MIN_TREASURY_LAMPORTS) {
        r.problems.push(`The treasury has ${r.treasurySol} SOL; it needs at least ${MIN_TREASURY_LAMPORTS / LAMPORTS_PER_SOL} SOL to pay fees`);
        r.nextSteps.push(`Fund the treasury ${r.treasury} with 1-5 devnet SOL at https://faucet.solana.com`);
      }
      const m = env("USDC_MINT");
      if (m && !solanaProblems().some((p) => p.startsWith("USDC_MINT"))) {
        const spl = await splToken();
        const acct = await withTimeout(c.getAccountInfo(new PublicKey(m)), 5000, "RPC");
        r.mint = { address: m, exists: !!acct, decimals: null, treasuryIsMintAuthority: false };
        if (!acct) {
          r.problems.push(`USDC_MINT ${m} does not exist on ${r.cluster}`);
          r.nextSteps.push("Run `node scripts/solana-setup.mjs` again with the treasury funded: it creates the test USDC mint");
        } else {
          const programId = acct.owner.equals(spl.TOKEN_2022_PROGRAM_ID) ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
          const info = await withTimeout(spl.getMint(c, new PublicKey(m), "confirmed", programId), 5000, "RPC");
          r.mint.decimals = info.decimals;
          r.mint.treasuryIsMintAuthority = !!info.mintAuthority?.equals(new PublicKey(r.treasury));
          if (info.decimals !== USDC_DECIMALS) r.problems.push(`USDC_MINT has ${info.decimals} decimals; it must have 6`);
          const ata = spl.getAssociatedTokenAddressSync(new PublicKey(m), new PublicKey(r.treasury), false, programId);
          r.treasuryUsdcCents = await withTimeout(c.getTokenAccountBalance(ata, "confirmed"), 5000, "RPC")
            .then((b) => Number(BigInt(b.value.amount) / BigInt(UNITS_PER_CENT)))
            .catch(() => 0);
          if (!r.mint.treasuryIsMintAuthority && r.treasuryUsdcCents < FAUCET_CENTS * 5) {
            r.problems.push(`The treasury holds $${(r.treasuryUsdcCents / 100).toFixed(2)} of USDC and cannot mint more; cash-outs and the faucet may fail`);
            r.nextSteps.push(`Send devnet USDC to ${r.treasury} (https://faucet.circle.com), or use the test mint the setup script creates`);
          }
        }
      } else if (!m) {
        r.nextSteps.push("Run `node scripts/solana-setup.mjs` again with the treasury funded: it creates the test USDC mint and prints USDC_MINT");
      }
    } catch (e) {
      r.problems.push(`Solana RPC ${r.rpc} is unreachable: ${errText(e)}`);
    }
  }
  r.ready = r.problems.length === 0;
  if (r.ready && env("MONEY_MODE") !== "solana") r.nextSteps.push("Set MONEY_MODE=solana and redeploy");
  readinessCache = { at: now, value: r };
  return r;
}
