// Opt-in end-to-end test of MONEY_MODE=solana against a LOCAL validator: `npm run test:localnet`.
// Not part of `npm test` (it needs the Agave CLI and takes about a minute).
//
// What it does, like a real party with Phantom wallets:
//   validator (started here unless SOLANA_RPC_URL already answers) -> scripts/solana-setup.mjs (treasury + 6-decimal
//   test mint) -> `next dev` with MONEY_MODE=solana (unless HUDDLE_URL points at a server already running with the
//   same env) -> faucet -> deposit (Solana Pay URL paid by scripts/solana-wallet.mjs exactly like a wallet) ->
//   /deposit/sync credits once (retries, a second sync, and a cross-lobby double reference do not re-credit) ->
//   buy -> lock -> resolve -> cash-out to a brand-new address and to the paying wallet, checked on chain.
// Env: SOLANA_RPC_URL (default http://127.0.0.1:8899), E2E_PORT (default 3405), HUDDLE_URL, E2E_SOLANA_DIR
// (setup output dir, for HUDDLE_URL runs: must be the dir the server's env came from).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
// plain JS module (scripts/ is also the CLI wallet)
import { payUrl, parseTransferRequest, tokenBalance } from "../scripts/solana-wallet.mjs";

const WEB = resolve(import.meta.dirname, "..");
const RPC = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const PORT = Number(process.env.E2E_PORT || 3405);
const children: ChildProcess[] = [];
const tmp = mkdtempSync(join(tmpdir(), "huddle-sol-e2e-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const conn = new Connection(RPC, "confirmed");

async function rpcUp(): Promise<boolean> {
  try {
    await conn.getGenesisHash();
    return true;
  } catch {
    return false;
  }
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children.reverse()) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGTERM");
    } catch {
      try {
        c.kill("SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
// The validator and server run in their own process groups (detached) and are unref'd so they never keep this
// test alive; after() stops both groups and deletes the temp ledger, and so do exit and Ctrl-C.
after(cleanup);
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

// ---------------------------------------------------------------- environment
if (!(await rpcUp())) {
  const bin = join(homedir(), ".local/share/solana/install/active_release/bin");
  const port = new URL(RPC).port || "8899";
  const v = spawn(join(bin, "solana-test-validator"), ["--reset", "--quiet", "--ledger", join(tmp, "ledger"), "--rpc-port", port], { detached: true, stdio: "ignore", cwd: tmp });
  v.unref();
  children.push(v);
  for (let i = 0; i < 60 && !(await rpcUp()); i++) await sleep(1000);
  assert.ok(await rpcUp(), "local validator did not start");
}
const genesis = await conn.getGenesisHash();
assert.ok(!["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"].includes(genesis), "this test only runs on a local validator");

const solDir = process.env.E2E_SOLANA_DIR || join(tmp, "sol");
const setup = JSON.parse(execFileSync("node", ["scripts/solana-setup.mjs", "--rpc", RPC, "--dir", solDir, "--json"], { cwd: WEB, encoding: "utf8" }).trim().split("\n").pop()!);
const SECRET = readFileSync(join(solDir, "treasury.secret"), "utf8").trim();
const TREASURY: string = setup.treasury;
const MINT: string = setup.mint;

let BASE = process.env.HUDDLE_URL || "";
if (!BASE) {
  BASE = `http://localhost:${PORT}`;
  const env = { ...process.env, MONEY_MODE: "solana", SOLANA_TREASURY_SECRET_KEY: SECRET, USDC_MINT: MINT, SOLANA_RPC_URL: RPC, GEMINI_DISABLED: "1", KIOSK_KEY: "" };
  const s = spawn("npx", ["next", "dev", "--webpack", "-p", String(PORT)], { cwd: WEB, env, detached: true, stdio: "ignore" });
  s.unref();
  children.push(s);
  for (let i = 0; i < 90; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(1000);
  }
}

type J = Record<string, any>;
async function call(path: string, body?: unknown, token?: string): Promise<{ status: number; j: J }> {
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-player-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, j: (await r.json().catch(() => ({}))) as J };
}
const ok = async (path: string, body?: unknown, token?: string) => {
  const r = await call(path, body, token);
  assert.equal(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.j)}`);
  return r.j;
};
const usdc = async (owner: string) => Number(await tokenBalance(conn, owner, MINT)) / 1e4; // cents
const me = async (code: string, token: string) => (await ok(`/api/lobby/${code}`, undefined, token)).me as J;
/** Polls /deposit/sync like the phone does (every 3 s) until something is credited. */
async function syncUntilCredited(code: string, token: string, body: J = {}): Promise<J> {
  for (let i = 0; i < 10; i++) {
    const r = await ok(`/api/lobby/${code}/deposit/sync`, body, token);
    if (r.credited > 0) return r;
    await sleep(3000);
  }
  throw new Error("deposit never credited");
}

// ---------------------------------------------------------------- the party
test("health says Solana is active and ready on the local validator", async () => {
  const h = await ok("/api/health");
  assert.equal(h.money.mode, "solana", JSON.stringify(h.solana));
  assert.equal(h.solana.active, true);
  assert.equal(h.solana.ready, true, JSON.stringify(h.solana.problems));
  assert.equal(h.solana.checks.cluster, "localnet");
  assert.equal(h.solana.treasury.address, TREASURY);
});

const kiosk = `e2e${Date.now() % 100000}`;
let code = "";
let code2 = "";
const alice = Keypair.generate();
const bob = Keypair.generate();
let ta = "";
let tb = "";
let tb2 = "";

test("lobby, players, faucet (once per player, lands on chain)", async () => {
  code = (await ok("/api/lobby", { game: "football", kiosk })).code;
  code2 = (await ok("/api/lobby", { game: "football", kiosk: `${kiosk}b` })).code;
  ta = (await ok(`/api/lobby/${code}/join`, { name: "Alice" })).token;
  tb = (await ok(`/api/lobby/${code}/join`, { name: "Bob" })).token;
  tb2 = (await ok(`/api/lobby/${code2}/join`, { name: "Bob" })).token;

  const f = await ok(`/api/lobby/${code}/faucet`, { address: alice.publicKey.toBase58() }, ta);
  assert.equal(f.cents, 2000);
  assert.ok(f.solSig, "a new wallet gets SOL for fees");
  assert.equal(await usdc(alice.publicKey.toBase58()), 2000);
  assert.equal(await conn.getBalance(alice.publicKey), 5_000_000);
  assert.equal((await call(`/api/lobby/${code}/faucet`, { address: alice.publicKey.toBase58() }, ta)).status, 400, "faucet twice");
  await ok(`/api/lobby/${code}/faucet`, { address: bob.publicKey.toBase58() }, tb);
  // Bad faucet targets are refused before anything is sent.
  assert.equal((await call(`/api/lobby/${code2}/faucet`, { address: TREASURY }, tb2)).status, 400);
  assert.equal((await call(`/api/lobby/${code2}/faucet`, { address: "not-an-address" }, tb2)).status, 400);
});

test("deposit: the Solana Pay URL is spec-shaped and a wallet payment is credited exactly once", async () => {
  const d = await ok(`/api/lobby/${code}/deposit`, { cents: 1000 }, ta);
  assert.equal(d.solanaPay, true);
  const req = parseTransferRequest(d.url);
  assert.equal(req.recipient.toBase58(), TREASURY);
  assert.equal(req.amount, "10");
  assert.equal(req.splToken.toBase58(), MINT);
  assert.equal(req.reference[0].toBase58(), d.reference);
  assert.equal(req.label, "Huddle");
  assert.match(req.message, /^Huddle lobby [A-Z]+$/);

  // Nothing paid yet: pending.
  const before = await ok(`/api/lobby/${code}/deposit/sync`, {}, ta);
  assert.equal(before.credited, 0);
  assert.equal(before.pending, 1);
  await sleep(2600);

  const sig = await payUrl(conn, alice, d.url);
  const tx = await conn.getParsedTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const transfer = tx!.transaction.message.instructions.find((i: any) => i.parsed?.type === "transferChecked") as any;
  assert.ok(transfer, "wallet sent a transferChecked");
  assert.ok(tx!.transaction.message.accountKeys.some((k) => k.pubkey.toBase58() === d.reference && !k.signer && !k.writable), "reference is a read-only non-signer key");

  const s = await syncUntilCredited(code, ta);
  assert.equal(s.credited, 1000);
  assert.equal(s.payments[0].signature, sig);
  await sleep(2600);
  const again = await ok(`/api/lobby/${code}/deposit/sync`, { reference: d.reference }, ta);
  assert.equal(again.credited, 0, "a second sync does not credit again");
  // Two syncs at once (after the throttle window): still credited once.
  await sleep(2600);
  const [x, y] = await Promise.all([ok(`/api/lobby/${code}/deposit/sync`, {}, ta), ok(`/api/lobby/${code}/deposit/sync`, {}, ta)]);
  assert.equal(x.credited + y.credited, 0);
  const m = await me(code, ta);
  assert.equal(m.balance, 1000);
  assert.equal(m.deposited, 1000);
  assert.equal(m.solanaAddress, alice.publicKey.toBase58());
  assert.equal(await usdc(alice.publicKey.toBase58()), 1000);
});

test("one transaction carrying references from two lobbies is credited in only one", async () => {
  const d1 = await ok(`/api/lobby/${code}/deposit`, { cents: 500 }, tb);
  const d2 = await ok(`/api/lobby/${code2}/deposit`, { cents: 500 }, tb2);
  const both = `${d1.url}&reference=${d2.reference}`;
  await payUrl(conn, bob, both);
  const s1 = await syncUntilCredited(code, tb);
  assert.equal(s1.credited, 500);
  await sleep(500);
  const s2 = await ok(`/api/lobby/${code2}/deposit/sync`, {}, tb2);
  assert.equal(s2.credited, 0, "the same signature is not credited in a second lobby");
  assert.equal((await me(code2, tb2)).balance, 0);
});

test("buy, lock, resolve: the game settles in test USDC balances", async () => {
  await ok("/api/kiosk/touch", { kiosk, id: "start" });
  await ok(`/api/lobby/${code}/buy`, { side: "yes", cents: 500 }, ta);
  await ok(`/api/lobby/${code}/buy`, { side: "no", cents: 300 }, tb);
  await ok("/api/kiosk/touch", { kiosk, id: "lock" });
  await ok("/api/kiosk/touch", { kiosk, id: "resolve:yes" });
  const a = await me(code, ta);
  const b = await me(code, tb);
  assert.ok(a.balance > 1000, `Alice won: ${a.balance}`);
  assert.equal(b.balance, 200);
});

test("cash-out: to a brand-new address, and by default to the wallet that paid", async () => {
  const fresh = Keypair.generate().publicKey.toBase58();
  // Refused before the balance is touched: a token account, the treasury.
  const ataAddr = getAssociatedTokenAddressSync(new PublicKey(MINT), alice.publicKey).toBase58();
  assert.equal((await call(`/api/lobby/${code}/cashout`, { address: ataAddr }, ta)).status, 400);
  assert.equal((await call(`/api/lobby/${code}/cashout`, { address: TREASURY }, ta)).status, 400);

  const aBal = (await me(code, ta)).balance;
  const tBefore = await usdc(TREASURY);
  const c = await ok(`/api/lobby/${code}/cashout`, { address: fresh }, ta);
  assert.equal(c.mode, "solana");
  assert.equal(c.cents, aBal);
  assert.equal(c.to, fresh);
  assert.match(c.explorer, /explorer\.solana\.com\/tx\//);
  assert.equal(await usdc(fresh), aBal, "the new address holds exactly the cash-out");
  assert.equal(await usdc(TREASURY), tBefore - aBal);
  assert.equal((await me(code, ta)).balance, 0);
  assert.equal((await call(`/api/lobby/${code}/cashout`, { address: fresh }, ta)).status, 400, "nothing left to cash out");

  const bobBefore = await usdc(bob.publicKey.toBase58());
  const cb = await ok(`/api/lobby/${code}/cashout`, {}, tb);
  assert.equal(cb.to, bob.publicKey.toBase58());
  assert.equal(await usdc(bob.publicKey.toBase58()), bobBefore + 200);
  const sol = (await conn.getBalance(new PublicKey(fresh))) / LAMPORTS_PER_SOL;
  assert.equal(sol, 0, "the treasury paid the fee and rent, the player's address needs no SOL");
});
