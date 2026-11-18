// MONEY_MODE=solana: test USDC on Solana devnet through Solana Pay. Server only.
//
// Deposit: the server makes a Solana Pay *transfer request* URL
//   solana:<treasury>?amount=5&spl-token=<USDC_MINT>&reference=<unique pubkey>&label=Huddle&message=...
// (the documented URL scheme, built by hand: no SDK accounts). The phone shows it as a QR / "Open in wallet"
// link (Phantom, Solflare, Backpack on devnet). /deposit/sync finds the payment by its reference key
// (getSignaturesForAddress, like @solana/pay's findReference), checks it really moved USDC into the
// treasury's token account, and credits the amount received once, keyed by the transaction signature.
// Cash-out: the treasury sends USDC to the Solana address the player pastes (treasury pays fees and the
// recipient's token account rent). Faucet: new players get test USDC (and a pinch of SOL for fees).
//
// Env: SOLANA_TREASURY_SECRET_KEY (JSON byte array or base58), USDC_MINT, SOLANA_RPC_URL (default devnet).
// Devnet only: a mainnet RPC URL is refused.
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";

const env = (k: string) => (process.env[k] || "").trim();

export const SOLANA_RPC_URL = env("SOLANA_RPC_URL") || "https://api.devnet.solana.com";
export const USDC_DECIMALS = 6;
/** 1 cent = 10,000 base units of a 6-decimal token. */
export const UNITS_PER_CENT = 10_000;
export const FAUCET_CENTS = 2000;
export const FAUCET_LAMPORTS = 5_000_000; // 0.005 SOL: enough for a few transfer fees

export function solanaProblems(): string[] {
  const out: string[] = [];
  if (!env("SOLANA_TREASURY_SECRET_KEY")) out.push("SOLANA_TREASURY_SECRET_KEY is not set");
  if (!env("USDC_MINT")) out.push("USDC_MINT is not set");
  if (/mainnet/i.test(SOLANA_RPC_URL)) out.push("SOLANA_RPC_URL points at mainnet; Huddle only runs on devnet");
  return out;
}

export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function web3() {
  return import("@solana/web3.js");
}

let conn: Connection | null = null;
async function connection(): Promise<Connection> {
  if (!conn) {
    const { Connection } = await web3();
    conn = new Connection(SOLANA_RPC_URL, "confirmed");
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

async function mint(): Promise<PublicKey> {
  const { PublicKey } = await web3();
  return new PublicKey(env("USDC_MINT"));
}

export async function treasuryInfo(): Promise<{ address: string; mint: string; rpc: string }> {
  return { address: (await treasury()).publicKey.toBase58(), mint: env("USDC_MINT"), rpc: SOLANA_RPC_URL.replace(/api-key=[^&]+/, "api-key=***") };
}

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

/** Solana Pay transfer request URL (spec: docs.solanapay.com/spec, "Transfer request"). */
export function transferRequestUrl(o: { recipient: string; cents: number; mint: string; reference: string; label?: string; message?: string; memo?: string }): string {
  const amount = (o.cents / 100).toFixed(2).replace(/\.?0+$/, "");
  const q = new URLSearchParams();
  q.set("amount", amount);
  q.set("spl-token", o.mint);
  q.set("reference", o.reference);
  q.set("label", o.label ?? "Huddle");
  if (o.message) q.set("message", o.message);
  if (o.memo) q.set("memo", o.memo);
  return `solana:${o.recipient}?${q.toString().replace(/\+/g, "%20")}`;
}

export interface FoundPayment {
  signature: string;
  /** Cents of USDC that landed in the treasury's token account. */
  cents: number;
  /** Wallet that paid, when it can be told from the token balances. */
  from?: string;
}

/**
 * Looks up payments tagged with `reference` and returns those that moved USDC into the treasury.
 * Like @solana/pay's findReference + validateTransfer, but tolerant of overpayment (we credit what arrived).
 */
export async function findPayments(reference: string): Promise<FoundPayment[]> {
  const { PublicKey } = await web3();
  const c = await connection();
  const t = (await treasury()).publicKey.toBase58();
  const m = (await mint()).toBase58();
  const sigs = await c.getSignaturesForAddress(new PublicKey(reference), { limit: 10 }, "confirmed");
  const out: FoundPayment[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await c.getParsedTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx?.meta || tx.meta.err) continue;
    const bal = (list: typeof tx.meta.preTokenBalances) =>
      (list ?? []).filter((b) => b.mint === m && b.owner === t).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), BigInt(0));
    const delta = bal(tx.meta.postTokenBalances) - bal(tx.meta.preTokenBalances);
    if (delta <= BigInt(0)) continue;
    // The payer: the owner whose USDC balance went down (cash-outs default to this wallet).
    const pre = new Map((tx.meta.preTokenBalances ?? []).filter((b) => b.mint === m && b.owner && b.owner !== t).map((b) => [b.owner!, BigInt(b.uiTokenAmount.amount)]));
    const from = (tx.meta.postTokenBalances ?? []).find((b) => b.mint === m && b.owner && pre.has(b.owner) && BigInt(b.uiTokenAmount.amount) < pre.get(b.owner)!)?.owner;
    out.push({ signature: s.signature, cents: Number(delta / BigInt(UNITS_PER_CENT)), from });
  }
  return out;
}

/** Treasury sends `cents` of USDC to `to` (creating its token account if needed). Returns the signature. */
export async function sendUsdc(to: string, cents: number): Promise<string> {
  const { PublicKey } = await web3();
  const spl = await import("@solana/spl-token");
  const c = await connection();
  const payer = await treasury();
  const mintPk = await mint();
  const owner = new PublicKey(to);
  const from = await spl.getOrCreateAssociatedTokenAccount(c, payer, mintPk, payer.publicKey);
  const dest = await spl.getOrCreateAssociatedTokenAccount(c, payer, mintPk, owner, true);
  return spl.transferChecked(c, payer, from.address, mintPk, dest.address, payer, BigInt(cents) * BigInt(UNITS_PER_CENT), USDC_DECIMALS);
}

/**
 * Test money for a new player: mints test USDC when the treasury is the mint authority (our own test mint),
 * otherwise sends it from the treasury's balance; plus a little SOL so the player's wallet can pay fees.
 */
export async function faucet(to: string, cents = FAUCET_CENTS): Promise<{ usdcSig: string; solSig: string | null }> {
  const { PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = await web3();
  const spl = await import("@solana/spl-token");
  const c = await connection();
  const payer = await treasury();
  const mintPk = await mint();
  const owner = new PublicKey(to);
  const info = await spl.getMint(c, mintPk);
  let usdcSig: string;
  if (info.mintAuthority?.equals(payer.publicKey)) {
    const dest = await spl.getOrCreateAssociatedTokenAccount(c, payer, mintPk, owner, true);
    usdcSig = await spl.mintTo(c, payer, mintPk, dest.address, payer, BigInt(cents) * BigInt(UNITS_PER_CENT));
  } else {
    usdcSig = await sendUsdc(to, cents);
  }
  let solSig: string | null = null;
  const lamports = await c.getBalance(owner);
  if (lamports < FAUCET_LAMPORTS) {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: FAUCET_LAMPORTS }));
    solSig = await sendAndConfirmTransaction(c, tx, [payer], { commitment: "confirmed" });
  }
  return { usdcSig, solSig };
}
