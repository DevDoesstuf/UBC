// QuickNode Streams without QuickNode: web/quicknode/filter.js run the way Streams runs it (a bare vm sandbox: no
// require, no Buffer) on getBlock-shaped blocks, the webhook's authentication (shared-token header and QuickNode's
// HMAC headers), body shapes, and crediting a Solana Pay deposit from a delivery on a mocked RPC (once, never from a
// forged record). The real chain is covered by `npm run test:vault-localnet` (a real block through the filter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
const { Keypair, PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
const spl = await import("@solana/spl-token");
const TREASURY_KP = Keypair.generate();
const MINT = Keypair.generate().publicKey;
const TOKEN = "t".repeat(40);
process.env.MONEY_MODE = "solana";
process.env.SOLANA_TREASURY_SECRET_KEY = JSON.stringify(Array.from(TREASURY_KP.secretKey));
process.env.USDC_MINT = MINT.toBase58();
process.env.SOLANA_RPC_URL = "http://127.0.0.1:9";
process.env.QUICKNODE_STREAM_TOKEN = TOKEN;

const qn = await import("../lib/quicknode.ts");
const lobby = await import("../lib/lobby.ts");
const solLobby = await import("../lib/solana-lobby.ts");
const vault = await import("../lib/vault.ts");
const route = await import("../app/api/quicknode/webhook/route.ts");
const bs58 = (await import("bs58")).default;

const PROGRAM = vault.DEFAULT_VAULT_PROGRAM_ID;
const TREASURY_ATA = spl.getAssociatedTokenAddressSync(MINT, TREASURY_KP.publicKey).toBase58();

function loadFilter(watch: string[] = [TREASURY_ATA]) {
  const src = readFileSync(new URL("../quicknode/filter.js", import.meta.url), "utf8").replace(/var WATCH_ACCOUNTS = \[[^\]]*\];/, `var WATCH_ACCOUNTS = ${JSON.stringify(watch)};`);
  const main = vm.runInNewContext(`${src}\n;main`, Object.create(null)) as (s: unknown) => unknown;
  // Through JSON, as the webhook receives it (and out of the sandbox's realm, so deepEqual compares plainly).
  return (s: unknown) => JSON.parse(JSON.stringify(main(s))) as Record<string, any>[] | null;
}

/** A transaction as getBlock returns it with encoding "json". */
function blockTx(ixs: InstanceType<typeof TransactionInstruction>[], payer: InstanceType<typeof PublicKey>, err: unknown = null) {
  const t = new Transaction({ feePayer: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 1)) }).add(...ixs);
  const msg = t.compileMessage();
  return {
    meta: { err, status: err ? { Err: err } : { Ok: null }, logMessages: [], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [], readonly: [] } },
    transaction: {
      signatures: [bs58.encode(Buffer.alloc(64, Math.floor(Math.random() * 255)))],
      message: { accountKeys: msg.accountKeys.map((k) => k.toBase58()), header: msg.header, recentBlockhash: msg.recentBlockhash, instructions: msg.instructions },
    },
  };
}

function solanaPayTx(payer: InstanceType<typeof Keypair>, reference: InstanceType<typeof PublicKey>) {
  const ix = spl.createTransferCheckedInstruction(spl.getAssociatedTokenAddressSync(MINT, payer.publicKey), MINT, new PublicKey(TREASURY_ATA), payer.publicKey, 5_000_000n, 6);
  ix.keys.push({ pubkey: reference, isSigner: false, isWritable: false });
  return blockTx([ix], payer.publicKey);
}

function vaultDepositTx(amount: bigint) {
  const payer = Keypair.generate().publicKey;
  const member = Keypair.generate().publicKey;
  const party = Keypair.generate().publicKey;
  const data = Buffer.alloc(16);
  vault.disc("global", "deposit").copy(data, 0);
  data.writeBigUInt64LE(amount, 8);
  const keys = [payer, member, party, Keypair.generate().publicKey, MINT, Keypair.generate().publicKey, Keypair.generate().publicKey].map((pubkey, i) => ({ pubkey, isSigner: i < 2, isWritable: i !== 4 }));
  return { tx: blockTx([new TransactionInstruction({ programId: new PublicKey(PROGRAM), keys, data })], payer), member: member.toBase58(), party: party.toBase58() };
}

