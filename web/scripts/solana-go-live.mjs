// Go live on Solana devnet in one command, once the treasury has devnet SOL (https://faucet.solana.com). Run from web/:
//
//   node scripts/solana-go-live.mjs --dry-run     # check everything, change nothing, print what it would do
//   node scripts/solana-go-live.mjs               # do it
//
// Steps (each one is skipped when already done, so it is safe to run again):
//  1. Treasury: <dir>/treasury.json (made by scripts/solana-setup.mjs; <dir> defaults to web/.solana, gitignored).
//     Its secret is never printed. Checks the RPC is devnet (mainnet is refused).
//  2. SOL: deploying huddle_vault costs the rent of its program account (about 1.75 SOL for the 251 KB build) plus
//     fees; the treasury also needs a working reserve for parties. If it is short, prints exactly how much more to
//     request and stops (exit 2).
//  3. Program: deploys target/deploy/huddle_vault.so at the program id of the program keypair (default
//     ~/.config/huddle/devnet/huddle_vault-keypair.json = GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu, the id the
//     build declares), the treasury paying and holding the upgrade authority. Reused when already deployed.
//     The program needs no global initialization: each lobby creates its own Party PDA on its first deposit.
//  4. Test USDC: runs scripts/solana-setup.mjs (creates/reuses the 6-decimal mint, tops the treasury up to $1,000).
//  5. QuickNode: QUICKNODE_STREAM_TOKEN from <dir>/quicknode.token, generated when absent; writes
//     <dir>/quicknode-filter.js (web/quicknode/filter.js with the program id and the treasury token account filled in).
//  6. Vercel (project linked in --web, default web/): `vercel env add NAME production --force` for MONEY_MODE=solana,
//     SETTLEMENT=vault, HUDDLE_VAULT_PROGRAM_ID, USDC_MINT, SOLANA_TREASURY_SECRET_KEY and QUICKNODE_STREAM_TOKEN
//     (secrets piped from their files on stdin, never echoed), then `vercel deploy --prod --yes`.
//
// Flags: --dry-run, --dir <secrets dir>, --web <vercel-linked web dir>, --rpc <devnet url>, --so <file>,
//        --program-keypair <file>, --reserve <SOL kept for parties, default 0.25>, --skip-vercel, --skip-deploy-site.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = flag("--dry-run");
const DEVNET = "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const rpc = (opt("--rpc") || DEVNET).trim();
const webDir = resolve(opt("--web") || WEB);
const dir = resolve(opt("--dir") || join(webDir, ".solana"));
const soPath = resolve(opt("--so") || [join(WEB, "../target/deploy/huddle_vault.so"), join(homedir(), "Huddle/target/deploy/huddle_vault.so")].find(existsSync) || join(WEB, "../target/deploy/huddle_vault.so"));
const programKeypair = resolve(opt("--program-keypair") || join(homedir(), ".config/huddle/devnet/huddle_vault-keypair.json"));
const RESERVE_SOL = Number(opt("--reserve") || 0.25);
const SOLANA_BIN = join(homedir(), ".local/share/solana/install/active_release/bin");
const PATH = `${SOLANA_BIN}:${process.env.PATH}`;
const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n${n}. ${t}`);
const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
const fail = (msg, code = 1) => {
  console.error(`\n${msg}`);
  process.exit(code);
};
if (/mainnet/i.test(rpc)) fail("Refusing a mainnet RPC: Huddle runs on devnet only.");
log(`Huddle go-live on Solana devnet${DRY ? " (DRY RUN: nothing is sent, deployed, written or set)" : ""}`);

// ---------------------------------------------------------------- 1. treasury
step(1, "Treasury");
const keyJson = join(dir, "treasury.json");
const keySecret = join(dir, "treasury.secret");
if (!existsSync(keyJson) || !existsSync(keySecret)) fail(`No treasury in ${dir}. Run \`node scripts/solana-setup.mjs\` first (it makes the key).`);
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyJson, "utf8"))));
log(`  address ${treasury.publicKey.toBase58()} (secret in ${keySecret}, never printed)`);
const c = new Connection(rpc, "confirmed");
const genesis = await c.getGenesisHash().catch((e) => fail(`Cannot reach ${rpc}: ${e.message}`));
if (genesis === MAINNET_GENESIS) fail("That RPC is mainnet. Refusing.");
const cluster = genesis === DEVNET_GENESIS ? "devnet" : "localnet";
log(`  cluster ${cluster} (${rpc.replace(/(api[-_]?key=)[^&]+/i, "$1***")})`);

