// "Pay instantly": the embedded per-player devnet wallet and POST /deposit/instant, against a mocked RPC.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KIOSK_KEY;
const { Keypair, PublicKey, Transaction } = await import("@solana/web3.js");
const spl = await import("@solana/spl-token");
const bs58 = (await import("bs58")).default;
const TREASURY_KP = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();
process.env.MONEY_MODE = "solana";
process.env.SETTLEMENT = "vault";
process.env.SOLANA_TREASURY_SECRET_KEY = JSON.stringify(Array.from(TREASURY_KP.secretKey));
process.env.USDC_MINT = MINT;
process.env.SOLANA_RPC_URL = "http://127.0.0.1:9";

const lobby = await import("../lib/lobby.ts");
const instant = await import("../lib/instant.ts");
const instantRoute = await import("../app/api/lobby/[code]/deposit/instant/route.ts");

const params = (code: string) => ({ params: Promise.resolve({ code }) });
const post = (code: string, body: unknown, token?: string) =>
  instantRoute.POST(new Request(`http://x/api/lobby/${code}/deposit/instant`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-player-token": token } : {}) }, body: JSON.stringify(body) }), params(code));

let n = 0;
async function lobbyWith(names: string[], money: "demo" | "solana" = "solana") {
  const l = await lobby.createLobby(`in${++n}`, "football");
  const toks: string[] = [];
  const ids: string[] = [];
  await lobby.mutate(l.code, (x, now) => {
    if (money === "solana") lobby.setMoney(x, "solana");
    for (const name of names) {
      const p = lobby.join(x, name, now);
      toks.push(p.token);
      ids.push(p.id);
    }
  });
  return { code: l.code, toks, ids };
}

/** A devnet stand-in: records sent transactions, confirms them, and serves their token balance changes. */
function mockRpc(opts: { status?: "confirmed" | null; failSend?: string } = {}) {
  const sent: InstanceType<typeof Transaction>[] = [];
  const rpc = {
    sent,
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      if (opts.failSend) throw new Error(opts.failSend);
      const tx = Transaction.from(Buffer.from(raw));
      sent.push(tx);
      return bs58.encode(tx.signature!);
    },
    getSignatureStatus: async (sig: string) => ({ value: sent.some((t) => bs58.encode(t.signature!) === sig) && opts.status !== null ? { err: null, confirmationStatus: "confirmed" } : null }),
    getParsedTransaction: async (sig: string) => {
      const tx = sent.find((t) => bs58.encode(t.signature!) === sig);
      if (!tx) return null;
      const msg = tx.compileMessage();
      const keys = msg.accountKeys.map((k) => k.toBase58());
      const transfer = tx.instructions[2];
      const units = transfer.data.readBigUInt64LE(1);
      const dest = transfer.keys[2].pubkey.toBase58();
      const src = transfer.keys[0].pubkey.toBase58();
      const bal = (account: string, owner: string, amount: bigint) => ({ accountIndex: keys.indexOf(account), mint: MINT, owner, uiTokenAmount: { amount: String(amount), decimals: 6, uiAmount: null, uiAmountString: "" } });
      const player = transfer.keys[3].pubkey.toBase58();
      const t = TREASURY_KP.publicKey.toBase58();
      return {
        transaction: { message: { accountKeys: keys.map((k) => ({ pubkey: new PublicKey(k) })) } },
        meta: { err: null, preTokenBalances: [bal(dest, t, BigInt(0)), bal(src, player, BigInt(0))], postTokenBalances: [bal(dest, t, units), bal(src, player, BigInt(0))] },
      };
    },
  };
  return rpc;
}
const run = (code: string, tok: string, cents: number, nonce: string, rpc: ReturnType<typeof mockRpc>) =>
  instant.instantDeposit(code, tok, cents, nonce, { rpc: rpc as never, tokenProgram: spl.TOKEN_PROGRAM_ID, timeoutMs: 50 });

test("the embedded wallet is deterministic and distinct per player and lobby", async () => {
  const secret = TREASURY_KP.secretKey;
  const a = instant.playerSeed(secret, "ABCD", "p1");
  assert.equal(a.length, 32);
  assert.deepEqual(instant.playerSeed(secret, "ABCD", "p1"), a);
  assert.deepEqual(instant.playerSeed(secret, "abcd", "p1"), a, "lobby codes are case-insensitive");
  assert.notDeepEqual(instant.playerSeed(secret, "ABCD", "p2"), a);
  assert.notDeepEqual(instant.playerSeed(secret, "ABCE", "p1"), a);
  assert.notDeepEqual(instant.playerSeed(Keypair.generate().secretKey, "ABCD", "p1"), a);
  const w1 = await instant.playerWalletAddress("ABCD", "p1");
  assert.equal(await instant.playerWalletAddress("ABCD", "p1"), w1);
  assert.notEqual(await instant.playerWalletAddress("ABCD", "p2"), w1);
  assert.notEqual(w1, TREASURY_KP.publicKey.toBase58());
});

test("instruction list: idempotent ATA create, mintTo, transferChecked with the reference read-only", async () => {
  const player = Keypair.generate().publicKey;
  const reference = Keypair.generate().publicKey;
  const mint = new PublicKey(MINT);
  const ixs = await instant.instantPayIxs({ treasury: TREASURY_KP.publicKey, player, mint, reference, units: BigInt(5_000_000) });
  assert.equal(ixs.length, 3);
  const playerAta = spl.getAssociatedTokenAddressSync(mint, player);
  const treasuryAta = spl.getAssociatedTokenAddressSync(mint, TREASURY_KP.publicKey);
  assert.ok(ixs[0].programId.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.deepEqual([...ixs[0].data], [1], "CreateIdempotent");
  assert.ok(ixs[0].keys[0].pubkey.equals(TREASURY_KP.publicKey) && ixs[0].keys[0].isSigner, "treasury pays the rent");
  assert.ok(ixs[0].keys[1].pubkey.equals(playerAta));
  assert.ok(ixs[1].programId.equals(spl.TOKEN_PROGRAM_ID));
  assert.equal(ixs[1].data[0], 14, "MintToChecked");
  assert.equal(ixs[1].data.readBigUInt64LE(1), BigInt(5_000_000));
  assert.ok(ixs[1].keys[1].pubkey.equals(playerAta) && ixs[1].keys[2].pubkey.equals(TREASURY_KP.publicKey) && ixs[1].keys[2].isSigner, "treasury is the mint authority");
  assert.equal(ixs[2].data[0], 12, "TransferChecked");
  assert.equal(ixs[2].data.readBigUInt64LE(1), BigInt(5_000_000));
  assert.ok(ixs[2].keys[0].pubkey.equals(playerAta) && ixs[2].keys[2].pubkey.equals(treasuryAta));
  assert.ok(ixs[2].keys[3].pubkey.equals(player) && ixs[2].keys[3].isSigner, "the player's wallet signs the transfer");
  const ref = ixs[2].keys.at(-1)!;
  assert.ok(ref.pubkey.equals(reference));
  assert.equal(ref.isSigner, false);
  assert.equal(ref.isWritable, false);
});

test("instant deposit: one transaction, credited once, payouts go to the embedded wallet; retries never double charge", async () => {
  const { code, toks, ids } = await lobbyWith(["Ann"]);
  const rpc = mockRpc();
  const r = await run(code, toks[0], 500, "nonce-1", rpc);
  assert.equal(r.credited, 500);
  assert.equal(r.pending, undefined);
  assert.equal(rpc.sent.length, 1);
  const tx = rpc.sent[0];
  assert.ok(tx.feePayer!.equals(TREASURY_KP.publicKey));
  const wallet = await instant.playerWalletAddress(code, ids[0]);
  assert.equal(r.wallet, wallet);
  assert.deepEqual(tx.signatures.map((s) => s.publicKey.toBase58()).sort(), [TREASURY_KP.publicKey.toBase58(), wallet].sort());
  assert.ok(tx.verifySignatures(), "signed by the treasury and the derived player key");
  assert.equal(r.signature, bs58.encode(tx.signature!));
  assert.match(r.explorer, /explorer\.solana\.com\/tx\//);
  let l = (await lobby.getLobby(code))!;
  let me = lobby.requirePlayer(l, toks[0]);
  assert.equal(me.balance, 500);
  assert.equal(me.solanaAddress, wallet);
  assert.equal(me.wallet, "huddle");
  assert.ok(l.deposits[`sol-${r.signature}`], "credited through the usual sol-<signature> key");
  assert.ok(l.chain?.some((e) => e.kind === "deposit" && e.sig === r.signature && e.via === "instant"));
  const view = lobby.publicView(l, toks[0], "http://x") as { me: { wallet: string | null; solanaAddress: string | null } };
  assert.equal(view.me.wallet, "huddle");

  // Same nonce again: same transaction, nothing new sent or credited.
  const again = await run(code, toks[0], 500, "nonce-1", rpc);
  assert.equal(again.signature, r.signature);
  assert.equal(again.credited, 0);
  assert.equal(rpc.sent.length, 1);
  // A parallel burst with one fresh nonce: exactly one transaction.
  const burst = await Promise.allSettled([1, 2, 3].map(() => run(code, toks[0], 1000, "nonce-2", rpc)));
  assert.equal(rpc.sent.length, 2);
  assert.ok(burst.some((b) => b.status === "fulfilled" && b.value.credited === 1000));
  l = (await lobby.getLobby(code))!;
  me = lobby.requirePlayer(l, toks[0]);
  assert.equal(me.balance, 1500);
  // A new nonce is a new payment.
  await run(code, toks[0], 500, "nonce-3", rpc);
  assert.equal(lobby.requirePlayer((await lobby.getLobby(code))!, toks[0]).balance, 2000);
});

test("an unconfirmed instant deposit answers pending, and a retry credits it once it lands", async () => {
  const { code, toks } = await lobbyWith(["Bo"]);
  const rpc = mockRpc({ status: null });
  const r = await run(code, toks[0], 500, "slow-1", rpc);
  assert.equal(r.pending, true);
  assert.equal(r.credited, 0);
  const l = (await lobby.getLobby(code))!;
  assert.ok(Object.values(l.solanaRefs ?? {}).some((v) => v.cents === 500), "recorded like a /deposit request, so sync finds it");
  const rpc2 = Object.assign(rpc, { getSignatureStatus: async () => ({ value: { err: null, confirmationStatus: "confirmed" } }) });
  const r2 = await run(code, toks[0], 500, "slow-1", rpc2);
  assert.equal(r2.credited, 500);
  assert.equal(rpc.sent.length, 1);
});

test("a player with their own wallet keeps it as the payout address", async () => {
  const { code, toks } = await lobbyWith(["Cy"]);
  const own = Keypair.generate().publicKey.toBase58();
  await lobby.mutate(code, (l) => {
    const p = lobby.requirePlayer(l, toks[0]);
    p.solanaAddress = own;
    p.wallet = "own";
  });
  await run(code, toks[0], 500, "own-1", mockRpc());
  const me = lobby.requirePlayer((await lobby.getLobby(code))!, toks[0]);
  assert.equal(me.balance, 500);
  assert.equal(me.solanaAddress, own);
  assert.equal(me.wallet, "own");
});

test("a refused simulation charges nothing and the same nonce can try again", async () => {
  const { code, toks } = await lobbyWith(["Di"]);
  await assert.rejects(run(code, toks[0], 500, "sim-1", mockRpc({ failSend: "Transaction simulation failed: insufficient funds" })), /Nothing was charged/);
  assert.equal(lobby.requirePlayer((await lobby.getLobby(code))!, toks[0]).balance, 0);
  const r = await run(code, toks[0], 500, "sim-1", mockRpc());
  assert.equal(r.credited, 500);
});

test("refused in demo lobbies, needs a player, same amount limits as /deposit", async () => {
  const demo = await lobbyWith(["Ed"], "demo");
  const d = await post(demo.code, { cents: 500 }, demo.toks[0]);
  assert.equal(d.status, 400);
  assert.match(((await d.json()) as { error: string }).error, /demo money/);
  const sol = await lobbyWith(["Fi"]);
  assert.equal((await post(sol.code, { cents: 500 })).status, 401);
  for (const cents of [0, 50, 1.5, "abc", 10_000_000]) {
    const r = await post(sol.code, { cents }, sol.toks[0]);
    assert.equal(r.status, 400, `cents ${cents}`);
  }
  assert.equal((await post(sol.code, { cents: 500, nonce: "bad nonce!" }, sol.toks[0])).status, 400);
  assert.equal(lobby.requirePlayer((await lobby.getLobby(sol.code))!, sol.toks[0]).balance, 0);
});
