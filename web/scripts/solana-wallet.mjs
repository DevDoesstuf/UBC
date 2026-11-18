// A tiny devnet/localnet "wallet" for testing Huddle's Solana Pay flow without a phone. It does what Phantom,
// Solflare or @solana/pay's createTransfer do with a `solana:` transfer request: parse the URL, then send ONE
// transaction with an optional SPL Memo instruction followed by a transferChecked from the payer's associated
// token account to the recipient's, with every `reference` key appended as a read-only, non-signer account.
//
//   node scripts/solana-wallet.mjs new <keypair.json>                       make a wallet (prints its address)
//   node scripts/solana-wallet.mjs pay '<solana:...>' --keypair <file>      pay a transfer request
//   node scripts/solana-wallet.mjs balance <address> --mint <USDC_MINT>     SOL and token balance
// --rpc <url> or SOLANA_RPC_URL (default devnet). Mainnet is refused.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAccount, getAssociatedTokenAddress, getMint } from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Parses a Solana Pay transfer request the way @solana/pay's parseURL does (and rejects what it rejects). */
export function parseTransferRequest(input) {
  if (input.length > 2048) throw new Error("URL length invalid");
  const url = new URL(input);
  if (url.protocol !== "solana:") throw new Error("protocol invalid");
  if (!url.pathname) throw new Error("pathname missing");
  if (/[:%]/.test(url.pathname)) throw new Error("this is a transaction request, not a transfer request");
  const recipient = new PublicKey(url.pathname);
  const amountParam = url.searchParams.get("amount");
  let amount;
  if (amountParam != null) {
    if (!/^\d+(\.\d+)?$/.test(amountParam)) throw new Error("amount invalid");
    amount = amountParam;
  }
  const splTokenParam = url.searchParams.get("spl-token");
  const splToken = splTokenParam ? new PublicKey(splTokenParam) : undefined;
  const reference = url.searchParams.getAll("reference").map((r) => new PublicKey(r));
  return {
    recipient,
    amount,
    splToken,
    reference: reference.length ? reference : undefined,
    label: url.searchParams.get("label") ?? undefined,
    message: url.searchParams.get("message") ?? undefined,
    memo: url.searchParams.get("memo") ?? undefined,
  };
}

/** "10.5" with 6 decimals -> 10500000n. Refuses more decimals than the mint has (as wallets do). */
export function toBaseUnits(amount, decimals) {
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`amount has ${frac.length} decimals; the token has ${decimals}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** Builds the payment transaction exactly like @solana/pay's createTransfer for an SPL token. */
export async function buildTransfer(connection, sender, req) {
  if (!req.splToken) throw new Error("only spl-token transfer requests are supported here");
  if (!req.amount) throw new Error("the request has no amount");
  const mint = await getMint(connection, req.splToken);
  const tokens = toBaseUnits(req.amount, mint.decimals);
  const senderATA = await getAssociatedTokenAddress(req.splToken, sender);
  const senderAccount = await getAccount(connection, senderATA);
  if (!senderAccount.isInitialized) throw new Error("sender not initialized");
  if (tokens > senderAccount.amount) throw new Error("insufficient funds");
  const recipientATA = await getAssociatedTokenAddress(req.splToken, req.recipient);
  const recipientAccount = await getAccount(connection, recipientATA);
  if (!recipientAccount.isInitialized) throw new Error("recipient not initialized");
  const ix = createTransferCheckedInstruction(senderATA, req.splToken, recipientATA, sender, tokens, mint.decimals);
  for (const pubkey of req.reference ?? []) ix.keys.push({ pubkey, isWritable: false, isSigner: false });
  const tx = new Transaction();
  if (req.memo != null) tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(req.memo, "utf8") }));
  tx.add(ix);
  return tx;
}

/** Pays a `solana:` transfer request from `payer` (a Keypair). Returns the signature. */
export async function payUrl(connection, payer, url) {
  const req = parseTransferRequest(url);
  const tx = await buildTransfer(connection, payer.publicKey, req);
  return sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
}

export async function tokenBalance(connection, owner, mint) {
  try {
    const ata = await getAssociatedTokenAddress(new PublicKey(mint), new PublicKey(owner), true);
    return (await getAccount(connection, ata)).amount;
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const opt = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const rpc = opt("--rpc") || process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  if (/mainnet/i.test(rpc)) throw new Error("devnet/localnet only");
  const connection = new Connection(rpc, "confirmed");
  const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8"))));
  if (cmd === "new" && arg) {
    const kp = Keypair.generate();
    writeFileSync(arg, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    console.log(kp.publicKey.toBase58());
  } else if (cmd === "pay" && arg && opt("--keypair")) {
    const req = parseTransferRequest(arg);
    console.log(`Paying ${req.amount} of ${req.splToken?.toBase58()} to ${req.recipient.toBase58()} (${req.label ?? ""}: ${req.message ?? ""})`);
    console.log(await payUrl(connection, load(opt("--keypair")), arg));
  } else if (cmd === "balance" && arg) {
    console.log(`SOL ${(await connection.getBalance(new PublicKey(arg))) / LAMPORTS_PER_SOL}`);
    if (opt("--mint")) console.log(`token ${Number(await tokenBalance(connection, arg, opt("--mint"))) / 1e6}`);
  } else {
    console.log("usage: new <keypair.json> | pay '<solana:url>' --keypair <file> | balance <address> [--mint <mint>]   [--rpc <url>]");
    process.exit(1);
  }
}
