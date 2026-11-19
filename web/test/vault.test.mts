// SETTLEMENT=vault without a validator: the huddle_vault wire format (discriminators from the IDL, the 127-byte
// signed state, the Ed25519 instruction, account decoding, the payout math of settle.rs), the off-chain inputs to
// settlement, the chain view and "Pay on the box" (route, boxPay shape, the throttled read-path check on a mocked RPC,
// expiry). The real chain is covered by the opt-in `npm run test:vault-localnet`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
const { Keypair, Ed25519Program } = await import("@solana/web3.js");
const TREASURY_KP = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();
process.env.MONEY_MODE = "solana";
process.env.SETTLEMENT = "vault";
process.env.SOLANA_TREASURY_SECRET_KEY = JSON.stringify(Array.from(TREASURY_KP.secretKey));
process.env.USDC_MINT = MINT;
process.env.SOLANA_RPC_URL = "http://127.0.0.1:9"; // nothing listens: any real RPC call fails fast

const vault = await import("../lib/vault.ts");
const chain = await import("../lib/chain.ts");
const lobby = await import("../lib/lobby.ts");
const solLobby = await import("../lib/solana-lobby.ts");
const money = await import("../lib/money.ts");
const boxRoute = await import("../app/api/lobby/[code]/deposit/box/route.ts");
const wallet = await import("../scripts/solana-wallet.mjs");
const bs58 = (await import("bs58")).default;

// target/idl/huddle_vault.json
const IDL_IX: Record<string, number[]> = {
  create_party: [251, 84, 246, 151, 106, 204, 201, 22],
  deposit: [242, 35, 198, 137, 82, 225, 242, 182],
  finalize: [171, 61, 218, 56, 127, 115, 12, 217],
  request_close: [82, 168, 167, 86, 14, 15, 199, 180],
  submit_state: [172, 31, 42, 160, 233, 237, 4, 251],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  withdraw_host: [103, 247, 115, 166, 187, 165, 7, 18],
};

test("modes: MONEY_MODE=solana + SETTLEMENT=vault turns the vault on; moneyInfo says so", () => {
  assert.equal(money.MONEY_MODE, "solana");
  assert.equal(vault.isVault(), true);
  assert.equal(vault.vaultProgramId(), "GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu");
  assert.equal(money.moneyInfo().settlement, "vault");
  assert.equal(money.moneyInfo().boxPay, true);
});

test("Anchor discriminators match the program's IDL", () => {
  for (const [name, bytes] of Object.entries(IDL_IX)) assert.deepEqual([...vault.disc("global", name)], bytes, name);
  assert.deepEqual([...vault.disc("account", "Party")], [208, 64, 165, 146, 114, 138, 161, 100]);
  assert.deepEqual([...vault.disc("account", "Member")], [54, 19, 162, 21, 29, 166, 17, 198]);
});

test("signed state: 127-byte message as ed25519.rs builds it, a valid signature, the Ed25519 instruction web3.js would build", () => {
  const party = new Uint8Array(32).fill(1);
  const member = new Uint8Array(32).fill(2);
  const hash = new Uint8Array(32).fill(9);
  const m = vault.stateMessage(party, member, 37n, 14_200_000n, hash);
  assert.equal(m.length, 127);
  assert.equal(m.subarray(0, 15).toString(), "HUDDLE_STATE_V1");
  assert.deepEqual([...m.subarray(15, 47)], [...party]);
  assert.deepEqual([...m.subarray(47, 79)], [...member]);
  assert.equal(m.readBigUInt64LE(79), 37n);
  assert.equal(m.readBigUInt64LE(87), 14_200_000n);
  assert.deepEqual([...m.subarray(95)], [...hash]);
  const box = Keypair.generate();
  const sig = vault.signEd25519(box.secretKey, m);
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), box.publicKey.toBuffer()]), format: "der", type: "spki" });
  assert.ok(verify(null, m, pub, sig), "signature verifies");
  const ours = vault.ed25519Data([{ publicKey: box.publicKey.toBytes(), signature: sig }], m);
  const theirs = Ed25519Program.createInstructionWithPrivateKey({ privateKey: box.secretKey, message: m }).data;
  assert.deepEqual([...ours], [...theirs], "self-contained offsets (0xffff), same bytes as web3.js");
  // Each *_instruction_index is u16::MAX, the only form huddle_vault accepts.
  assert.equal(ours.readUInt16LE(4), 0xffff);
  assert.equal(ours.readUInt16LE(8), 0xffff);
  assert.equal(ours.readUInt16LE(14), 0xffff);
});