test("filter: keeps Solana Pay payments into the treasury token account and vault instructions, nothing else", () => {
  const main = loadFilter();
  const alice = Keypair.generate();
  const ref = Keypair.generate().publicKey;
  const pay = solanaPayTx(alice, ref);
  const dep = vaultDepositTx(10_000_000n);
  const other = blockTx([spl.createTransferCheckedInstruction(Keypair.generate().publicKey, MINT, Keypair.generate().publicKey, alice.publicKey, 1n, 6)], alice.publicKey);
  const failed = solanaPayTx(alice, Keypair.generate().publicKey);
  failed.meta.err = { InstructionError: [0, "Custom"] } as never;
  const out = main({ data: [{ blockTime: 1795000000, parentSlot: 99, transactions: [pay, dep.tx, other, failed] }], metadata: { network: "solana-devnet", dataset: "block", batch_start_range: 100 } })!;
  assert.equal(out.length, 2, "the unrelated and the failed transaction are dropped");
  assert.equal(out[0].signature, pay.transaction.signatures[0]);
  assert.equal(out[0].slot, 100);
  assert.equal(out[0].blockTime, 1795000000);
  assert.deepEqual(out[0].watched, [TREASURY_ATA]);
  assert.ok(out[0].accounts.includes(ref.toBase58()), "the reference key is in the record");
  assert.deepEqual(out[0].huddle, []);
  assert.equal(out[1].huddle[0].instruction, "deposit");
  assert.equal(out[1].huddle[0].party, dep.party);
  assert.equal(out[1].huddle[0].member, dep.member);
  assert.equal(out[1].huddle[0].amount, 10_000_000);
  // Nothing of ours: null (QuickNode skips the delivery).
  assert.equal(main({ data: [{ slot: 5, transactions: [other] }] }), null);
  assert.equal(main({ data: [] }), null);
  // Without the treasury configured, payments are not watched but vault instructions still are.
  assert.equal(loadFilter([])({ data: [{ slot: 1, transactions: [pay, dep.tx] }] })!.length, 1);
});

test("filter: every vault instruction decodes; the Programs + Logs shape works too", () => {
  const main = loadFilter();
  for (const name of ["create_party", "request_close", "submit_state", "finalize", "withdraw", "withdraw_host"]) {
    const data = Buffer.alloc(200);
    vault.disc("global", name).copy(data, 0);
    const keys = Array.from({ length: 8 }, (_, i) => ({ pubkey: Keypair.generate().publicKey, isSigner: i === 0, isWritable: true }));
    const tx = blockTx([new TransactionInstruction({ programId: new PublicKey(PROGRAM), keys, data })], keys[0].pubkey);
    assert.equal(main({ data: [{ slot: 1, transactions: [tx] }] })![0].huddle[0].instruction, name);
  }
  const dep = vaultDepositTx(7n);
  const ix = dep.tx.transaction.message.instructions[0];
  const keys = dep.tx.transaction.message.accountKeys;
  const entry = { signature: "SIG", slot: 9, blockTime: 1, success: true, logs: [], programInvocations: [{ programId: PROGRAM, instruction: { accounts: ix.accounts.map((i: number) => keys[i]), data: ix.data } }] };
  const out = main({ data: [[entry]] })!;
  assert.equal(out[0].signature, "SIG");
  assert.equal(out[0].huddle[0].amount, 7);
});

test("webhook auth: shared-token header, or QuickNode's HMAC over nonce + timestamp + body; everything else refused", () => {
  const body = '[{"signature":"x","accounts":[]}]';
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(qn.authProblem(h({ "x-huddle-token": TOKEN }), body), null);
  assert.equal(qn.authProblem(h({ authorization: `Bearer ${TOKEN}` }), body), null);
  assert.match(qn.authProblem(h({ "x-huddle-token": "wrong" }), body)!, /wrong token/);
  assert.match(qn.authProblem(h({}), body)!, /missing/);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac("sha256", TOKEN).update("n1" + ts + body).digest("hex");
  assert.equal(qn.authProblem(h({ "x-qn-nonce": "n1", "x-qn-timestamp": ts, "x-qn-signature": sig }), body), null);
  assert.match(qn.authProblem(h({ "x-qn-nonce": "n1", "x-qn-timestamp": ts, "x-qn-signature": sig }), body + " ")!, /bad X-QN-Signature/, "tampered body");
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  const oldSig = createHmac("sha256", TOKEN).update("n1" + old + body).digest("hex");
  assert.match(qn.authProblem(h({ "x-qn-nonce": "n1", "x-qn-timestamp": old, "x-qn-signature": oldSig }), body)!, /stale/, "replayed an hour later");
  assert.match(qn.authProblem(h({ "x-huddle-token": TOKEN }), body, "")!, /not set/);
});

test("webhook body shapes: bare array, nested arrays, {data, metadata}", () => {
  const r = { signature: "S", accounts: ["A"], huddle: [] };
  assert.equal(qn.recordsOf([r]).length, 1);
  assert.equal(qn.recordsOf([[r], [r]]).length, 2);
  assert.equal(qn.recordsOf({ data: [r], metadata: {} }).length, 1);
  assert.equal(qn.recordsOf({ data: [[r]] }).length, 1);
  assert.equal(qn.recordsOf(null).length, 0);
  assert.equal(qn.recordsOf([{ nope: 1 }]).length, 0);
});