// ---------------------------------------------------------------- 2. SOL needed
step(2, "SOL");
if (!existsSync(programKeypair)) fail(`Program keypair not found: ${programKeypair} (pass --program-keypair)`);
const programId = new PublicKey(execFileSync(join(SOLANA_BIN, "solana-keygen"), ["pubkey", programKeypair], { encoding: "utf8" }).trim());
const programAcct = await c.getAccountInfo(programId);
const deployed = !!programAcct?.executable;
const balance = await c.getBalance(treasury.publicKey);
let deployLamports = 0;
if (!deployed) {
  if (!existsSync(soPath)) fail(`Program binary not found: ${soPath} (pass --so)`);
  const len = statSync(soPath).size;
  // Upgradeable loader: ProgramData account (45-byte header + the program) and the 36-byte Program account, rent
  // exempt; plus about one 5,000-lamport fee per ~1 KB write transaction and the final deploy.
  const rentData = await c.getMinimumBalanceForRentExemption(len + 45);
  const rentProgram = await c.getMinimumBalanceForRentExemption(36);
  const fees = (Math.ceil(len / 1000) + 10) * 5000;
  deployLamports = rentData + rentProgram + fees;
  log(`  deploy: ${sol(deployLamports)} SOL (program data rent ${sol(rentData)} + program account ${sol(rentProgram)} + ~${sol(fees)} fees, ${len} byte build)`);
} else {
  log(`  program already deployed at ${programId.toBase58()}: no deploy cost`);
}
const reserve = Math.round(RESERVE_SOL * LAMPORTS_PER_SOL);
const need = deployLamports + reserve;
log(`  working reserve: ${sol(reserve)} SOL (mint + token accounts, party and member accounts, fees)`);
log(`  treasury has ${sol(balance)} SOL, needs ${sol(need)} SOL`);
if (balance < need) {
  const more = need - balance;
  log("");
  log(`  SHORT by ${sol(more)} SOL. Fund the treasury, then run this again:`);
  log("    1. Open https://faucet.solana.com (sign in with GitHub for the larger amounts)");
  log("    2. Network: Devnet");
  log(`    3. Address: ${treasury.publicKey.toBase58()}`);
  log(`    4. Amount: ${Math.max(2, Math.ceil(more / LAMPORTS_PER_SOL))} SOL or more (5 is the faucet's maximum per request)`);
  if (!DRY) process.exit(2);
  log("  (dry run: carrying on to show the remaining steps)");
}

// ---------------------------------------------------------------- 3. deploy the program
step(3, "huddle_vault program");
let deploySig = null;
const deployArgs = ["program", "deploy", "--url", rpc, "--keypair", keyJson, "--program-id", programKeypair, soPath, "--output", "json"];
if (deployed) {
  log(`  reusing ${programId.toBase58()} (already deployed)`);
} else if (DRY) {
  log(`  would run: solana ${deployArgs.join(" ")}`);
} else {
  const out = execFileSync(join(SOLANA_BIN, "solana"), deployArgs, { encoding: "utf8", env: { ...process.env, PATH }, stdio: ["ignore", "pipe", "inherit"] });
  const j = JSON.parse(out.slice(out.indexOf("{")));
  deploySig = j.signature ?? null;
  log(`  deployed ${j.programId}`);
  log(`  deploy signature ${deploySig}`);
  if (!(await c.getAccountInfo(programId))?.executable) fail("The deploy finished but the program is not executable yet. Run this again in a minute.");
}
log(`  program id ${programId.toBase58()}`);
log(`  explorer https://explorer.solana.com/address/${programId.toBase58()}?cluster=${cluster === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent(rpc)}`}`);
log("  no global initialization needed: each lobby creates its own Party PDA on its first deposit");

// ---------------------------------------------------------------- 4. test USDC
step(4, "Test USDC mint");
const mintFile = join(dir, cluster === "devnet" ? "mint-devnet.txt" : `mint-localnet-${genesis.slice(0, 8)}.txt`);
let mint = existsSync(mintFile) ? readFileSync(mintFile, "utf8").trim() : "";
if (mint && !(await c.getAccountInfo(new PublicKey(mint)))) mint = "";
if (DRY) {
  log(mint ? `  reusing ${mint}` : "  would run scripts/solana-setup.mjs: create a 6-decimal test USDC mint (authority: the treasury) and mint $1,000 to the treasury");
} else {
  const env = { ...process.env, PATH };
  delete env.SOLANA_TREASURY_SECRET_KEY;
  delete env.USDC_MINT;
  const out = execFileSync("node", [join(WEB, "scripts/solana-setup.mjs"), "--rpc", rpc, "--dir", dir, "--json"], { cwd: WEB, encoding: "utf8", env });
  const j = JSON.parse(out.trim().split("\n").pop());
  if (!j.mint) fail("solana-setup.mjs did not produce a mint (is the treasury funded?)");
  mint = j.mint;
  log(`  mint ${mint}; treasury holds $${j.usdc} of test USDC`);
}
const treasuryAta = mint ? getAssociatedTokenAddressSync(new PublicKey(mint), treasury.publicKey).toBase58() : null;

// ---------------------------------------------------------------- 5. QuickNode
step(5, "QuickNode Stream token and filter");
const tokenFile = join(dir, "quicknode.token");
let qnToken = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
if (!qnToken) {
  if (DRY) log(`  would generate QUICKNODE_STREAM_TOKEN into ${tokenFile} (mode 600)`);
  else {
    qnToken = randomBytes(24).toString("hex");
    writeFileSync(tokenFile, qnToken, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
    log(`  generated QUICKNODE_STREAM_TOKEN into ${tokenFile} (never printed)`);
  }
} else log(`  reusing QUICKNODE_STREAM_TOKEN from ${tokenFile}`);
const filterOut = join(dir, "quicknode-filter.js");
if (treasuryAta) {
  const src = readFileSync(join(WEB, "quicknode/filter.js"), "utf8")
    .replace(/var HUDDLE_PROGRAM_ID = '[^']*';/, `var HUDDLE_PROGRAM_ID = '${programId.toBase58()}';`)
    .replace(/var WATCH_ACCOUNTS = \[[^\]]*\];/, `var WATCH_ACCOUNTS = ['${treasuryAta}']; // the treasury's USDC token account`);
  if (DRY) log(`  would write ${filterOut}`);
  else writeFileSync(filterOut, src);
}
log(`  filter values: HUDDLE_PROGRAM_ID = '${programId.toBase58()}', WATCH_ACCOUNTS = ['${treasuryAta ?? "<treasury USDC token account: known once the mint exists>"}']`);
log("  webhook: https://huddle-live-eight.vercel.app/api/quicknode/webhook, custom header x-huddle-token: <QUICKNODE_STREAM_TOKEN>");

