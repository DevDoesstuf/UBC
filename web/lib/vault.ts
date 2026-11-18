// SETTLEMENT=vault (with MONEY_MODE=solana): each party's money sits in its own huddle_vault program account on
// Solana and the end of the game settles on chain. Server only.
//
// Program: programs/huddle_vault (Anchor), id HUDDLE_VAULT_PROGRAM_ID (default GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu).
//   create_party -> deposit* -> request_close -> submit_state* (Ed25519-verified) -> finalize -> withdraw* + withdraw_host
//
// How a lobby maps onto it:
//  - Party PDA ["party", host, party_id]: host = the treasury, party_id = sha256("huddle-party-v1|<code>|<createdAt>"),
//    box_signer = a key only the server holds (HUDDLE_BOX_SIGNER_SECRET_KEY, else derived from the treasury key),
//    no bond, challenge window 0 s, trusted-host mode (only the box signature is required on a state).
//    Its token vault is the PDA ["vault", party], owned by the party PDA: only the program can move it.
//  - Every player gets a seat key for this party (derived from the treasury key, the party and the player id).
//    The seat is the program's `member`; its Member PDA ["member", party, seat] holds what it deposited and its
//    verified final balance.
//  - Deposits stay Solana Pay transfer requests to the treasury wallet, so any wallet works (the spec only lets a
//    transfer request name a wallet, whose associated token account receives the tokens; the vault is a PDA-owned
//    account, not an associated token account). As soon as a payment is credited, ONE treasury-paid transaction
//    sweeps it into the vault: treasury -> seat token account -> program `deposit` -> vault, then the empty seat
//    token account is closed (its rent goes back to the treasury).
//  - End of game: if the room won more than it put in, the house tops the vault up (a house seat with claim 0).
//    request_close; then per member an Ed25519 program instruction with the box signature over
//    "HUDDLE_STATE_V1" || party || seat || nonce || balance || state_hash, followed by submit_state, which checks
//    that signature through the instructions sysvar; finalize; then per player ONE transaction: withdraw (vault ->
//    seat) + transfer to the player's own wallet + close the seat token account. withdraw_host returns the house's
//    share (and rounding dust) to the treasury.
//  - The treasury pays every fee and all rent, so players never need SOL for anything but their own Solana Pay send.
//  - Every step reads the program accounts first, so running it twice (retries, two servers) never repeats a step.
//    Every signature lands in lobby.vault and lobby.chain (explorer links for the phone and the TV).
import { createHash, createPrivateKey, randomBytes, sign as edSign } from "crypto";
import type { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { pushChainEvent } from "./chain";
import { getLobby, mutate, normCode } from "./lobby";
import { MONEY_MODE } from "./money";
import { SolanaSendError, UNITS_PER_CENT, USDC_DECIMALS, connection, explorerAddress, explorerTx, mint, mintInfo, parseSecretKey, sendTreasuryTx, signatureOutcome, treasury, treasuryFundsIxs } from "./solana";
import { kvDel, kvGet, kvSet } from "./store";
import type { ChainEvent, Lobby, LobbyVault } from "./types";

const env = (k: string) => (process.env[k] || "").trim();

export const DEFAULT_VAULT_PROGRAM_ID = "GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu";
export const vaultRequested = () => env("SETTLEMENT") === "vault";
export const vaultProgramId = () => env("HUDDLE_VAULT_PROGRAM_ID") || DEFAULT_VAULT_PROGRAM_ID;
/** Vault settlement is on: MONEY_MODE=solana is running and SETTLEMENT=vault. */
export const isVault = () => MONEY_MODE === "solana" && vaultRequested();

// ---------------------------------------------------------------- wire format (pure, unit tested)

export const PARTY_SEED = "party";
export const MEMBER_SEED = "member";
export const VAULT_SEED = "vault";
export const STATE_DOMAIN = "HUDDLE_STATE_V1";
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";

/** Anchor discriminators sha256("global:<name>")[0..8] / sha256("account:<Name>")[0..8] (same as target/idl). */
export const disc = (kind: "global" | "account" | "event", name: string) => createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);

const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

