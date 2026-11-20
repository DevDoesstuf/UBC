// QuickNode Streams -> Huddle. Server only.
//
// The Stream (Solana devnet, dataset Block, filter web/quicknode/filter.js) POSTs the filter's records to
// /api/quicknode/webhook. Authentication, either of:
//   - a custom header on the webhook destination: `x-huddle-token: <QUICKNODE_STREAM_TOKEN>` (or
//     `Authorization: Bearer <token>`), or
//   - QuickNode's own signature: X-QN-Signature = hex(HMAC-SHA256(security token, X-QN-Nonce + X-QN-Timestamp + body)),
//     when QUICKNODE_STREAM_TOKEN is set to the Stream's security token. The timestamp must be within 10 minutes.
// Anything else is a 401; without QUICKNODE_STREAM_TOKEN the route is closed (503).
//
// What a record does:
//   - any account key that is an open Solana Pay reference (global index solref:<key>) -> the transaction is re-read
//     from our own RPC, and if it paid the treasury it is credited through the same once-per-signature path as
//     /deposit/sync (lib/solana-lobby.ts creditPayments). The payload's own numbers are never trusted.
//   - huddle_vault instructions -> the lobby that owns that party PDA records the step as streamed (TV / box).
import { createHmac, timingSafeEqual } from "crypto";
import { markStreamed } from "./chain";
import { getLobby, mutate } from "./lobby";
import { lobbyMoneyMode } from "./money";
import { paymentBySignature } from "./solana";
import { creditPayments, lookupRef } from "./solana-lobby";
import { kvGet } from "./store";
import { partyKey } from "./vault";

const env = (k: string) => (process.env[k] || "").trim();
export const streamToken = () => env("QUICKNODE_STREAM_TOKEN");
const MAX_SKEW_MS = 10 * 60 * 1000;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** null when the request is authentic, else why not. `rawBody` is the decompressed body text. */
export function authProblem(headers: Headers, rawBody: string, token = streamToken(), now = Date.now()): string | null {
  if (!token) return "QUICKNODE_STREAM_TOKEN is not set";
  const direct = headers.get("x-huddle-token") || headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (direct) return same(direct, token) ? null : "wrong token";
  const sig = headers.get("x-qn-signature") || "";
  const nonce = headers.get("x-qn-nonce") || "";
  const ts = headers.get("x-qn-timestamp") || "";
  if (!sig || !nonce || !ts) return "missing token or X-QN-Signature";
  const t = Number(ts);
  const ms = t < 1e12 ? t * 1000 : t; // seconds (what QuickNode sends) or milliseconds
  if (!Number.isFinite(ms) || Math.abs(now - ms) > MAX_SKEW_MS) return "stale X-QN-Timestamp";
  const want = createHmac("sha256", token).update(nonce + ts + rawBody).digest("hex");
  return same(sig.toLowerCase(), want) ? null : "bad X-QN-Signature";
}

export interface StreamRecord {
  signature: string;
  slot?: number | null;
  blockTime?: number | null;
  accounts: string[];
  watched?: string[];
  huddle?: { instruction: string; party: string | null; member?: string | null; amount?: number }[];
}

