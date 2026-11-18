// MONEY_MODE=solana without a validator: the Solana Pay URL against the spec (parsed the way wallets parse it),
// payment verification from transaction metadata, findPayments / deposit sync on a mocked RPC (credited once,
// never twice across lobbies), the send-outcome logic for unclear cash-outs, and config checks.
// The real chain is covered by the opt-in `npm run test:localnet`.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const solana = await import("../lib/solana.ts");
const solLobby = await import("../lib/solana-lobby.ts");
const lobby = await import("../lib/lobby.ts");
const { Keypair } = await import("@solana/web3.js");
// The CLI test wallet parses transfer requests exactly like @solana/pay's parseURL (which Phantom/Solflare follow).
const wallet = await import("../scripts/solana-wallet.mjs");

const TREASURY = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const addr = () => Keypair.generate().publicKey.toBase58();

test("amount: plain decimal, no exponent, no trailing zeros, never more than 2 decimals", () => {
  const cases: [number, string][] = [[1, "0.01"], [10, "0.1"], [25, "0.25"], [500, "5"], [1000, "10"], [1050, "10.5"], [1999, "19.99"], [100000, "1000"], [123456789, "1234567.89"]];
  for (const [c, s] of cases) assert.equal(solana.formatAmount(c), s, `${c} cents`);
  for (const bad of [0, -5, 1.5, Number.NaN]) assert.throws(() => solana.formatAmount(bad));
  for (const [c, s] of cases) assert.equal(wallet.toBaseUnits(s, 6), BigInt(c) * 10_000n, "the wallet pays exactly the cents asked");
});

test("transfer request URL parses like a wallet parses it (spec fields, encoding, several references)", () => {
  const ref = addr();
  const ref2 = addr();
  const url = solana.transferRequestUrl({ recipient: TREASURY, cents: 1050, mint: MINT, reference: [ref, ref2], label: "Huddle", message: "Huddle lobby ABCD: Sam's $10.50 + tip & 100% fun", memo: "huddle-ABCD" });
  assert.ok(url.startsWith(`solana:${TREASURY}?amount=10.5&spl-token=${MINT}&reference=${ref}&reference=${ref2}&label=Huddle&message=`));
  assert.ok(!url.includes("+"), "no '+' (some parsers keep it literally); spaces are %20");
  assert.ok(!/ /.test(url));
  const r = wallet.parseTransferRequest(url);
  assert.equal(r.recipient.toBase58(), TREASURY);
  assert.equal(r.amount, "10.5");
  assert.equal(r.splToken.toBase58(), MINT);
  assert.deepEqual(r.reference.map((k: { toBase58(): string }) => k.toBase58()), [ref, ref2]);
  assert.equal(r.label, "Huddle");
  assert.equal(r.message, "Huddle lobby ABCD: Sam's $10.50 + tip & 100% fun");
  assert.equal(r.memo, "huddle-ABCD");
  // Same answers from the plain WHATWG parser (what @solana/pay uses underneath).
  const u = new URL(url);
  assert.equal(u.protocol, "solana:");
  assert.equal(u.pathname, TREASURY);
  assert.equal(u.searchParams.get("message"), "Huddle lobby ABCD: Sam's $10.50 + tip & 100% fun");
  assert.ok(url.length < 2048, "wallets refuse URLs over 2048 characters");
});

test("config checks: secret key format, mint, mainnet refused; explorer links per cluster", () => {
  const kp = Keypair.generate();
  assert.equal(solana.secretKeyProblem(JSON.stringify(Array.from(kp.secretKey))), null);
  assert.match(solana.secretKeyProblem("")!, /not set/);
  assert.match(solana.secretKeyProblem("[1,2,3]")!, /64-number/);
  assert.match(solana.secretKeyProblem("0xdeadbeef")!, /base58/);
  assert.equal(solana.clusterFromGenesis(solana.GENESIS.devnet), "devnet");
  assert.equal(solana.clusterFromGenesis(solana.GENESIS.mainnet), "mainnet");
  assert.equal(solana.clusterFromGenesis("somethingElse"), "localnet");
  assert.equal(solana.explorerTx("S", "https://api.devnet.solana.com"), "https://explorer.solana.com/tx/S?cluster=devnet");
  assert.equal(solana.explorerTx("S", "http://127.0.0.1:8899"), "https://explorer.solana.com/tx/S?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899");
  assert.equal(solana.redactRpc("https://devnet.helius-rpc.com/?api-key=SECRET"), "https://devnet.helius-rpc.com/?api-key=***");
});

// ---------------------------------------------------------------- verification from transaction metadata

const bal = (accountIndex: number, owner: string, units: bigint, mint = MINT) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(units), decimals: 6, uiAmount: Number(units) / 1e6, uiAmountString: String(Number(units) / 1e6) } });