test("Party and Member accounts decode at the Borsh offsets of state.rs", async () => {
  const p = Buffer.alloc(8 + 286);
  vault.disc("account", "Party").copy(p, 0);
  const host = Keypair.generate().publicKey;
  host.toBuffer().copy(p, 8);
  p[168] = 2; // finalized
  p.writeUInt32LE(3, 172);
  p.writeUInt32LE(1, 180);
  p.writeBigUInt64LE(25_000_000n, 212);
  p.writeBigUInt64LE(123n, 252);
  p.writeBigUInt64LE(26_000_000n, 268);
  p[276] = 1;
  p.writeBigUInt64LE(77n, 277);
  p[285] = 1;
  const d = await vault.decodeParty(p);
  assert.equal(d.host, host.toBase58());
  assert.equal(d.status, "finalized");
  assert.equal(d.memberCount, 3);
  assert.equal(d.withdrawnCount, 1);
  assert.equal(d.totalDeposits, 25_000_000n);
  assert.equal(d.finalizedSum, 123n);
  assert.equal(d.available, 26_000_000n);
  assert.equal(d.cut, true);
  assert.equal(d.hostRefund, 77n);
  assert.equal(d.hostRefundPaid, true);
  const m = Buffer.alloc(8 + 131);
  vault.disc("account", "Member").copy(m, 0);
  m.writeBigUInt64LE(10_000_000n, 72);
  m.writeBigUInt64LE(15_000_000n, 80);
  m.writeBigUInt64LE(1n, 88);
  m[128] = 1;
  const md = await vault.decodeMember(m);
  assert.equal(md.deposited, 10_000_000n);
  assert.equal(md.claimBalance, 15_000_000n);
  assert.equal(md.hasClaim, true);
  assert.equal(md.withdrawn, false);
  await assert.rejects(vault.decodeParty(m), /not a huddle_vault Party/);
});

test("payout math equals settle.rs: claim in full, or cut pro rata (floor) when claims exceed the vault", () => {
  const full = { cut: false, available: 25n, finalizedSum: 20n };
  assert.equal(vault.payoutUnits({ hasClaim: true, claimBalance: 15n, deposited: 10n }, full), 15n);
  assert.equal(vault.payoutUnits({ hasClaim: false, claimBalance: 0n, deposited: 10n }, full), 10n, "no claim: the deposit");
  const cut = { cut: true, available: 25n, finalizedSum: 28n };
  assert.equal(vault.payoutUnits({ hasClaim: true, claimBalance: 18n, deposited: 10n }, cut), (18n * 25n) / 28n);
  assert.equal(vault.payoutUnits({ hasClaim: true, claimBalance: 18n, deposited: 10n }, { cut: true, available: 5n, finalizedSum: 0n }), 0n);
});

async function lobbyWith(names: string[]) {
  const l = await lobby.createLobby(`vt${Math.random().toString(36).slice(2, 7)}`, "football");
  const toks: string[] = [];
  await lobby.mutate(l.code, (x, now) => {
    for (const n of names) toks.push(lobby.join(x, n, now).token);
  });
  return { code: l.code, toks };
}

test("settlement inputs: credited deposits to sweep, final claims only for money in the vault", async () => {
  const { code, toks } = await lobbyWith(["Ann", "Ben"]);
  let l = await lobby.mutate(code, (x, now) => {
    const a = lobby.requirePlayer(x, toks[0]);
    const b = lobby.requirePlayer(x, toks[1]);
    lobby.creditDeposit(x, a.id, 1000, "solana", "sol-SIG1", now);
    lobby.creditDeposit(x, b.id, 500, "solana", "sol-SIG2", now);
    lobby.creditDeposit(x, b.id, 500, "demo", "demo-x", now);
  });
  assert.deepEqual(vault.sweepsDue(l).map(([k]) => k).sort(), ["sol-SIG1", "sol-SIG2"]);
  l = await lobby.mutate(code, (x, now) => {
    x.vault = { program: "P", party: "PA", vault: "V", partyId: "00", host: "H", boxSigner: "B", explorer: "e", status: "open", states: {}, payouts: {}, sweeps: { "sol-SIG1": { playerId: lobby.requirePlayer(x, toks[0]).id, cents: 1000, status: "sent", at: now } } };
    lobby.requirePlayer(x, toks[0]).balance = 1740;
  });
  assert.deepEqual(vault.sweepsDue(l).map(([k]) => k), ["sol-SIG2"]);
  const claims = vault.finalClaims(l);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].cents, 1740);
  assert.equal(claims[0].deposited, 1000);
  assert.equal(vault.partyIdFor(code, l.createdAt).length, 32);
  assert.notDeepEqual([...vault.partyIdFor(code, l.createdAt)], [...vault.partyIdFor(code, l.createdAt + 1)], "a new lobby with the same code gets a new party");
  assert.equal(vault.stateHashFor(l, "x", 1, 2).length, 32);
});