/** The filter's records from a delivery body: a bare array, nested arrays, or {data: [...], metadata}. */
export function recordsOf(body: unknown, out: StreamRecord[] = [], depth = 0): StreamRecord[] {
  if (!body || depth > 4) return out;
  if (Array.isArray(body)) {
    for (const x of body) recordsOf(x, out, depth + 1);
    return out;
  }
  if (typeof body !== "object") return out;
  const o = body as Record<string, unknown>;
  if (typeof o.signature === "string" && Array.isArray(o.accounts)) {
    out.push({
      signature: o.signature,
      slot: typeof o.slot === "number" ? o.slot : null,
      blockTime: typeof o.blockTime === "number" ? o.blockTime : null,
      accounts: o.accounts.filter((k): k is string => typeof k === "string").slice(0, 64),
      watched: Array.isArray(o.watched) ? o.watched.filter((k): k is string => typeof k === "string") : [],
      huddle: Array.isArray(o.huddle) ? (o.huddle as StreamRecord["huddle"]) : [],
    });
    return out;
  }
  // QuickNode Webhooks ("Solana Wallet Activity Monitor" template): [{block: {slot, blockTime}, transactions: [{raw:
  // {meta, transaction: {signatures, message: {accountKeys}}}}]}]. Same record: the signature and every account key.
  if (Array.isArray(o.transactions)) {
    const block = (o.block ?? {}) as Record<string, unknown>;
    for (const t of o.transactions as Record<string, unknown>[]) {
      const raw = ((t && (t.raw ?? t)) ?? {}) as Record<string, unknown>;
      const tx = (raw.transaction ?? {}) as Record<string, unknown>;
      const msg = (tx.message ?? {}) as Record<string, unknown>;
      const meta = (raw.meta ?? {}) as Record<string, unknown>;
      const sig = Array.isArray(tx.signatures) ? tx.signatures[0] : null;
      if (typeof sig !== "string" || meta.err) continue;
      const loaded = (meta.loadedAddresses ?? {}) as Record<string, unknown>;
      const keys = [
        ...(Array.isArray(msg.accountKeys) ? msg.accountKeys : []),
        ...(Array.isArray(loaded.writable) ? loaded.writable : []),
        ...(Array.isArray(loaded.readonly) ? loaded.readonly : []),
      ].map((k) => (typeof k === "string" ? k : k && typeof k === "object" ? (k as { pubkey?: unknown }).pubkey : null));
      out.push({
        signature: sig,
        slot: typeof block.slot === "number" ? block.slot : null,
        blockTime: typeof block.blockTime === "number" ? block.blockTime : null,
        accounts: keys.filter((k): k is string => typeof k === "string").slice(0, 64),
        watched: [],
        huddle: [],
      });
    }
    return out;
  }
  if ("data" in o) recordsOf(o.data, out, depth + 1);
  return out;
}

export interface WebhookResult {
  records: number;
  credited: number;
  deposits: { code: string; signature: string; cents: number }[];
  vaultEvents: number;
}

/** Handles one authenticated delivery. `rpc` and the addresses are for tests (default: the live chain). */
export async function handleStream(body: unknown, opts: Parameters<typeof paymentBySignature>[2] = {}): Promise<WebhookResult> {
  const recs = recordsOf(body).slice(0, 500);
  const res: WebhookResult = { records: recs.length, credited: 0, deposits: [], vaultEvents: 0 };
  for (const r of recs) {
    // 1. Solana Pay deposits: one of the account keys is an open reference.
    for (const key of new Set(r.accounts)) {
      const ref = await lookupRef(key);
      if (!ref) continue;
      // Only lobbies that play Solana money take on-chain deposits; a demo lobby ignores the delivery.
      if (lobbyMoneyMode(await getLobby(ref.code, { gemini: false })) !== "solana") continue;
      const pay = await paymentBySignature(r.signature, key, opts);
      if (!pay) continue;
      const c = await creditPayments(ref.code, ref.playerId, [{ ref: key, pays: [pay], paid: true }], "quicknode");
      res.credited += c.credited;
      if (c.credited) res.deposits.push({ code: ref.code, signature: r.signature, cents: c.credited });
      else await mutate(ref.code, (l) => void markStreamed(l, r.signature)).catch(() => null);
    }
    // 2. Vault steps: mark them as seen on the Stream in the lobby that owns the party.
    const parties = new Set((r.huddle ?? []).map((h) => h.party).filter((p): p is string => !!p));
    for (const party of parties) {
      const code = await kvGet(partyKey(party));
      if (!code) continue;
      await mutate(code, (l) => {
        if (markStreamed(l, r.signature)) res.vaultEvents++;
      }).catch(() => null);
    }
  }
  return res;
}