/** The canonical 127-byte signed balance message (programs/huddle_vault/src/ed25519.rs `state_message`). */
export function stateMessage(party: Uint8Array, member: Uint8Array, nonce: bigint, balance: bigint, stateHash: Uint8Array): Buffer {
  if (party.length !== 32 || member.length !== 32 || stateHash.length !== 32) throw new Error("state message: 32-byte keys and hash");
  return Buffer.concat([Buffer.from(STATE_DOMAIN), Buffer.from(party), Buffer.from(member), u64(nonce), u64(balance), Buffer.from(stateHash)]);
}

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
/** Ed25519 signature with a 64-byte Solana secret key (seed || public key), using Node's crypto. */
export function signEd25519(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return new Uint8Array(edSign(null, Buffer.from(message), key));
}

/**
 * Native Ed25519 program instruction verifying `signers` over `message`. Every offset points into this
 * instruction's own data (index 0xffff), which is the only form huddle_vault accepts.
 */
export function ed25519Data(signers: { publicKey: Uint8Array; signature: Uint8Array }[], message: Uint8Array): Buffer {
  const n = signers.length;
  const keysStart = 2 + n * 14;
  const msgOff = keysStart + n * 96;
  const d = Buffer.alloc(msgOff + message.length);
  d.writeUInt8(n, 0);
  signers.forEach((s, i) => {
    const pk = keysStart + i * 96;
    const o = 2 + i * 14;
    d.writeUInt16LE(pk + 32, o);
    d.writeUInt16LE(0xffff, o + 2);
    d.writeUInt16LE(pk, o + 4);
    d.writeUInt16LE(0xffff, o + 6);
    d.writeUInt16LE(msgOff, o + 8);
    d.writeUInt16LE(message.length, o + 10);
    d.writeUInt16LE(0xffff, o + 12);
    d.set(s.publicKey, pk);
    d.set(s.signature, pk + 32);
  });
  d.set(message, msgOff);
  return d;
}

/** sha256 over "|"-joined parts, as 32 bytes. */
const h32 = (...parts: (string | Uint8Array)[]) => {
  const h = createHash("sha256");
  parts.forEach((p, i) => {
    if (i) h.update("|");
    h.update(typeof p === "string" ? Buffer.from(p) : Buffer.from(p));
  });
  return new Uint8Array(h.digest());
};

export const partyIdFor = (code: string, createdAt: number) => h32("huddle-party-v1", code, String(createdAt));

/** What the box signs for a player at the end: commits to the lobby, the player and their final ledger line. */
export function stateHashFor(l: Pick<Lobby, "code" | "createdAt" | "results">, who: string, cents: number, deposited: number): Uint8Array {
  return h32("huddle-final-v1", l.code, String(l.createdAt), who, String(cents), String(deposited), String(l.results.length));
}

export interface PartyAccount {
  host: string;
  boxSigner: string;
  mint: string;
  vault: string;
  status: "open" | "closing" | "finalized";
  memberCount: number;
  withdrawnCount: number;
  challengeSecs: number;
  closeRequestedAt: number;
  totalDeposits: bigint;
  bond: bigint;
  finalizedSum: bigint;
  available: bigint;
  cut: boolean;
  hostRefund: bigint;
  hostRefundPaid: boolean;
  totalPaid: bigint;
}

export interface MemberAccount {
  party: string;
  wallet: string;
  deposited: bigint;
  claimBalance: bigint;
  claimNonce: bigint;
  hasClaim: boolean;
  withdrawn: boolean;
  paidOut: bigint;
}

const b58 = async (b: Uint8Array) => (await import("bs58")).default.encode(b);

/** Decodes a Party account (8-byte discriminator + Borsh, programs/huddle_vault/src/state.rs). */
export async function decodeParty(data: Uint8Array): Promise<PartyAccount> {
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(disc("account", "Party"))) throw new Error("not a huddle_vault Party account");
  const u128 = (o: number) => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << BigInt(64));
  const status = (["open", "closing", "finalized"] as const)[b[168]];
  return {
    host: await b58(b.subarray(8, 40)),
    boxSigner: await b58(b.subarray(72, 104)),
    mint: await b58(b.subarray(104, 136)),
    vault: await b58(b.subarray(136, 168)),
    status,
    memberCount: b.readUInt32LE(172),
    withdrawnCount: b.readUInt32LE(180),
    challengeSecs: b.readUInt32LE(184),
    closeRequestedAt: Number(b.readBigInt64LE(196)),
    totalDeposits: b.readBigUInt64LE(212),
    bond: b.readBigUInt64LE(220),
    finalizedSum: u128(252),
    available: b.readBigUInt64LE(268),
    cut: b[276] === 1,
    hostRefund: b.readBigUInt64LE(277),
    hostRefundPaid: b[285] === 1,
    totalPaid: b.readBigUInt64LE(286),
  };
}

