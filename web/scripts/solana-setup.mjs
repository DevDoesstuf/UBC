// Devnet (or local validator) setup for MONEY_MODE=solana. Run from web/:
//
//   node scripts/solana-setup.mjs                    # devnet (SOLANA_RPC_URL or https://api.devnet.solana.com)
//   node scripts/solana-setup.mjs --write-env-local  # also merge the env lines into web/.env.local
//   node scripts/solana-setup.mjs --rpc http://127.0.0.1:8899 --dir /tmp/huddle-sol   # a local validator
//
// Safe to run again and again; each run picks up where the last one stopped:
//  1. Treasury key: SOLANA_TREASURY_SECRET_KEY from the environment, else <dir>/treasury.json, else a new one is
//     made and written to <dir>/treasury.json (solana-keygen format) and <dir>/treasury.secret (base58), both
//     mode 600. <dir> defaults to web/.solana/, which is gitignored. The secret is never printed.
//  2. SOL for fees: a local validator is airdropped automatically. On devnet the script tries the RPC airdrop
//     once (usually rate limited); otherwise it prints the treasury address to fund at https://faucet.solana.com
//     and stops. Run it again after funding.
//  3. Test USDC: USDC_MINT from the environment, else <dir>/mint-<cluster>.txt, else a new 6-decimal mint whose
//     mint authority is the treasury (so /faucet and cash-outs can mint). Tops the treasury up to $1,000.
//  4. Prints the env lines, writes <dir>/vercel.env (paste into Vercel > Settings > Environment Variables >
//     Import .env) and the exact `vercel env add` commands (the secret is piped from the file, never shown).
//
// Flags: --rpc <url>, --dir <path>, --write-env-local, --json (last line: {"treasury","mint","cluster","sol","usdc"}).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import bs58 from "bs58";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const DEVNET = "https://api.devnet.solana.com";
const GENESIS = { EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet", "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet" };
const rpc = (opt("--rpc") || process.env.SOLANA_RPC_URL || DEVNET).trim();
const dir = resolve(opt("--dir") || join(WEB, ".solana"));
const json = flag("--json");
const log = (...a) => console.log(...a);
const shown = (p) => (p.startsWith(WEB) ? relative(WEB, p) : p);
const MIN_SOL = 0.05;
const TARGET_USDC = 1_000_000_000n; // $1,000 (6 decimals)

if (/mainnet/i.test(rpc)) {
  console.error("Refusing a mainnet RPC: Huddle's Solana money is devnet test USDC only.");
  process.exit(1);
}

function writeSecretFile(path, text) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------- 1. treasury key
mkdirSync(dir, { recursive: true, mode: 0o700 });
const keyJson = join(dir, "treasury.json");
const keySecret = join(dir, "treasury.secret");
let kp;
let keySource;
const envSecret = (process.env.SOLANA_TREASURY_SECRET_KEY || "").trim();
if (envSecret) {
  kp = Keypair.fromSecretKey(envSecret.startsWith("[") ? Uint8Array.from(JSON.parse(envSecret)) : bs58.decode(envSecret));
  keySource = "SOLANA_TREASURY_SECRET_KEY (environment)";
} else if (existsSync(keyJson)) {
  kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyJson, "utf8"))));
  keySource = shown(keyJson);
} else {
  kp = Keypair.generate();
  keySource = `${shown(keyJson)} (new)`;
}
if (!existsSync(keyJson)) writeSecretFile(keyJson, JSON.stringify(Array.from(kp.secretKey)));
if (!existsSync(keySecret)) writeSecretFile(keySecret, bs58.encode(kp.secretKey));
const treasury = kp.publicKey.toBase58();
log(`Treasury address: ${treasury}`);
log(`  key from ${keySource}; secret kept in ${shown(keySecret)} (never printed)`);

