// Opt-in end-to-end test of SETTLEMENT=vault against a LOCAL validator: `npm run test:vault-localnet`.
// Not part of `npm test` (needs the Agave CLI, the built program and about two minutes).
//
// A whole party on chain, the way phones and wallets do it:
//   validator (started here with huddle_vault loaded, unless SOLANA_RPC_URL already answers; then the program is
//   deployed with `solana program deploy` if missing) -> scripts/solana-setup.mjs (treasury + test mint) ->
//   `next dev` with MONEY_MODE=solana SETTLEMENT=vault QUICKNODE_STREAM_TOKEN=... ->
//   faucet -> Alice pays a Solana Pay URL (scripts/solana-wallet.mjs, a transferChecked with the reference as a
//   read-only key, exactly like Phantom) and polling credits it -> Bob pays, and a QuickNode-style delivery (the real
//   block from the validator run through web/quicknode/filter.js) credits it through the webhook -> Carol pays on the
//   box (lobby.boxPay; the lobby read path finds it) -> every deposit is swept into the party vault PDA by the
//   program -> buy, lock, resolve, end -> on-chain settlement (request_close, Ed25519-verified submit_state, finalize,
//   withdraw to each wallet, withdraw_host) -> balances checked on chain against the lobby.
// Env: SOLANA_RPC_URL (default http://127.0.0.1:18899), E2E_PORT (default 3432), HUDDLE_VAULT_SO (default
// ../target/deploy/huddle_vault.so from the repo root, or /Users/.../Huddle/target/deploy), HUDDLE_VAULT_KEYPAIR
// (program keypair; default ~/.config/huddle/devnet/huddle_vault-keypair.json), VAULT_E2E_LOG=1 prints signatures.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import vm from "node:vm";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { payUrl, tokenBalance } from "../scripts/solana-wallet.mjs";

const WEB = resolve(import.meta.dirname, "..");
const RPC = process.env.SOLANA_RPC_URL || "http://127.0.0.1:18899";
const PORT = Number(process.env.E2E_PORT || 3432);
const PROGRAM_ID = process.env.HUDDLE_VAULT_PROGRAM_ID || "GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu";
const SO = process.env.HUDDLE_VAULT_SO || [join(WEB, "../target/deploy/huddle_vault.so"), join(homedir(), "Huddle/target/deploy/huddle_vault.so")].find(existsSync) || "";
const PROGRAM_KP = process.env.HUDDLE_VAULT_KEYPAIR || join(homedir(), ".config/huddle/devnet/huddle_vault-keypair.json");
const BIN = join(homedir(), ".local/share/solana/install/active_release/bin");
const TOKEN = randomBytes(16).toString("hex");
const LOG = process.env.VAULT_E2E_LOG === "1";
const children: ChildProcess[] = [];
const tmp = mkdtempSync(join(tmpdir(), "huddle-vault-e2e-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = new Connection(RPC, "confirmed");
const sigs: Record<string, string> = {};
const note = (k: string, sig: string) => {
  sigs[k] = sig;
  if (LOG) console.log(`  ${k}: ${sig}`);
};

const rpcUp = () => conn.getGenesisHash().then(() => true, () => false);
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children.reverse()) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
after(() => {
  if (LOG) console.log(JSON.stringify(sigs, null, 2));
  cleanup();
});
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => process.exit(130));

// ---------------------------------------------------------------- environment
assert.ok(SO && existsSync(SO), "huddle_vault.so not found: set HUDDLE_VAULT_SO");
if (!(await rpcUp())) {
  const port = new URL(RPC).port || "8899";
  const v = spawn(join(BIN, "solana-test-validator"), ["--reset", "--quiet", "--ledger", join(tmp, "ledger"), "--rpc-port", port, "--faucet-port", String(Number(port) + 1001), "--bpf-program", PROGRAM_ID, SO], { detached: true, stdio: "ignore", cwd: tmp });
  v.unref();
  children.push(v);
  for (let i = 0; i < 60 && !(await rpcUp()); i++) await sleep(1000);
  assert.ok(await rpcUp(), "local validator did not start");
}
const genesis = await conn.getGenesisHash();
assert.ok(!["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesis), "this test only runs on a local validator");

const solDir = join(tmp, "sol");
const setup = JSON.parse(execFileSync("node", ["scripts/solana-setup.mjs", "--rpc", RPC, "--dir", solDir, "--json"], { cwd: WEB, encoding: "utf8" }).trim().split("\n").pop()!);
const SECRET = readFileSync(join(solDir, "treasury.secret"), "utf8").trim();
const TREASURY: string = setup.treasury;
const MINT: string = setup.mint;
const TREASURY_ATA = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(TREASURY)).toBase58();

if (!(await conn.getAccountInfo(new PublicKey(PROGRAM_ID)))?.executable) {
  // A validator that was already running: deploy the built program like the devnet go-live does.
  execFileSync(join(BIN, "solana"), ["program", "deploy", "--url", RPC, "--keypair", join(solDir, "treasury.json"), "--program-id", PROGRAM_KP, SO], { stdio: "inherit" });
}
assert.ok((await conn.getAccountInfo(new PublicKey(PROGRAM_ID)))?.executable, "the vault program is deployed");

const BASE = `http://localhost:${PORT}`;
{
  const env = { ...process.env, MONEY_MODE: "solana", SETTLEMENT: "vault", HUDDLE_VAULT_PROGRAM_ID: PROGRAM_ID, SOLANA_TREASURY_SECRET_KEY: SECRET, USDC_MINT: MINT, SOLANA_RPC_URL: RPC, GEMINI_DISABLED: "1", KIOSK_KEY: "", QUICKNODE_STREAM_TOKEN: TOKEN };
  const s = spawn("npx", ["next", "dev", "--webpack", "-p", String(PORT)], { cwd: WEB, env, detached: true, stdio: "ignore" });
  s.unref();
  children.push(s);
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(1000);
  }
}