test("seats and the box signer are derived from the treasury key: stable, distinct per player and party", async () => {
  const a = await vault.accountsFor({ code: "ABCD", createdAt: 1 });
  const b = await vault.accountsFor({ code: "ABCD", createdAt: 2 });
  assert.equal(a.host.toBase58(), TREASURY_KP.publicKey.toBase58());
  assert.notEqual(a.party.toBase58(), b.party.toBase58());
  const s1 = await vault.seatFor(a, "p1");
  assert.equal((await vault.seatFor(a, "p1")).publicKey.toBase58(), s1.publicKey.toBase58());
  assert.notEqual((await vault.seatFor(a, "p2")).publicKey.toBase58(), s1.publicKey.toBase58());
  assert.notEqual((await vault.seatFor(b, "p1")).publicKey.toBase58(), s1.publicKey.toBase58());
  const box = await vault.boxSigner();
  assert.notEqual(box.publicKey.toBase58(), TREASURY_KP.publicKey.toBase58());
});

test("chain events: recorded once per signature and kind, streamed flag, the public `chain` view", async () => {
  const { code, toks } = await lobbyWith(["Cy"]);
  const l = await lobby.mutate(code, (x, now) => {
    const p = lobby.requirePlayer(x, toks[0]);
    chain.pushChainEvent(x, { at: now, kind: "deposit", sig: "S1", explorer: "https://explorer.solana.com/tx/S1?cluster=devnet", playerId: p.id, cents: 500, via: "sync" });
    chain.pushChainEvent(x, { at: now, kind: "deposit", sig: "S1", explorer: "x", via: "quicknode" });
    chain.pushChainEvent(x, { at: now, kind: "finalize", sig: "F1", explorer: "https://explorer.solana.com/tx/F1?cluster=devnet", via: "server" });
    x.vault = { program: "P", party: "PA", vault: "V", partyId: "00", host: "H", boxSigner: "B", explorer: "https://explorer.solana.com/address/PA?cluster=devnet", status: "finalized", states: {}, sweeps: {}, finalized: { sig: "F1", explorer: "https://explorer.solana.com/tx/F1?cluster=devnet", at: now }, payouts: { [p.id]: { sig: "W1", explorer: "w", at: now, cents: 640, to: "Dest" } } };
  });
  assert.equal(l.chain!.length, 2);
  assert.equal(l.chain![0].streamed, true);
  const v = lobby.publicView(l, toks[0], "http://x");
  assert.equal(v.chain!.settlement, "vault");
  assert.equal(v.chain!.settled, true);
  assert.equal(v.chain!.settleTx!.sig, "F1");
  assert.equal(v.chain!.payout!.cents, 640);
  assert.equal(v.chain!.events[0].name, "Cy");
  assert.equal(v.chain!.events[1].label, "Settled on Solana");
  const { code: c2 } = await lobbyWith(["Di"]);
  assert.equal(lobby.publicView((await lobby.getLobby(c2))!, null, "http://x").chain, null, "no chain activity: null");
});

const post = (url: string, body: unknown, token?: string) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-player-token": token } : {}) }, body: JSON.stringify(body) });

test("Pay on the box: route sets lobby.boxPay with the exact shape and a spec Solana Pay URL", async () => {
  const { code, toks } = await lobbyWith(["Eve"]);
  const params = { params: Promise.resolve({ code }) };
  assert.equal((await boxRoute.POST(post(`http://x/api/lobby/${code}/deposit/box`, { cents: 50 }, toks[0]), params)).status, 400, "$1 to $100 only");
  assert.equal((await boxRoute.POST(post(`http://x/api/lobby/${code}/deposit/box`, { cents: 500 }), params)).status, 401, "player token needed");
  const r = await boxRoute.POST(post(`http://x/api/lobby/${code}/deposit/box`, { cents: 500 }, toks[0]), params);
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, string>;
  const l = (await lobby.getLobby(code).catch(() => null)) ?? (await lobby.mutate(code, () => {}));
  const bp = l.boxPay!;
  assert.deepEqual(Object.keys(bp).sort(), ["at", "cents", "name", "paidAt", "playerId", "reference", "until", "url"]);
  assert.equal(bp.name, "Eve");
  assert.equal(bp.cents, 500);
  assert.equal(bp.url, j.url);
  assert.equal(bp.reference, j.reference);
  assert.equal(bp.paidAt, null);
  assert.ok(Math.abs(bp.until - bp.at - 90_000) < 5);
  assert.equal(l.solanaRefs![bp.reference].cents, 500, "recorded like a normal deposit request");
  const req = wallet.parseTransferRequest(bp.url);
  assert.equal(req.recipient.toBase58(), TREASURY_KP.publicKey.toBase58());
  assert.equal(req.amount, "5");
  assert.equal(req.splToken.toBase58(), MINT);
  assert.equal(req.reference[0].toBase58(), bp.reference);
  assert.deepEqual(await solLobby.lookupRef(bp.reference), { code, playerId: bp.playerId }, "global reference index for the webhook");
});