// ---------------------------------------------------------------- 2. cluster + SOL
const c = new Connection(rpc, "confirmed");
let genesis;
try {
  genesis = await c.getGenesisHash();
} catch (e) {
  console.error(`Cannot reach ${rpc}: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const cluster = GENESIS[genesis] || "localnet";
if (cluster === "mainnet") {
  console.error("That RPC is mainnet. Refusing.");
  process.exit(1);
}
log(`Cluster: ${cluster} (${rpc.replace(/(api[-_]?key=)[^&]+/i, "$1***")})`);

let lamports = await c.getBalance(kp.publicKey);
if (lamports < MIN_SOL * LAMPORTS_PER_SOL) {
  const ask = cluster === "localnet" ? 10 : 1;
  try {
    const sig = await c.requestAirdrop(kp.publicKey, ask * LAMPORTS_PER_SOL);
    const bh = await c.getLatestBlockhash();
    await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    lamports = await c.getBalance(kp.publicKey);
    log(`  airdropped ${ask} SOL`);
  } catch (e) {
    log(`  RPC airdrop refused (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120)})`);
  }
}
const sol = lamports / LAMPORTS_PER_SOL;
log(`  balance: ${sol} SOL`);
if (lamports < MIN_SOL * LAMPORTS_PER_SOL) {
  log("");
  log("NEXT STEP (human): fund the treasury with devnet SOL");
  log("  1. Open https://faucet.solana.com");
  log("  2. Pick network: devnet");
  log(`  3. Paste this address: ${treasury}`);
  log("  4. Request 1-5 SOL (it may ask you to sign in with GitHub)");
  log("  5. Run this script again: node scripts/solana-setup.mjs");
  if (json) log(JSON.stringify({ treasury, mint: null, cluster, sol, usdc: null, needsSol: true }));
  process.exit(2);
}

// ---------------------------------------------------------------- 3. test USDC mint
const mintFile = join(dir, `mint-${cluster === "localnet" ? `localnet-${genesis.slice(0, 8)}` : cluster}.txt`);
let mintAddr = (process.env.USDC_MINT || "").trim() || (existsSync(mintFile) ? readFileSync(mintFile, "utf8").trim() : "");
let mint;
if (mintAddr) {
  const acct = await c.getAccountInfo(new PublicKey(mintAddr));
  if (!acct) {
    if (process.env.USDC_MINT) {
      console.error(`USDC_MINT ${mintAddr} does not exist on ${cluster}.`);
      process.exit(1);
    }
    mintAddr = ""; // stale file (validator was reset)
  } else mint = new PublicKey(mintAddr);
}
if (!mint) {
  mint = await createMint(c, kp, kp.publicKey, null, 6);
  mintAddr = mint.toBase58();
  writeFileSync(mintFile, mintAddr);
  log(`Created a 6-decimal test USDC mint: ${mintAddr} (mint authority: the treasury)`);
} else {
  log(`Test USDC mint: ${mintAddr}`);
}
const info = await getMint(c, mint);
if (info.decimals !== 6) {
  console.error(`USDC_MINT has ${info.decimals} decimals; Huddle needs 6.`);
  process.exit(1);
}
const isAuthority = !!info.mintAuthority?.equals(kp.publicKey);
const ata = await getOrCreateAssociatedTokenAccount(c, kp, mint, kp.publicKey);
let usdc = ata.amount;
if (isAuthority && usdc < TARGET_USDC / 2n) {
  await mintTo(c, kp, mint, ata.address, kp, TARGET_USDC - usdc);
  usdc = TARGET_USDC;
  log("  minted the treasury up to $1,000 of test USDC");
}
log(`  treasury USDC: $${(Number(usdc) / 1e6).toFixed(2)}${isAuthority ? "" : " (not the mint authority: fund it at https://faucet.circle.com)"}`);

// ---------------------------------------------------------------- 4. env lines
const secret = bs58.encode(kp.secretKey);
const lines = ["MONEY_MODE=solana", `USDC_MINT=${mintAddr}`];
if (rpc !== DEVNET) lines.push(`SOLANA_RPC_URL=${rpc}`);
const vercelEnv = join(dir, "vercel.env");
writeSecretFile(vercelEnv, [...lines, `SOLANA_TREASURY_SECRET_KEY=${secret}`].join("\n") + "\n");

log("");
log("Env vars (Vercel > Project > Settings > Environment Variables, and web/.env.local for local dev):");
for (const l of lines) log(`  ${l}`);
log(`  SOLANA_TREASURY_SECRET_KEY=<contents of ${shown(keySecret)}>`);
log("");
log(`All four lines, secret included, are in ${shown(vercelEnv)}: paste it into Vercel's "Import .env", or run:`);
log("  printf solana | npx vercel env add MONEY_MODE production");
log(`  printf ${mintAddr} | npx vercel env add USDC_MINT production`);
if (rpc !== DEVNET) log(`  printf '${rpc}' | npx vercel env add SOLANA_RPC_URL production`);
log(`  npx vercel env add SOLANA_TREASURY_SECRET_KEY production < ${shown(keySecret)}`);
log("Then redeploy and check /api/health: solana.active and solana.ready must both be true.");

if (flag("--write-env-local")) {
  const envLocal = join(WEB, ".env.local");
  const want = new Map([...lines, `SOLANA_TREASURY_SECRET_KEY=${secret}`].map((l) => [l.slice(0, l.indexOf("=")), l]));
  if (rpc === DEVNET) want.set("SOLANA_RPC_URL", null);
  const old = existsSync(envLocal) ? readFileSync(envLocal, "utf8").split("\n") : [];
  const out = [];
  for (const l of old) {
    const k = l.includes("=") && !l.trimStart().startsWith("#") ? l.slice(0, l.indexOf("=")).trim() : null;
    if (k && want.has(k)) {
      if (want.get(k)) out.push(want.get(k));
      want.delete(k);
    } else out.push(l);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const v of want.values()) if (v) out.push(v);
  writeSecretFile(envLocal, out.join("\n") + "\n");
  log(`Wrote the env lines into ${shown(envLocal)} (restart \`npm run dev\`).`);
}

if (json) log(JSON.stringify({ treasury, mint: mintAddr, cluster, sol, usdc: Number(usdc) / 1e6 }));