export async function decodeMember(data: Uint8Array): Promise<MemberAccount> {
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(disc("account", "Member"))) throw new Error("not a huddle_vault Member account");
  return {
    party: await b58(b.subarray(8, 40)),
    wallet: await b58(b.subarray(40, 72)),
    deposited: b.readBigUInt64LE(72),
    claimBalance: b.readBigUInt64LE(80),
    claimNonce: b.readBigUInt64LE(88),
    hasClaim: b[128] === 1,
    withdrawn: b[129] === 1,
    paidOut: b.readBigUInt64LE(130),
  };
}

/** settle.rs `payout`: the member's claim (or deposit), cut pro rata when claims exceed what the vault holds. */
export function payoutUnits(m: Pick<MemberAccount, "hasClaim" | "claimBalance" | "deposited">, p: Pick<PartyAccount, "cut" | "available" | "finalizedSum">): bigint {
  const effective = m.hasClaim ? m.claimBalance : m.deposited;
  if (!p.cut) return effective;
  if (p.finalizedSum === BigInt(0)) return BigInt(0);
  return (effective * p.available) / p.finalizedSum;
}

/** Off-chain final balances to submit: every player who has money in the vault, in cents. */
export function finalClaims(l: Lobby): { playerId: string; cents: number; deposited: number }[] {
  const swept = new Map<string, number>();
  for (const s of Object.values(l.vault?.sweeps ?? {})) if (s.status === "sent") swept.set(s.playerId, (swept.get(s.playerId) ?? 0) + s.cents);
  return [...swept.entries()].map(([playerId, deposited]) => ({ playerId, cents: Math.max(0, l.players[playerId]?.balance ?? 0), deposited }));
}

/** Credited Solana deposits that still have to be moved into the vault (or whose sweep is unclear). */
export function sweepsDue(l: Lobby): [string, { playerId: string; cents: number }][] {
  const out: [string, { playerId: string; cents: number }][] = [];
  for (const [ref, d] of Object.entries(l.deposits)) {
    if (d.source !== "solana" || !ref.startsWith("sol-")) continue;
    const s = l.vault?.sweeps[ref];
    if (!s || s.status !== "sent") out.push([ref, { playerId: d.playerId, cents: d.cents }]);
  }
  return out;
}

// ---------------------------------------------------------------- keys and addresses

async function web3() {
  return import("@solana/web3.js");
}
async function spl() {
  return import("@solana/spl-token");
}

/** A deterministic key from the treasury secret: only this server can derive it, nothing to store. */
async function derived(domain: string, ...parts: (string | Uint8Array)[]): Promise<Keypair> {
  const { Keypair } = await web3();
  const t = await treasury();
  return Keypair.fromSeed(h32(domain, t.secretKey, ...parts));
}

let boxKp: Keypair | null = null;
export async function boxSigner(): Promise<Keypair> {
  if (!boxKp) {
    const raw = env("HUDDLE_BOX_SIGNER_SECRET_KEY");
    const { Keypair } = await web3();
    boxKp = raw ? Keypair.fromSecretKey(await parseSecretKey(raw)) : await derived("huddle-box-signer-v1");
  }
  return boxKp;
}

export interface VaultAccounts {
  program: PublicKey;
  host: PublicKey;
  partyId: Uint8Array;
  party: PublicKey;
  vault: PublicKey;
}

export async function accountsFor(l: Pick<Lobby, "code" | "createdAt">): Promise<VaultAccounts> {
  const { PublicKey } = await web3();
  const program = new PublicKey(vaultProgramId());
  const host = (await treasury()).publicKey;
  const partyId = partyIdFor(l.code, l.createdAt);
  const [party] = PublicKey.findProgramAddressSync([Buffer.from(PARTY_SEED), host.toBuffer(), Buffer.from(partyId)], program);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), party.toBuffer()], program);
  return { program, host, partyId, party, vault };
}

/** The player's seat (the program's `member`) in this party. */
export async function seatFor(a: VaultAccounts, playerId: string): Promise<Keypair> {
  return derived("huddle-seat-v1", a.party.toBytes(), playerId);
}

