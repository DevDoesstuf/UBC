// One-time devnet setup for MONEY_MODE=solana. Run from web/: `node scripts/solana-setup.mjs`
//
// 1st run (no SOLANA_TREASURY_SECRET_KEY in the environment): makes a treasury keypair and prints it.
//    Put the printed SOLANA_TREASURY_SECRET_KEY in web/.env.local / Vercel, then get devnet SOL for the printed
//    address at https://faucet.solana.com (the RPC airdrop is closed; this is a human step, ~1-5 SOL).
// 2nd run (SOLANA_TREASURY_SECRET_KEY set, treasury funded): creates a 6-decimal "test USDC" mint whose mint
//    authority is the treasury (so /faucet can mint for players), mints $1,000 to the treasury, prints USDC_MINT.
//    To use Circle's devnet USDC instead, set USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU and fund the
//    treasury at https://faucet.circle.com (then /faucet sends from the treasury's balance instead of minting).
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";

const rpc = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
if (/mainnet/i.test(rpc)) throw new Error("devnet only");
const secret = (process.env.SOLANA_TREASURY_SECRET_KEY || "").trim();

if (!secret) {
  const kp = Keypair.generate();
  console.log("Treasury address:", kp.publicKey.toBase58());
  console.log(`SOLANA_TREASURY_SECRET_KEY=${bs58.encode(kp.secretKey)}`);
  console.log("\nNext: fund that address with devnet SOL at https://faucet.solana.com, set the env var, run this again.");
  process.exit(0);
}

const kp = Keypair.fromSecretKey(secret.startsWith("[") ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret));
const c = new Connection(rpc, "confirmed");
const sol = (await c.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
console.log(`Treasury ${kp.publicKey.toBase58()} has ${sol} SOL on devnet`);
if (sol < 0.1) {
  console.log("Not enough SOL: fund it at https://faucet.solana.com first.");
  process.exit(1);
}
if (process.env.USDC_MINT) {
  console.log(`USDC_MINT already set (${process.env.USDC_MINT}); nothing to do.`);
  process.exit(0);
}
const mint = await createMint(c, kp, kp.publicKey, null, 6);
const ata = await getOrCreateAssociatedTokenAccount(c, kp, mint, kp.publicKey);
await mintTo(c, kp, mint, ata.address, kp, 1_000_000_000n); // $1,000 of test USDC
console.log(`USDC_MINT=${mint.toBase58()}`);
console.log("Set MONEY_MODE=solana, SOLANA_TREASURY_SECRET_KEY, USDC_MINT (and optionally SOLANA_RPC_URL), then restart.");