test("webhook route: 401 without the token, 200 with it", async () => {
  const req = (headers: Record<string, string>, body: string) => new Request("http://x/api/quicknode/webhook", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await route.POST(req({}, "[]"))).status, 401);
  assert.equal((await route.POST(req({ "x-huddle-token": "nope" }, "[]"))).status, 401);
  const ok = await route.POST(req({ "x-huddle-token": TOKEN }, "[]"));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { records: number }).records, 0);
  assert.equal((await route.POST(req({ "x-huddle-token": TOKEN }, "{not json"))).status, 400);
});

test("a delivery credits the Solana Pay deposit once, by reference, re-read from our RPC; a forged record credits nothing", async () => {
  const l = await lobby.createLobby("qn1", "football");
  let tok = "";
  await lobby.mutate(l.code, (x, now) => {
    x.money = "solana";
    tok = lobby.join(x, "Gus", now).token;
  });
  const d = await solLobby.newSolanaDeposit(l.code, tok, 500);
  const gus = Keypair.generate();
  const record = loadFilter()({ data: [{ slot: 7, transactions: [solanaPayTx(gus, new PublicKey(d.reference))] }] })!;
  const sig = record[0].signature as string;
  const units = (n: number) => ({ amount: String(n * 10_000), decimals: 6, uiAmount: null, uiAmountString: "" });
  const t = TREASURY_KP.publicKey.toBase58();
  let txCalls = 0;
  const rpc = {
    getParsedTransaction: async (s: string) => {
      txCalls++;
      if (s !== sig) return null;
      return {
        meta: {
          err: null,
          preTokenBalances: [{ accountIndex: 1, mint: MINT.toBase58(), owner: gus.publicKey.toBase58(), uiTokenAmount: units(2000) }, { accountIndex: 2, mint: MINT.toBase58(), owner: t, uiTokenAmount: units(0) }],
          postTokenBalances: [{ accountIndex: 1, mint: MINT.toBase58(), owner: gus.publicKey.toBase58(), uiTokenAmount: units(1500) }, { accountIndex: 2, mint: MINT.toBase58(), owner: t, uiTokenAmount: units(500) }],
        },
        transaction: { message: { accountKeys: record[0].accounts.map((k: string) => ({ pubkey: new PublicKey(k), signer: false, writable: false })) } },
      };
    },
  } as never;
  const opts = { rpc, treasury: t, mint: MINT.toBase58() };
  const r1 = await qn.handleStream(record, opts);
  assert.equal(r1.credited, 500);
  assert.equal(r1.deposits[0].code, l.code);
  const r2 = await qn.handleStream({ data: record }, opts);
  assert.equal(r2.credited, 0, "redelivery never credits twice");
  const after = (await lobby.mutate(l.code, () => {}))!;
  const me = lobby.requirePlayer(after, tok);
  assert.equal(me.balance, 500);
  assert.equal(me.solanaAddress, gus.publicKey.toBase58());
  const ev = after.chain!.find((e) => e.kind === "deposit")!;
  assert.equal(ev.via, "quicknode");
  assert.equal(ev.streamed, true);
  assert.equal(after.solanaRefs?.[d.reference], undefined, "the request is closed");
  // Forged: a record that names an open reference but whose real transaction does not carry it / pay us.
  const d2 = await solLobby.newSolanaDeposit(l.code, tok, 1000);
  const forged = [{ signature: bs58.encode(Buffer.alloc(64, 3)), accounts: [d2.reference], huddle: [] }];
  const before = txCalls;
  assert.equal((await qn.handleStream(forged, opts)).credited, 0);
  assert.equal(txCalls, before + 1, "it was checked on chain, and refused");
  assert.equal(lobby.requirePlayer((await lobby.mutate(l.code, () => {}))!, tok).balance, 500);
});

test("QuickNode Webhooks payload (Solana Wallet Activity Monitor) becomes the same records", () => {
  const body = [{
    block: { slot: 524288124, blockTime: 1795162346 },
    transactions: [
      { raw: { meta: { err: null, loadedAddresses: { writable: [], readonly: ["R1"] } }, transaction: { signatures: ["SIG1"], message: { accountKeys: ["A", { pubkey: "B" }] } } } },
      { raw: { meta: { err: { InstructionError: [0, "x"] } }, transaction: { signatures: ["FAILED"], message: { accountKeys: ["Z"] } } } },
    ],
  }];
  const recs = qn.recordsOf(body);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].signature, "SIG1");
  assert.equal(recs[0].slot, 524288124);
  assert.deepEqual(recs[0].accounts, ["A", "B", "R1"]);
});