async function memberPda(a: VaultAccounts, wallet: PublicKey): Promise<PublicKey> {
  const { PublicKey } = await web3();
  return PublicKey.findProgramAddressSync([Buffer.from(MEMBER_SEED), a.party.toBuffer(), wallet.toBuffer()], a.program)[0];
}

// ---------------------------------------------------------------- instructions

async function ix(a: VaultAccounts, name: string, keys: [PublicKey, boolean, boolean][], data: Buffer = Buffer.alloc(0)): Promise<TransactionInstruction> {
  const { TransactionInstruction } = await web3();
  return new TransactionInstruction({
    programId: a.program,
    keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })),
    data: Buffer.concat([disc("global", name), data]),
  });
}

async function programs() {
  const { SystemProgram, PublicKey } = await web3();
  const s = await spl();
  return { system: SystemProgram.programId, token: s.TOKEN_PROGRAM_ID, ata: s.ASSOCIATED_TOKEN_PROGRAM_ID, sysvarIx: new PublicKey(INSTRUCTIONS_SYSVAR), ed: new PublicKey(ED25519_PROGRAM) };
}

async function ata(owner: PublicKey): Promise<PublicKey> {
  return (await spl()).getAssociatedTokenAddressSync(await mint(), owner, true);
}

async function depositIx(a: VaultAccounts, payer: PublicKey, member: PublicKey, memberToken: PublicKey, units: bigint) {
  const p = await programs();
  return ix(a, "deposit", [
    [payer, true, true], [member, true, false], [a.party, false, true], [await memberPda(a, member), false, true],
    [await mint(), false, false], [memberToken, false, true], [a.vault, false, true], [p.token, false, false], [p.system, false, false],
  ], u64(units));
}

async function withdrawIx(a: VaultAccounts, payer: PublicKey, wallet: PublicKey) {
  const p = await programs();
  return ix(a, "withdraw", [
    [payer, true, true], [a.party, false, true], [await memberPda(a, wallet), false, true], [wallet, false, false],
    [await mint(), false, false], [a.vault, false, true], [await ata(wallet), false, true],
    [p.token, false, false], [p.ata, false, false], [p.system, false, false],
  ]);
}

// ---------------------------------------------------------------- reading the program accounts

async function readParty(c: Connection, a: VaultAccounts): Promise<PartyAccount | null> {
  const acct = await c.getAccountInfo(a.party, "confirmed");
  if (!acct) return null;
  if (!acct.owner.equals(a.program)) throw new Error(`party ${a.party.toBase58()} is not owned by the vault program`);
  return decodeParty(acct.data);
}

async function readMember(c: Connection, a: VaultAccounts, wallet: PublicKey): Promise<MemberAccount | null> {
  const acct = await c.getAccountInfo(await memberPda(a, wallet), "confirmed");
  return acct ? decodeMember(acct.data) : null;
}

// ---------------------------------------------------------------- recording

async function record(code: string, fn: (l: Lobby, v: LobbyVault, now: number) => void): Promise<Lobby> {
  return mutate(code, (l, now) => {
    if (l.vault) fn(l, l.vault, now);
  });
}

const tx = (sig: string, at: number) => ({ sig, explorer: explorerTx(sig), at });
const event = (l: Lobby, kind: ChainEvent["kind"], sig: string, at: number, extra: Partial<ChainEvent> = {}) =>
  pushChainEvent(l, { at, kind, sig, explorer: explorerTx(sig), via: "server", ...extra });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 240);

// ---------------------------------------------------------------- the steps

/** Index party PDA -> lobby code, so QuickNode records of vault steps find their lobby. */
export const partyKey = (party: string) => `vaultparty:${party}`;

async function ensureParty(code: string, l: Lobby, c: Connection, a: VaultAccounts): Promise<PartyAccount> {
  const s = await spl();
  const t = await treasury();
  const box = await boxSigner();
  if (!l.vault) {
    await kvSet(partyKey(a.party.toBase58()), code, { px: 7 * 24 * 60 * 60 * 1000 });
    await mutate(code, (lobby) => {
      lobby.vault ??= {
        program: a.program.toBase58(), party: a.party.toBase58(), vault: a.vault.toBase58(), partyId: Buffer.from(a.partyId).toString("hex"),
        host: a.host.toBase58(), boxSigner: box.publicKey.toBase58(), explorer: explorerAddress(a.party.toBase58()), status: "open", sweeps: {}, states: {}, payouts: {},
      };
    });
  }
  const existing = await readParty(c, a);
  if (existing) return existing;
  const m = await mint();
  const hostToken = await ata(a.host);
  const p = await programs();
  const create = await ix(a, "create_party", [
    [t.publicKey, true, true], [a.host, true, false], [a.party, false, true], [m, false, false], [a.vault, false, true],
    [hostToken, false, true], [p.token, false, false], [p.system, false, false],
  ], Buffer.concat([Buffer.from(a.partyId), box.publicKey.toBuffer(), u32(0), u64(0), Buffer.from([0])]));
  const sig = await sendTreasuryTx([s.createAssociatedTokenAccountIdempotentInstruction(t.publicKey, hostToken, a.host, m), create]);
  await record(code, (lobby, v, now) => {
    v.created = tx(sig, now);
    event(lobby, "create", sig, now);
  });
  const party = await readParty(c, a);
  if (!party) throw new Error("create_party landed but the party account is not visible yet");
  return party;
}