test("paymentFromMeta: credits what reached a treasury-owned account of the right mint, and names the payer", () => {
  const payer = addr();
  const meta = (pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[], err: unknown = null) => ({ err, preTokenBalances: pre, postTokenBalances: post });
  // A normal $5 payment.
  assert.deepEqual(solana.paymentFromMeta(meta([bal(1, payer, 20_000_000n), bal(2, TREASURY, 0n)], [bal(1, payer, 15_000_000n), bal(2, TREASURY, 5_000_000n)]), TREASURY, MINT), { cents: 500, from: payer });
  // The treasury's token account did not exist before (no pre balance): still counted.
  assert.deepEqual(solana.paymentFromMeta(meta([bal(1, payer, 5_000_000n)], [bal(1, payer, 0n), bal(2, TREASURY, 5_000_000n)]), TREASURY, MINT), { cents: 500, from: payer });
  // Sub-cent dust is rounded down; under a cent is nothing.
  assert.equal(solana.paymentFromMeta(meta([bal(2, TREASURY, 0n)], [bal(2, TREASURY, 1_239_999n)]), TREASURY, MINT)!.cents, 123);
  assert.equal(solana.paymentFromMeta(meta([bal(2, TREASURY, 0n)], [bal(2, TREASURY, 9_999n)]), TREASURY, MINT), null);
  // Failed transaction, wrong mint, money leaving the treasury, someone else receiving: nothing.
  assert.equal(solana.paymentFromMeta(meta([bal(2, TREASURY, 0n)], [bal(2, TREASURY, 5_000_000n)], { InstructionError: [0, "Custom"] }), TREASURY, MINT), null);
  assert.equal(solana.paymentFromMeta(meta([bal(2, TREASURY, 0n, addr())], [bal(2, TREASURY, 5_000_000n, addr())]), TREASURY, MINT), null);
  assert.equal(solana.paymentFromMeta(meta([bal(2, TREASURY, 9_000_000n), bal(3, payer, 0n)], [bal(2, TREASURY, 4_000_000n), bal(3, payer, 5_000_000n)]), TREASURY, MINT), null);
  assert.equal(solana.paymentFromMeta(meta([bal(1, payer, 5_000_000n), bal(2, addr(), 0n)], [bal(1, payer, 0n), bal(2, addr(), 5_000_000n)]), TREASURY, MINT), null);
  assert.equal(solana.paymentFromMeta(null, TREASURY, MINT), null);
});

/** A fake RPC: reference -> signatures, signature -> transaction meta. Counts getParsedTransaction calls. */
function mockRpc(chain: { refs: Record<string, { signature: string; err?: unknown }[]>; txs: Record<string, ReturnType<typeof meta>> }) {
  const calls = { sigs: 0, txs: 0 };
  const rpc = {
    async getSignaturesForAddress(pk: { toBase58(): string }) {
      calls.sigs++;
      return (chain.refs[pk.toBase58()] ?? []).map((s) => ({ signature: s.signature, err: s.err ?? null, slot: 1, memo: null, blockTime: null }));
    },
    async getParsedTransaction(sig: string) {
      calls.txs++;
      const m = chain.txs[sig];
      return m ? { meta: m, slot: 1, transaction: {} } : null;
    },
  };
  return { rpc: rpc as unknown as import("../lib/solana.ts").PaymentRpc, calls };
}
function meta(payer: string, cents: number) {
  const units = BigInt(cents) * 10_000n;
  return { err: null, preTokenBalances: [bal(1, payer, units), bal(2, TREASURY, 0n)], postTokenBalances: [bal(1, payer, 0n), bal(2, TREASURY, units)] };
}

test("findPayments: by reference, skips failed and already-credited signatures without fetching them", async () => {
  const ref = addr();
  const payer = addr();
  const { rpc, calls } = mockRpc({ refs: { [ref]: [{ signature: "good" }, { signature: "failed", err: { x: 1 } }, { signature: "done" }, { signature: "notours" }] }, txs: { good: meta(payer, 500), done: meta(payer, 500), notours: { err: null, preTokenBalances: [], postTokenBalances: [] } } });
  const found = await solana.findPayments(ref, { rpc, treasury: TREASURY, mint: MINT, skip: (s) => s === "done" });
  assert.deepEqual(found, [{ signature: "good", cents: 500, from: payer }]);
  assert.equal(calls.txs, 2, "failed and already-credited signatures are not fetched");
});

async function lobbyWith(names: string[], kiosk: string) {
  const l = await lobby.createLobby(kiosk, "football");
  const tokens: string[] = [];
  for (const n of names) await lobby.mutate(l.code, (x, now) => void tokens.push(lobby.join(x, n, now).token));
  return { code: l.code, tokens };
}

