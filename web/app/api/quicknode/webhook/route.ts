// POST /api/quicknode/webhook  <- a QuickNode Stream (Solana devnet, dataset Block, filter web/quicknode/filter.js)
// Auth: header `x-huddle-token: <QUICKNODE_STREAM_TOKEN>` (a custom header on the Stream's webhook destination), or
// QuickNode's X-QN-Nonce / X-QN-Timestamp / X-QN-Signature HMAC with QUICKNODE_STREAM_TOKEN as the security token.
// Body: the filter's records (bare array, or {data, metadata}); gzip is fine. See lib/quicknode.ts.
// Credits Solana Pay deposits at once by reference (re-read from our RPC, once per signature, same path as
// /deposit/sync) and marks vault steps as streamed. -> 200 {"ok":true,"records","credited","deposits","vaultEvents"}
// 401 bad auth, 503 not configured, 400 unreadable body. Polling /deposit/sync stays the fallback.
import { gunzipSync } from "zlib";
import { json } from "@/lib/http";
import { authProblem, handleStream, streamToken } from "@/lib/quicknode";
import { MONEY_MODE } from "@/lib/money";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  // QUICKNODE_STREAM_TOKEN: the Stream's token. QUICKNODE_WEBHOOK_TOKEN: the security token of a QuickNode Webhook
  // ("Solana Wallet Activity Monitor" on the treasury's USDC account), which signs its deliveries the same way.
  const tokens = [streamToken(), (process.env.QUICKNODE_WEBHOOK_TOKEN || "").trim()].filter(Boolean);
  if (!tokens.length) return json({ error: "QuickNode webhook is not configured (QUICKNODE_STREAM_TOKEN)" }, 503);
  let raw: string;
  try {
    const buf = Buffer.from(await req.arrayBuffer());
    raw = /gzip/i.test(req.headers.get("content-encoding") || "") || (buf[0] === 0x1f && buf[1] === 0x8b) ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  } catch {
    return json({ error: "Unreadable body" }, 400);
  }
  const problems = tokens.map((t) => authProblem(req.headers, raw, t));
  const why = problems.includes(null) ? null : problems[problems.length - 1];
  if (why) return json({ error: `Unauthorized: ${why}` }, 401);
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return json({ error: "Body is not JSON" }, 400);
  }
  if (MONEY_MODE !== "solana") return json({ ok: true, records: 0, credited: 0, deposits: [], vaultEvents: 0, note: "MONEY_MODE is not solana" });
  try {
    return json({ ok: true, ...(await handleStream(body)) });
  } catch (e) {
    // A 5xx makes QuickNode retry the batch, which is safe: crediting is once per signature.
    console.error("[quicknode]", e instanceof Error ? e.message : e);
    return json({ error: "Could not process the batch, retry" }, 500);
  }
}