/** treasury -> seat token account -> program deposit -> vault, and the seat token account closed again. One transaction. */
async function sweep(code: string, a: VaultAccounts, ref: string, d: { playerId: string; cents: number }, prev?: LobbyVault["sweeps"][string]): Promise<void> {
  if (prev?.status === "unclear" && prev.sig) {
    const o = await signatureOutcome(prev.sig, prev.validUntil).catch(() => "pending" as const);
    if (o === "pending") return;
    if (o === "landed") {
      await record(code, (l, v, now) => {
        v.sweeps[ref] = { ...v.sweeps[ref], status: "sent", error: undefined };
        event(l, "sweep", prev.sig!, now, { playerId: d.playerId, cents: d.cents });
      });
      return;
    }
  }
  const s = await spl();
  const t = await treasury();
  const m = await mint();
  const seat = await seatFor(a, d.playerId);
  const seatToken = await ata(seat.publicKey);
  const units = BigInt(d.cents) * BigInt(UNITS_PER_CENT);
  const funds = await treasuryFundsIxs(units);
  const ixs = [
    ...funds.ixs,
    s.createAssociatedTokenAccountIdempotentInstruction(t.publicKey, seatToken, seat.publicKey, m),
    s.createTransferCheckedInstruction(funds.source, m, seatToken, t.publicKey, units, USDC_DECIMALS),
    await depositIx(a, t.publicKey, seat.publicKey, seatToken, units),
    s.createCloseAccountInstruction(seatToken, t.publicKey, seat.publicKey),
  ];
  try {
    const sig = await sendTreasuryTx(ixs, [seat]);
    await record(code, (l, v, now) => {
      v.sweeps[ref] = { playerId: d.playerId, cents: d.cents, status: "sent", sig, explorer: explorerTx(sig), at: now };
      event(l, "sweep", sig, now, { playerId: d.playerId, cents: d.cents });
    });
  } catch (e) {
    const unclear = e instanceof SolanaSendError && e.landed === null && e.signature;
    await record(code, (_l, v, now) => {
      v.sweeps[ref] = unclear
        ? { playerId: d.playerId, cents: d.cents, status: "unclear", sig: (e as SolanaSendError).signature, validUntil: (e as SolanaSendError).lastValidBlockHeight, at: now, error: errText(e) }
        : { playerId: d.playerId, cents: d.cents, status: "pending", at: now, error: errText(e) };
    });
    throw e;
  }
}