test("deposit sync: credits once per signature (retries, repeats), learns the paying wallet, drops paid references", async () => {
  const { code, tokens } = await lobbyWith(["Sam"], "sol1");
  const ref = addr();
  const payer = addr();
  const l0 = (await lobby.getLobby(code))!;
  const sam = lobby.requirePlayer(l0, tokens[0]);
  await lobby.mutate(code, (l, now) => solLobby.addSolanaRef(l, sam.id, ref, 500, now));
  const chain = { refs: {} as Record<string, { signature: string }[]>, txs: {} as Record<string, ReturnType<typeof meta>> };
  const { rpc } = mockRpc(chain);
  const o = { rpc, treasury: TREASURY, mint: MINT };

  let r = await solLobby.syncSolanaDeposits(code, tokens[0], o);
  assert.deepEqual(r, { credited: 0, pending: 1, payments: [] }, "not paid yet");

  chain.refs[ref] = [{ signature: "sigA" }];
  chain.txs.sigA = meta(payer, 500);
  r = await solLobby.syncSolanaDeposits(code, tokens[0], o);
  assert.equal(r.credited, 500);
  assert.deepEqual(r.payments, [{ signature: "sigA", cents: 500 }]);
  // Two more syncs at once and one after: nothing more.
  const [a, b] = await Promise.all([solLobby.syncSolanaDeposits(code, tokens[0], o), solLobby.syncSolanaDeposits(code, tokens[0], o)]);
  assert.equal(a.credited + b.credited, 0);
  // Even if the reference were still open (a retry racing the delete), the signature is not credited twice.
  await lobby.mutate(code, (l, now) => solLobby.addSolanaRef(l, sam.id, ref, 500, now));
  assert.equal((await solLobby.syncSolanaDeposits(code, tokens[0], o)).credited, 0);

  const l = (await lobby.getLobby(code))!;
  assert.equal(l.players[sam.id].balance, 500);
  assert.equal(l.players[sam.id].deposited, 500);
  assert.equal(l.players[sam.id].solanaAddress, payer, "cash-out defaults to the wallet that paid");
  assert.equal(Object.keys(l.solanaRefs ?? {}).length, 0, "paid references are dropped");
  assert.equal(Object.values(l.deposits).filter((d) => d.source === "solana").length, 1);
});

test("deposit sync: one transaction carrying references from two lobbies is credited in one lobby only", async () => {
  const one = await lobbyWith(["Kim"], "sol2");
  const two = await lobbyWith(["Kim"], "sol3");
  const r1 = addr();
  const r2 = addr();
  const payer = addr();
  for (const [x, r] of [[one, r1], [two, r2]] as const) {
    const pid = lobby.requirePlayer((await lobby.getLobby(x.code))!, x.tokens[0]).id;
    await lobby.mutate(x.code, (l, now) => solLobby.addSolanaRef(l, pid, r, 500, now));
  }
  const { rpc } = mockRpc({ refs: { [r1]: [{ signature: "both" }], [r2]: [{ signature: "both" }] }, txs: { both: meta(payer, 500) } });
  const o = { rpc, treasury: TREASURY, mint: MINT };
  assert.equal((await solLobby.syncSolanaDeposits(one.code, one.tokens[0], o)).credited, 500);
  assert.equal((await solLobby.syncSolanaDeposits(two.code, two.tokens[0], o)).credited, 0);
  // The first lobby retrying is still fine (its own claim).
  assert.equal(await solLobby.claimSignature("both", `${one.code}:${lobby.requirePlayer((await lobby.getLobby(one.code))!, one.tokens[0]).id}`), true);
});

test("deposit requests: expired and excess ones are pruned per player", async () => {
  const { code, tokens } = await lobbyWith(["Lee", "Max"], "sol4");
  const l0 = (await lobby.getLobby(code))!;
  const lee = lobby.requirePlayer(l0, tokens[0]).id;
  const max = lobby.requirePlayer(l0, tokens[1]).id;
  const t0 = Date.now();
  await lobby.mutate(code, (l) => {
    solLobby.addSolanaRef(l, max, "maxOld", 500, t0 - solLobby.REF_TTL_MS - 1);
    for (let i = 0; i < 6; i++) solLobby.addSolanaRef(l, lee, `lee${i}`, 500, t0 + i);
    solLobby.addSolanaRef(l, max, "maxNew", 500, t0 + 10);
  });
  const refs = (await lobby.getLobby(code))!.solanaRefs!;
  assert.deepEqual(Object.keys(refs).sort(), ["lee2", "lee3", "lee4", "lee5", "maxNew"]);
});

test("signatureOutcome: landed, failed on chain, expired unseen (safe to refund), or still pending (never refund)", async () => {
  const rpc = (value: unknown, height = 100) => ({ getSignatureStatus: async () => ({ context: { slot: 1 }, value }), getBlockHeight: async () => height }) as never;
  assert.equal(await solana.signatureOutcome("s", 50, rpc({ err: null, confirmationStatus: "confirmed" })), "landed");
  assert.equal(await solana.signatureOutcome("s", 50, rpc({ err: null, confirmationStatus: "finalized" })), "landed");
  assert.equal(await solana.signatureOutcome("s", 50, rpc({ err: { x: 1 }, confirmationStatus: "confirmed" })), "failed");
  assert.equal(await solana.signatureOutcome("s", 50, rpc({ err: null, confirmationStatus: "processed" })), "pending");
  assert.equal(await solana.signatureOutcome("s", 50, rpc(null, 120)), "failed", "blockhash expired and never seen: it can never land");
  assert.equal(await solana.signatureOutcome("s", 150, rpc(null, 120)), "pending", "still valid: it might land");
  assert.equal(await solana.signatureOutcome("s", undefined, rpc(null)), "pending");
});