type J = Record<string, any>;
async function call(path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<{ status: number; j: J }> {
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-player-token": token } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as J };
}
const ok = async (path: string, body?: unknown, token?: string) => {
  const r = await call(path, body, token);
  assert.equal(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.j)}`);
  return r.j;
};
const cents = async (owner: string) => Number(await tokenBalance(conn, owner, MINT)) / 1e4;
const vaultCents = async (vault: string) => Number((await conn.getTokenAccountBalance(new PublicKey(vault))).value.amount) / 1e4;
const view = (code: string, token?: string) => ok(`/api/lobby/${code}`, undefined, token);
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, tries = 30, ms = 1000): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------- the party
const kiosk = `v${Date.now() % 100000}`;
let code = "";
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate();
const tok: Record<string, string> = {};
let vaultAddr = "";

test("health: Solana active, vault program deployed and ready, QuickNode webhook configured", async () => {
  const h = await ok("/api/health");
  assert.equal(h.money.mode, "solana", JSON.stringify(h.solana));
  assert.equal(h.money.settlement, "vault");
  assert.equal(h.solana.ready, true, JSON.stringify(h.solana.problems));
  assert.equal(h.solana.vault.programId, PROGRAM_ID);
  assert.equal(h.solana.vault.executable, true);
  assert.equal(h.solana.vault.ready, true, JSON.stringify(h.solana.vault));
  assert.equal(h.quicknode.configured, true);
});

test("lobby, three players, faucet", async () => {
  code = (await ok("/api/lobby", { game: "football", kiosk })).code;
  for (const [n, kp] of [["Alice", alice], ["Bob", bob], ["Carol", carol]] as const) {
    tok[n] = (await ok(`/api/lobby/${code}/join`, { name: n })).token;
    const f = await ok(`/api/lobby/${code}/faucet`, { address: kp.publicKey.toBase58() }, tok[n]);
    note(`faucet ${n}`, f.usdcSig);
  }
  assert.equal(await cents(alice.publicKey.toBase58()), 2000);
});

test("Alice: Solana Pay deposit, credited by polling, swept into the party vault by the program", async () => {
  const d = await ok(`/api/lobby/${code}/deposit`, { cents: 1000 }, tok.Alice);
  assert.equal(d.vault, true);
  assert.equal(d.recipient, TREASURY, "the transfer request names the treasury wallet (spec: a wallet, not a PDA token account)");
  const sig = await payUrl(conn, alice, d.url);
  note("deposit Alice (Solana Pay)", sig);
  const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  assert.ok(tx!.transaction.message.accountKeys.some((k) => k.pubkey.toBase58() === d.reference && !k.signer && !k.writable), "reference is a read-only non-signer key");
  const s = await until("credit", async () => {
    const r = await ok(`/api/lobby/${code}/deposit/sync`, {}, tok.Alice);
    return r.credited > 0 ? r : null;
  }, 10, 3000);
  assert.equal(s.credited, 1000);
  // The sweep runs right after the credit (in the background); /settle runs it now and waits.
  const st = await ok(`/api/lobby/${code}/settle`, {});
  assert.equal(st.status, "open");
  const v = await view(code, tok.Alice);
  assert.equal(v.chain.settlement, "vault");
  vaultAddr = v.chain.vault;
  const sweep = v.chain.events.find((e: J) => e.kind === "sweep");
  assert.ok(sweep, JSON.stringify(v.chain));
  note("create_party", v.chain.events.find((e: J) => e.kind === "create").sig);
  note("sweep Alice (vault deposit)", sweep.sig);
  assert.equal(await vaultCents(vaultAddr), 1000, "the party vault PDA holds Alice's $10");
});

test("Bob: deposit credited instantly by a QuickNode Stream delivery (real block -> filter.js -> webhook)", async () => {
  const d = await ok(`/api/lobby/${code}/deposit`, { cents: 500 }, tok.Bob);
  const sig = await payUrl(conn, bob, d.url);
  note("deposit Bob (Solana Pay)", sig);
  const slot = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))!.slot;
  const block = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlock", params: [slot, { encoding: "json", maxSupportedTransactionVersion: 0, transactionDetails: "full", rewards: false, commitment: "confirmed" }] }),
  }).then((r) => r.json()).then((j) => j.result);
  // The filter exactly as QuickNode runs it: a bare sandbox, configured like the dashboard copy.
  const src = readFileSync(join(WEB, "quicknode/filter.js"), "utf8").replace(/var WATCH_ACCOUNTS = \[[^\]]*\];/, `var WATCH_ACCOUNTS = ['${TREASURY_ATA}'];`).replace(/var HUDDLE_PROGRAM_ID = '[^']*';/, `var HUDDLE_PROGRAM_ID = '${PROGRAM_ID}';`);
  const main = vm.runInNewContext(`${src}\n;main`, {});
  const records = main({ data: [block], metadata: { network: "solana-devnet", dataset: "block", batch_start_range: slot, batch_end_range: slot } });
  assert.ok(Array.isArray(records) && records.some((r: J) => r.signature === sig && r.watched.includes(TREASURY_ATA)), "the filter keeps Bob's payment");
  const body = JSON.stringify(records);
  // Wrong or missing auth: refused.
  assert.equal((await call("/api/quicknode/webhook", body, undefined, { "x-huddle-token": "nope" })).status, 401);
  assert.equal((await call("/api/quicknode/webhook", body)).status, 401);
  // QuickNode's own HMAC signature with the shared token.
  const nonce = randomBytes(8).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const hmac = createHmac("sha256", TOKEN).update(nonce + ts + body).digest("hex");
  const w = await call("/api/quicknode/webhook", body, undefined, { "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": hmac });
  assert.equal(w.status, 200, JSON.stringify(w.j));
  assert.equal(w.j.credited, 500);
  // Redelivery (QuickNode retries) never credits twice.
  const again = await call("/api/quicknode/webhook", body, undefined, { "x-huddle-token": TOKEN });
  assert.equal(again.j.credited, 0);
  const me = (await view(code, tok.Bob)).me;
  assert.equal(me.balance, 500);
  assert.equal(me.solanaAddress, bob.publicKey.toBase58());
  const ev = (await view(code)).chain.events.find((e: J) => e.kind === "deposit" && e.sig === sig);
  assert.equal(ev.via, "quicknode");
  assert.equal(ev.streamed, true);
});

test("Carol pays on the box: boxPay appears, the lobby read path finds the payment, then it clears", async () => {
  const b = await ok(`/api/lobby/${code}/deposit/box`, { cents: 1000 }, tok.Carol);
  let v = await view(code, tok.Carol);
  assert.equal(v.boxPay.name, "Carol");
  assert.equal(v.boxPay.cents, 1000);
  assert.equal(v.boxPay.mine, true);
  assert.equal(v.boxPay.url, b.url);
  assert.ok(v.boxPay.until > Date.now() + 60_000);
  const sig = await payUrl(conn, carol, b.url);
  note("deposit Carol (Solana Pay on the box)", sig);
  v = await until("box payment seen", async () => {
    const x = await view(code);
    return x.boxPay?.paidAt ? x : null;
  }, 15, 1000);
  assert.equal(v.players.find((p: J) => p.name === "Carol").balance, 1000);
  await until("boxPay cleared", async () => ((await view(code)).boxPay === null ? true : null), 10, 1000);
});

test("game: buy, lock, resolve; deposits all in the vault", async () => {
  await ok(`/api/lobby/${code}/settle`, {});
  assert.equal(await vaultCents(vaultAddr), 2500, "vault holds every deposit");
  await ok("/api/kiosk/touch", { kiosk, id: "start" });
  await ok(`/api/lobby/${code}/buy`, { side: "yes", cents: 500 }, tok.Alice);
  await ok(`/api/lobby/${code}/buy`, { side: "no", cents: 300 }, tok.Bob);
  await ok(`/api/lobby/${code}/buy`, { side: "yes", cents: 200 }, tok.Carol);
  // Cashing out before the end is refused: the program only pays after settlement.
  assert.equal((await call(`/api/lobby/${code}/cashout`, {}, tok.Alice)).status, 400);
  await ok("/api/kiosk/touch", { kiosk, id: "lock" });
  await ok("/api/kiosk/touch", { kiosk, id: "resolve:yes" });
  await ok("/api/kiosk/touch", { kiosk, id: "end" });
});

test("settlement on chain: signed balances verified by the program, payouts in each wallet, vault empty", async () => {
  const v0 = await view(code);
  const bal = Object.fromEntries(v0.players.map((p: J) => [p.name, p.balance]));
  const before = { Alice: await cents(alice.publicKey.toBase58()), Bob: await cents(bob.publicKey.toBase58()), Carol: await cents(carol.publicKey.toBase58()) };
  const tBefore = await cents(TREASURY);
  const st = await ok(`/api/lobby/${code}/settle`, {});
  assert.equal(st.error, undefined, st.error);
  assert.equal(st.status, "settled", JSON.stringify(st));
  const v = await view(code, tok.Alice);
  const kinds = v.chain.events.map((e: J) => e.kind);
  for (const k of ["create", "sweep", "close", "state", "finalize", "withdraw"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  assert.ok(v.chain.settled);
  assert.match(v.chain.settleTx.explorer, /explorer\.solana\.com\/tx\/.+cluster=custom/);
  for (const e of v.chain.events) if (!["deposit", "faucet"].includes(e.kind)) note(`${e.kind}${e.name ? ` ${e.name}` : ""}`, e.sig);
  // The house made money or lost it: either way the vault ends empty and everyone has exactly their balance.
  assert.equal(await cents(alice.publicKey.toBase58()), before.Alice + bal.Alice);
  assert.equal(await cents(bob.publicKey.toBase58()), before.Bob + bal.Bob);
  assert.equal(await cents(carol.publicKey.toBase58()), before.Carol + bal.Carol);
  assert.equal(await vaultCents(vaultAddr), 0, "vault is empty");
  const total = bal.Alice + bal.Bob + bal.Carol;
  // The treasury gets the house's share back through withdraw_host, or paid a top-up when the room won.
  assert.equal(await cents(TREASURY), tBefore + 2500 - total, "treasury: house share back (or top-up paid)");
  assert.equal(v.chain.payout.cents, bal.Alice);
  assert.equal(v.me.balance, 0);
  // The finalize tx and a submit_state tx on chain: the Ed25519 program ran before submit_state.
  const stateTx = await conn.getParsedTransaction(v.chain.events.find((e: J) => e.kind === "state").sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const progs = stateTx!.transaction.message.instructions.map((i) => i.programId.toBase58());
  assert.equal(progs[0], "Ed25519SigVerify111111111111111111111111111");
  assert.equal(progs[1], PROGRAM_ID);
  // Cash-out after the fact returns the payout instead of paying twice.
  const c = await ok(`/api/lobby/${code}/cashout`, {}, tok.Alice);
  assert.equal(c.vault, true);
  assert.equal(c.cents, bal.Alice);
  assert.equal((await ok(`/api/lobby/${code}/settle`, {})).status, "settled", "settling again is a no-op");
});

test("a second party where the house wins: zero payout, the house share comes back through withdraw_host", async () => {
  const k2 = `${kiosk}h`;
  const c2 = (await ok("/api/lobby", { game: "football", kiosk: k2 })).code;
  const dave = Keypair.generate();
  const t = (await ok(`/api/lobby/${c2}/join`, { name: "Dave" })).token;
  await ok(`/api/lobby/${c2}/faucet`, { address: dave.publicKey.toBase58() }, t);
  const d = await ok(`/api/lobby/${c2}/deposit`, { cents: 500 }, t);
  await payUrl(conn, dave, d.url);
  await until("credit", async () => ((await ok(`/api/lobby/${c2}/deposit/sync`, {}, t)).credited > 0 ? true : null), 10, 3000);
  await ok(`/api/lobby/${c2}/settle`, {});
  await ok("/api/kiosk/touch", { kiosk: k2, id: "start" });
  await ok(`/api/lobby/${c2}/buy`, { side: "yes", cents: 500 }, t);
  await ok("/api/kiosk/touch", { kiosk: k2, id: "lock" });
  await ok("/api/kiosk/touch", { kiosk: k2, id: "resolve:no" });
  await ok("/api/kiosk/touch", { kiosk: k2, id: "end" });
  const tBefore = await cents(TREASURY);
  const daveBefore = await cents(dave.publicKey.toBase58());
  const st = await ok(`/api/lobby/${c2}/settle`, {});
  assert.equal(st.status, "settled", JSON.stringify(st));
  const kinds = st.chain.events.map((e: J) => e.kind);
  assert.ok(kinds.includes("host") && !kinds.includes("topup"), String(kinds));
  for (const e of st.chain.events) if (["host", "finalize", "withdraw"].includes(e.kind)) note(`house-wins ${e.kind}`, e.sig);
  assert.equal(await cents(dave.publicKey.toBase58()), daveBefore, "Dave lost his stake: nothing paid");
  assert.equal(await cents(TREASURY), tBefore + 500, "the house share came back to the treasury");
  assert.equal(await vaultCents(st.chain.vault), 0);
});