async function settle(code: string, c: Connection, a: VaultAccounts): Promise<void> {
  const { PublicKey } = await web3();
  const s = await spl();
  const t = await treasury();
  const m = await mint();
  const box = await boxSigner();
  let l = (await getLobby(code))!;
  let party = await readParty(c, a);
  if (!party) {
    // Nobody ever deposited: nothing on chain to settle.
    await mutate(code, (lobby) => {
      if (lobby.vault) lobby.vault.status = "settled";
    });
    return;
  }
  const claims = finalClaims(l);

  // 1. Top up (the house lost) and close. Deposits are only accepted while the party is open.
  if (party.status === "open") {
    const claimUnits = claims.reduce((x, p) => x + BigInt(p.cents) * BigInt(UNITS_PER_CENT), BigInt(0));
    const short = claimUnits - party.totalDeposits;
    if (short > BigInt(0) && !(await readMember(c, a, t.publicKey))) {
      const funds = await treasuryFundsIxs(short);
      const sig = await sendTreasuryTx([...funds.ixs, await depositIx(a, t.publicKey, t.publicKey, funds.source, short)]);
      await record(code, (lobby, v, now) => {
        v.topUp = { ...tx(sig, now), cents: Number(short / BigInt(UNITS_PER_CENT)) };
        event(lobby, "topup", sig, now, { cents: v.topUp.cents });
      });
    }
    // The host (the treasury) closes; Anchor reads the program id in the optional member_account slot as "none".
    const sig = await sendTreasuryTx([await ix(a, "request_close", [[t.publicKey, true, false], [a.party, false, true], [a.program, false, false]])]);
    await record(code, (lobby, v, now) => {
      v.closed = tx(sig, now);
      v.status = "closing";
      event(lobby, "close", sig, now);
    });
    party = (await readParty(c, a))!;
  }

  // 2. Signed final balances, verified on chain (Ed25519 program + instructions sysvar), two members per transaction.
  if (party.status === "closing") {
    const members: { who: string | null; wallet: PublicKey; cents: number; deposited: number }[] = [];
    for (const cl of claims) members.push({ who: cl.playerId, wallet: (await seatFor(a, cl.playerId)).publicKey, cents: cl.cents, deposited: cl.deposited });
    if (await readMember(c, a, t.publicKey)) members.push({ who: null, wallet: t.publicKey, cents: 0, deposited: 0 });
    const todo: typeof members = [];
    for (const mb of members) {
      const acct = await readMember(c, a, mb.wallet);
      if (acct && !acct.hasClaim) todo.push(mb);
    }
    const p = await programs();
    const { TransactionInstruction } = await web3();
    for (let i = 0; i < todo.length; i += 2) {
      const batch = todo.slice(i, i + 2);
      const ixs: TransactionInstruction[] = [];
      for (const mb of batch) {
        const units = BigInt(mb.cents) * BigInt(UNITS_PER_CENT);
        const hash = stateHashFor(l, mb.who ?? "house", mb.cents, mb.deposited);
        const msg = stateMessage(a.party.toBytes(), mb.wallet.toBytes(), BigInt(1), units, hash);
        ixs.push(new TransactionInstruction({ programId: p.ed, keys: [], data: ed25519Data([{ publicKey: box.publicKey.toBytes(), signature: signEd25519(box.secretKey, msg) }], msg) }));
        ixs.push(await ix(a, "submit_state", [[a.party, false, true], [await memberPda(a, mb.wallet), false, true], [p.sysvarIx, false, false]],
          Buffer.concat([mb.wallet.toBuffer(), u64(1), u64(units), Buffer.from(hash)])));
      }
      const sig = await sendTreasuryTx(ixs);
      await record(code, (lobby, v, now) => {
        for (const mb of batch) {
          v.states[mb.wallet.toBase58()] = { ...tx(sig, now), cents: mb.cents, playerId: mb.who };
        }
        event(lobby, "state", sig, now, { cents: batch.reduce((x, mb) => x + mb.cents, 0) });
      });
    }
    const sig = await sendTreasuryTx([await ix(a, "finalize", [[a.party, false, true]])]);
    await record(code, (lobby, v, now) => {
      v.finalized = tx(sig, now);
      v.status = "finalized";
      event(lobby, "finalize", sig, now);
    });
    party = (await readParty(c, a))!;
  }

  // 3. Payouts: vault -> seat -> the player's own wallet, one transaction each. A player with no known wallet
  //    waits for their cash-out (which gives the address).
  if (party.status === "finalized") {
    l = (await getLobby(code))!;
    let pending = 0;
    for (const cl of claims) {
      const seat = await seatFor(a, cl.playerId);
      const mbr = await readMember(c, a, seat.publicKey);
      if (!mbr) continue;
      if (mbr.withdrawn) {
        if (!l.vault?.payouts[cl.playerId]) {
          // Landed but not recorded (an unclear send): take the signature we kept, else the member account's latest.
          const sig = l.vault?.inflight?.[`pay:${cl.playerId}`] ?? (await c.getSignaturesForAddress(await memberPda(a, seat.publicKey), { limit: 1 }))[0]?.signature ?? "";
          await paid(code, cl.playerId, Number(mbr.paidOut / BigInt(UNITS_PER_CENT)), l.players[cl.playerId]?.solanaAddress ?? "", sig);
        }
        continue;
      }
      const units = payoutUnits(mbr, party);
      const dest = l.players[cl.playerId]?.solanaAddress;
      if (!dest && units > BigInt(0)) {
        pending++;
        continue;
      }
      const seatToken = await ata(seat.publicKey);
      const ixs = [await withdrawIx(a, t.publicKey, seat.publicKey)];
      if (dest && units > BigInt(0)) {
        const owner = new PublicKey(dest);
        const destToken = await ata(owner);
        ixs.push(s.createAssociatedTokenAccountIdempotentInstruction(t.publicKey, destToken, owner, m));
        ixs.push(s.createTransferCheckedInstruction(seatToken, m, destToken, seat.publicKey, units, USDC_DECIMALS));
      }
      ixs.push(s.createCloseAccountInstruction(seatToken, t.publicKey, seat.publicKey));
      try {
        const sig = await sendTreasuryTx(ixs, [seat]);
        await paid(code, cl.playerId, Number(units / BigInt(UNITS_PER_CENT)), dest ?? "", sig);
      } catch (e) {
        if (e instanceof SolanaSendError && e.landed === null && e.signature) {
          await record(code, (_l, v) => {
            (v.inflight ??= {})[`pay:${cl.playerId}`] = e.signature!;
          });
        }
        throw e;
      }
    }
    // The house seat (top-up, claim 0) withdraws nothing, but has to be marked withdrawn before the final sweep.
    const house = await readMember(c, a, t.publicKey);
    if (house && !house.withdrawn) {
      const sig = await sendTreasuryTx([await withdrawIx(a, t.publicKey, t.publicKey)]);
      await record(code, (_lobby, v, now) => {
        v.payouts.house = { ...tx(sig, now), cents: Number(payoutUnits(house, party!) / BigInt(UNITS_PER_CENT)), to: t.publicKey.toBase58() };
      });
    }
    party = (await readParty(c, a))!;
    const vaultBal = BigInt((await c.getTokenAccountBalance(a.vault, "confirmed")).value.amount);
    const allOut = party.withdrawnCount === party.memberCount;
    if (vaultBal > BigInt(0) && ((party.hostRefund > BigInt(0) && !party.hostRefundPaid) || allOut)) {
      const p = await programs();
      const hostToken = await ata(a.host);
      const sig = await sendTreasuryTx([await ix(a, "withdraw_host", [
        [t.publicKey, true, true], [a.party, false, true], [a.host, false, false], [m, false, false], [a.vault, false, true],
        [hostToken, false, true], [p.token, false, false], [p.ata, false, false], [p.system, false, false],
      ])]);
      await record(code, (lobby, v, now) => {
        const cents = Number(vaultBal / BigInt(UNITS_PER_CENT));
        v.hostPayout = { ...tx(sig, now), cents: (v.hostPayout?.cents ?? 0) + cents };
        event(lobby, "host", sig, now, { cents });
      });
    }
    if (!pending) {
      await mutate(code, (lobby) => {
        if (lobby.vault) lobby.vault.status = "settled";
      });
    }
  }
}