/** A mocked RPC with one payment of `cents` from `from` to the treasury, tagged with `reference`. */
function mockRpc(reference: string, signature: string, cents: number, from: string) {
  const t = TREASURY_KP.publicKey.toBase58();
  const units = (n: number) => ({ amount: String(n * 10_000), decimals: 6, uiAmount: null, uiAmountString: "" });
  const tx = {
    slot: 1,
    meta: {
      err: null,
      preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: units(5000) }, { accountIndex: 2, mint: MINT, owner: t, uiTokenAmount: units(0) }],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: from, uiTokenAmount: units(5000 - cents) }, { accountIndex: 2, mint: MINT, owner: t, uiTokenAmount: units(cents) }],
    },
    transaction: { message: { accountKeys: [from, "A1", "A2", reference].map((k) => ({ pubkey: { toBase58: () => k }, signer: false, writable: false })) } },
  };
  let txCalls = 0;
  return {
    calls: () => txCalls,
    rpc: {
      getSignaturesForAddress: async (pk: { toBase58(): string }) => (pk.toBase58() === reference ? [{ signature, err: null }] : []),
      getParsedTransaction: async (sig: string) => {
        txCalls++;
        return sig === signature ? tx : null;
      },
    } as never,
  };
}

test("box payment: the read-path check credits once, sets paidAt, throttles to one RPC look every 3 s, then boxPay clears", async () => {
  const { code, toks } = await lobbyWith(["Fay"]);
  await boxRoute.POST(post(`http://x/api/lobby/${code}/deposit/box`, { cents: 1000 }, toks[0]), { params: Promise.resolve({ code }) });
  let l = await lobby.mutate(code, () => {});
  const from = Keypair.generate().publicKey.toBase58();
  const sig = bs58.encode(Buffer.alloc(64, 7));
  const m = mockRpc(l.boxPay!.reference, sig, 1000, from);
  const opts = { rpc: m.rpc, treasury: TREASURY_KP.publicKey.toBase58(), mint: MINT };
  assert.equal(await solLobby.checkBoxPay(l, opts), true);
  l = await lobby.mutate(code, () => {});
  const me = lobby.requirePlayer(l, toks[0]);
  assert.equal(me.balance, 1000);
  assert.equal(me.solanaAddress, from);
  assert.ok(l.boxPay!.paidAt, "paidAt set");
  assert.equal(l.chain!.find((e) => e.kind === "deposit")!.via, "box");
  // Already paid: nothing more to look at.
  assert.equal(await solLobby.checkBoxPay(l, opts), false);
  // A second box request within 3 s of the last check is not looked up again (throttle).
  await lobby.mutate(code, (x, now) => {
    x.boxPay = { ...x.boxPay!, reference: Keypair.generate().publicKey.toBase58(), paidAt: null, until: now + 90_000 };
  });
  l = await lobby.mutate(code, () => {});
  const before = m.calls();
  assert.equal(await solLobby.checkBoxPay(l, opts), false);
  assert.equal(m.calls(), before, "throttled");
  // Paid 4 s ago -> gone; unpaid past `until` -> gone.
  await lobby.mutate(code, (x, now) => {
    x.boxPay = { ...x.boxPay!, paidAt: now - 4100 };
  });
  assert.equal((await lobby.getLobby(code))!.boxPay, null);
  await lobby.mutate(code, (x, now) => {
    x.boxPay = { playerId: me.id, name: "Fay", cents: 500, url: "solana:x", reference: "r", at: now - 100_000, until: now - 10_000, paidAt: null };
  });
  assert.equal((await lobby.getLobby(code))!.boxPay, null);
  // Re-crediting the same signature through polling does nothing.
  const again = await solLobby.creditPayments(code, me.id, [{ ref: "r", pays: [{ signature: sig, cents: 1000 }], paid: true }], "sync");
  assert.equal(again.credited, 0);
});