// ---------------------------------------------------------------- 6. Vercel
step(6, "Vercel env (production) and deploy");
const vars = [
  { name: "MONEY_MODE", value: "solana" },
  { name: "SETTLEMENT", value: "vault" },
  { name: "HUDDLE_VAULT_PROGRAM_ID", value: programId.toBase58() },
  { name: "USDC_MINT", value: mint || null },
  { name: "SOLANA_TREASURY_SECRET_KEY", file: keySecret, sensitive: true },
  { name: "QUICKNODE_STREAM_TOKEN", file: tokenFile, sensitive: true },
];
if (rpc !== DEVNET) vars.push({ name: "SOLANA_RPC_URL", value: rpc, sensitive: true });
const linked = existsSync(join(webDir, ".vercel/project.json"));
if (flag("--skip-vercel")) log("  skipped (--skip-vercel)");
else {
  if (!linked) fail(`${webDir} is not linked to Vercel (no .vercel/project.json). Pass --web <dir>, or run \`vercel link\` there.`);
  const project = JSON.parse(readFileSync(join(webDir, ".vercel/project.json"), "utf8")).projectName;
  log(`  project ${project} (from ${webDir}/.vercel)`);
  for (const v of vars) {
    const cmd = ["env", "add", v.name, "production", "--force", ...(v.sensitive ? ["--sensitive"] : [])];
    const shown = v.file ? `< ${v.file}` : v.value === null ? "< (the mint, once created)" : `<<< ${v.value}`;
    if (DRY) {
      log(`  would run: vercel ${cmd.join(" ")} ${shown}`);
      continue;
    }
    const input = v.file ? readFileSync(v.file, "utf8").trim() : v.value;
    if (!input) fail(`No value for ${v.name}`);
    const r = spawnSync("vercel", cmd, { cwd: webDir, input, encoding: "utf8", stdio: ["pipe", "ignore", "pipe"] });
    if (r.status !== 0) fail(`vercel env add ${v.name} failed: ${(r.stderr || "").replace(input, "***").slice(0, 400)}`);
    log(`  set ${v.name}${v.sensitive ? " (sensitive, piped)" : ` = ${input}`}`);
  }
  if (flag("--skip-deploy-site")) log("  site deploy skipped (--skip-deploy-site)");
  else if (DRY) log(`  would run: vercel deploy --prod --yes (in ${webDir})`);
  else {
    const r = spawnSync("vercel", ["deploy", "--prod", "--yes"], { cwd: webDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
    if (r.status !== 0) fail("vercel deploy failed");
    log(`  deployed ${r.stdout.trim().split("\n").pop()}`);
  }
}

log("\nDone." + (DRY ? " (dry run)" : ""));
log("Check https://huddle-live-eight.vercel.app/api/health: money.settlement \"vault\", solana.ready and solana.vault.ready true.");
log("Then create the QuickNode Stream (web/CONTRACT.md, \"QuickNode Stream setup\") with the filter file above.");
log(JSON.stringify({ dryRun: DRY, cluster, treasury: treasury.publicKey.toBase58(), programId: programId.toBase58(), deployed: deployed || !!deploySig, deploySignature: deploySig, mint: mint || null, treasuryUsdcAccount: treasuryAta, solNeeded: sol(need), solHave: sol(balance) }));