/** Records a member payout: the player's balance leaves the game, a sent withdrawal with the signature. */
async function paid(code: string, playerId: string, cents: number, to: string, sig: string): Promise<void> {
  await record(code, (l, v, now) => {
    if (v.payouts[playerId]) return;
    v.payouts[playerId] = { ...tx(sig, now), cents, to };
    if (v.inflight) delete v.inflight[`pay:${playerId}`];
    const p = l.players[playerId];
    if (p) {
      p.withdrawn += cents;
      p.balance = 0;
    }
    l.withdrawals.push({ playerId, cents, at: now, to, txHash: sig, status: "sent" });
    event(l, "withdraw", sig, now, { playerId, cents });
  });
}

export interface AdvanceResult {
  /** False when another run holds the lock (it will do the work). */
  ran: boolean;
  vault: LobbyVault | null;
  error?: string;
}

/**
 * Does whatever the vault needs next for this lobby: create the party, sweep credited deposits into the vault,
 * and once the session has ended: top up, close, submit the signed balances, finalize and pay out.
 * Safe to call any time and from anywhere (a KV lock lets one run at a time; every step re-reads the chain).
 */
export async function advanceVault(code: string, opts: { waitMs?: number } = {}): Promise<AdvanceResult> {
  code = normCode(code);
  if (!isVault()) return { ran: false, vault: null };
  const key = `vaultlock:${code}`;
  const tok = randomBytes(8).toString("hex");
  // `waitMs`: wait for a run already in progress to finish, then run again (it re-reads everything).
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!(await kvSet(key, tok, { nx: true, px: 90_000 }))) {
    if (Date.now() >= deadline) return { ran: false, vault: (await getLobby(code))?.vault ?? null };
    await new Promise((r) => setTimeout(r, 400));
  }
  try {
    const l = await getLobby(code);
    if (!l) return { ran: true, vault: null };
    const due = sweepsDue(l);
    const ended = l.phase === "ended";
    if (l.vault?.status === "settled" || (!due.length && !(ended && l.vault))) return { ran: true, vault: l.vault ?? null };
    const c = await connection();
    const a = await accountsFor(l);
    await ensureParty(code, l, c, a);
    for (const [ref, d] of due) await sweep(code, a, ref, d, l.vault?.sweeps[ref]);
    if (ended) {
      const fresh = (await getLobby(code))!;
      if (!sweepsDue(fresh).length) await settle(code, c, a);
    }
    const done = await mutate(code, (lobby, now) => {
      if (lobby.vault) {
        lobby.vault.error = null;
        lobby.vault.lastTryAt = now;
      }
    });
    return { ran: true, vault: done.vault ?? null };
  } catch (e) {
    console.error("[vault]", errText(e));
    const l = await mutate(code, (lobby, now) => {
      if (lobby.vault) {
        lobby.vault.error = errText(e);
        lobby.vault.lastTryAt = now;
      }
    }).catch(() => null);
    return { ran: true, vault: l?.vault ?? null, error: errText(e) };
  } finally {
    if ((await kvGet(key)) === tok) await kvDel(key);
  }
}

/** Should a read of this lobby nudge the vault (credited deposits not swept yet, or an ended game not settled)? */
export function vaultNeedsWork(l: Lobby): boolean {
  if (!isVault()) return false;
  if (l.vault?.status === "settled") return false;
  return sweepsDue(l).length > 0 || (l.phase === "ended" && !!l.vault);
}

/**
 * Runs advanceVault after the response is sent (Next's `after`, which Vercel keeps alive), at most once per 5 s
 * per lobby. Outside a request (tests, scripts) it just runs in the background.
 */
export async function kickVault(code: string): Promise<void> {
  if (!isVault()) return;
  if (!(await kvSet(`vaultkick:${normCode(code)}`, "1", { nx: true, px: 5000 }))) return;
  const run = () => advanceVault(code).then(() => undefined, () => undefined);
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    void run();
  }
}

// ---------------------------------------------------------------- readiness (/api/health)

export interface VaultReadiness {
  requested: boolean;
  active: boolean;
  programId: string;
  deployed: boolean | null;
  executable: boolean | null;
  boxSigner: string | null;
  explorer: string;
  problems: string[];
  nextSteps: string[];
}

let vaultCache: { at: number; value: VaultReadiness } | null = null;

export async function vaultReadiness(force = false): Promise<VaultReadiness> {
  const now = Date.now();
  if (!force && vaultCache && now - vaultCache.at < 15_000) return vaultCache.value;
  const programId = vaultProgramId();
  const r: VaultReadiness = { requested: vaultRequested(), active: isVault(), programId, deployed: null, executable: null, boxSigner: null, explorer: explorerAddress(programId), problems: [], nextSteps: [] };
  if (r.requested && MONEY_MODE !== "solana") r.problems.push("SETTLEMENT=vault needs MONEY_MODE=solana running (see solana.problems)");
  if (MONEY_MODE === "solana") {
    try {
      const { PublicKey } = await web3();
      r.boxSigner = (await boxSigner()).publicKey.toBase58();
      const acct = await Promise.race([
        (await connection()).getAccountInfo(new PublicKey(programId), "confirmed"),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("RPC timed out after 5000 ms")), 5000)),
      ]);
      r.deployed = !!acct;
      r.executable = !!acct?.executable;
      if (r.requested && !r.executable) {
        r.problems.push(`The huddle_vault program ${programId} is not deployed on this cluster`);
        r.nextSteps.push("Fund the treasury at https://faucet.solana.com, then run `node scripts/solana-go-live.mjs` in web/");
      }
    } catch (e) {
      r.problems.push(`Could not check the vault program: ${errText(e)}`);
    }
  }
  if (!r.requested) r.nextSteps.push("Set SETTLEMENT=vault (and MONEY_MODE=solana) to settle parties through the huddle_vault program");
  vaultCache = { at: now, value: r };
  return r;
}
