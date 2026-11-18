// Money in and out.
//
// MONEY_MODE=demo (default)  "Add $5 test money" buttons credit instantly. Cash out just zeroes the balance.
// MONEY_MODE=coinbase        Deposits go through Coinbase Onramp: the phone opens a Coinbase-hosted page,
//                            the player buys/sends USDC on Base to the TREASURY wallet, and we credit
//                            their balance once Coinbase's Transaction Status API reports SUCCESS.
//   COINBASE_SANDBOX=true    (default) partnerUserRef gets the "sandbox-" prefix: Coinbase test flow, no real charge.
//   COINBASE_SANDBOX=false   Real money. Only use this where it is legal for you (see README: real money).
//   PAYOUTS=onchain          Cash out sends real USDC on Base from the CDP server wallet to the player's address.
//                            Requires CDP_WALLET_SECRET and a little ETH on Base in the treasury for gas.
//
// Credentials come from env vars only (never commit them):
//   CDP_API_KEY_ID, CDP_API_KEY_SECRET   CDP "Secret API key" (portal.cdp.coinbase.com > API Keys)
//   CDP_WALLET_SECRET                    only for PAYOUTS=onchain (or to auto-create the treasury wallet)
//   TREASURY_ADDRESS                     optional 0x address that receives deposits; defaults to the CDP wallet

//
// MONEY_MODE=solana          Test USDC on Solana devnet through Solana Pay (see lib/solana.ts): deposits are
//                            transfer-request links/QRs to the treasury, credited once per signature;
//                            cash-out sends USDC from the treasury. Needs SOLANA_TREASURY_SECRET_KEY and
//                            USDC_MINT (SOLANA_RPC_URL defaults to devnet). Missing env -> demo money, and
//                            /api/health says why.

import { solanaProblems } from "./solana";

const env = (k: string) => (process.env[k] || "").trim();

/** What MONEY_MODE asked for; MONEY_MODE below is what actually runs (solana falls back to demo when not configured). */
export const REQUESTED_MONEY_MODE = env("MONEY_MODE") || "demo";
const SOLANA_FALLBACK = REQUESTED_MONEY_MODE === "solana" ? solanaProblems() : [];
export const MONEY_MODE: "demo" | "coinbase" | "solana" =
  REQUESTED_MONEY_MODE === "coinbase" ? "coinbase" : REQUESTED_MONEY_MODE === "solana" && SOLANA_FALLBACK.length === 0 ? "solana" : "demo";
export const SANDBOX = env("COINBASE_SANDBOX").toLowerCase() !== "false";
export const PAYOUTS: "off" | "onchain" = env("PAYOUTS") === "onchain" ? "onchain" : "off";
const ONRAMP_API: "v2" | "v1" = env("COINBASE_ONRAMP_API") === "v1" ? "v1" : "v2";
const TREASURY_ACCOUNT_NAME = env("CDP_TREASURY_ACCOUNT_NAME") || "live-lines-treasury";
const NETWORK = "base";

export const DEPOSIT_OPTIONS = MONEY_MODE === "coinbase" || MONEY_MODE === "solana" ? [500, 1000, 2000] : [500, 1000];

export function moneyInfo() {
  const solana = MONEY_MODE === "solana";
  return {
    mode: MONEY_MODE,
    sandbox: MONEY_MODE === "coinbase" ? SANDBOX : true,
    realMoney: MONEY_MODE === "coinbase" && !SANDBOX,
    /** "solana": cash-out sends devnet USDC to a Solana address (or the wallet the player deposited from). */
    payouts: (solana ? "solana" : MONEY_MODE === "coinbase" && !SANDBOX && PAYOUTS === "onchain" ? "onchain" : "test") as "solana" | "onchain" | "test",
    depositOptions: DEPOSIT_OPTIONS,
    asset: solana ? "test USDC on Solana devnet" : "USDC on Base",
    /** Solana: deposits are Solana Pay links; a faucet gives test USDC. */
    solanaPay: solana,
    faucet: solana,
  };
}

export function moneyProblems(): string[] {
  const out: string[] = [];
  if (REQUESTED_MONEY_MODE === "solana" && SOLANA_FALLBACK.length) {
    out.push(`MONEY_MODE=solana is not configured (${SOLANA_FALLBACK.join("; ")}): running demo money instead`);
  }
  if (MONEY_MODE !== "coinbase") return out;
  if (!env("CDP_API_KEY_ID") || !env("CDP_API_KEY_SECRET")) out.push("MONEY_MODE=coinbase needs CDP_API_KEY_ID and CDP_API_KEY_SECRET");
  if (!env("TREASURY_ADDRESS") && !env("CDP_WALLET_SECRET")) out.push("Set TREASURY_ADDRESS, or CDP_WALLET_SECRET so the server wallet can be created");
  if (PAYOUTS === "onchain" && !env("CDP_WALLET_SECRET")) out.push("PAYOUTS=onchain needs CDP_WALLET_SECRET");
  return out;
}

// ---------------------------------------------------------------- CDP helpers

async function cdpJwt(method: string, host: string, path: string): Promise<string> {
  const { generateJwt } = await import("@coinbase/cdp-sdk/auth");
  return generateJwt({
    apiKeyId: env("CDP_API_KEY_ID"),
    apiKeySecret: env("CDP_API_KEY_SECRET").replace(/\\n/g, "\n"),
    requestMethod: method,
    requestHost: host,
    requestPath: path,
    expiresIn: 120,
  });
}

async function cdpFetch(method: "GET" | "POST", host: string, path: string, query = "", body?: unknown) {
  const jwt = await cdpJwt(method, host, path);
  const r = await fetch(`https://${host}${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new Error(`Coinbase ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return json as Record<string, unknown>;
}

type TreasuryAccount = {
  address: string;
  transfer: (o: { to: `0x${string}`; amount: bigint; token: "usdc"; network: "base" }) => Promise<{ transactionHash: string }>;
};
let treasuryPromise: Promise<TreasuryAccount> | null = null;

/** The CDP server wallet (EVM account) that receives deposits and pays out cash-outs. */
async function treasuryAccount(): Promise<TreasuryAccount> {
  if (!treasuryPromise) {
    treasuryPromise = (async () => {
      const { CdpClient } = await import("@coinbase/cdp-sdk");
      const cdp = new CdpClient({
        apiKeyId: env("CDP_API_KEY_ID"),
        apiKeySecret: env("CDP_API_KEY_SECRET").replace(/\\n/g, "\n"),
        walletSecret: env("CDP_WALLET_SECRET"),
      });
      return (await cdp.evm.getOrCreateAccount({ name: TREASURY_ACCOUNT_NAME })) as unknown as TreasuryAccount;
    })().catch((e) => {
      treasuryPromise = null;
      throw e;
    });
  }
  return treasuryPromise;
}

export async function treasuryAddress(): Promise<string> {
  if (env("TREASURY_ADDRESS")) return env("TREASURY_ADDRESS");
  return (await treasuryAccount()).address;
}

/** Coinbase links every Onramp transaction to this ref; we later look the player's deposits up by it. Under 50 chars. */
export function partnerUserRef(code: string, playerId: string): string {
  return `${SANDBOX ? "sandbox-" : ""}ll-${code}-${playerId}`;
}

// ---------------------------------------------------------------- deposits

export async function createOnrampUrl(opts: {
  code: string;
  playerId: string;
  cents: number;
  clientIp: string | null;
  redirectUrl: string;
}): Promise<string> {
  const address = await treasuryAddress();
  const ref = partnerUserRef(opts.code, opts.playerId);
  const dollars = (opts.cents / 100).toFixed(2);

  if (ONRAMP_API === "v2") {
    // POST https://api.cdp.coinbase.com/platform/v2/onramp/sessions -> { session: { onrampUrl } }
    const body: Record<string, unknown> = {
      destinationAddress: address,
      purchaseCurrency: "USDC",
      destinationNetwork: NETWORK,
      paymentAmount: dollars,
      paymentCurrency: "USD",
      redirectUrl: opts.redirectUrl,
      partnerUserRef: ref,
    };
    if (opts.clientIp) body.clientIp = opts.clientIp;
    const j = await cdpFetch("POST", "api.cdp.coinbase.com", "/platform/v2/onramp/sessions", "", body);
    const url = (j.session as { onrampUrl?: string } | undefined)?.onrampUrl;
    if (!url) throw new Error("Coinbase did not return an onramp URL");
    return url;
  }

  // v1: POST https://api.developer.coinbase.com/onramp/v1/token -> { token }, then build the hosted URL.
  const body: Record<string, unknown> = { addresses: [{ address, blockchains: [NETWORK] }], assets: ["USDC"] };
  if (opts.clientIp) body.clientIp = opts.clientIp;
  const j = await cdpFetch("POST", "api.developer.coinbase.com", "/onramp/v1/token", "", body);
  const token = j.token as string | undefined;
  if (!token) throw new Error("Coinbase did not return a session token");
  const q = new URLSearchParams({
    sessionToken: token,
    defaultAsset: "USDC",
    defaultNetwork: NETWORK,
    presetFiatAmount: dollars,
    fiatCurrency: "USD",
    partnerUserRef: ref,
    redirectUrl: opts.redirectUrl,
  });
  return `https://pay.coinbase.com/buy/select-asset?${q}`;
}

export interface OnrampTx {
  id: string;
  status: string;
  cents: number;
  currency: string;
  network: string;
  wallet: string;
}

function amountOf(v: unknown): { value: number; currency: string } {
  if (v && typeof v === "object") {
    const o = v as { value?: string | number; currency?: string };
    return { value: Number(o.value ?? 0), currency: String(o.currency ?? "") };
  }
  return { value: Number(v ?? 0), currency: "" };
}

/**
 * Looks up this player's Coinbase Onramp transactions (Transaction Status API).
 * `completed`: successful ones that landed in our treasury as USDC on Base. `pending`: still in flight.
 */
export async function fetchDeposits(code: string, playerId: string): Promise<{ completed: OnrampTx[]; pending: number }> {
  const ref = partnerUserRef(code, playerId);
  const path = `/onramp/v1/buy/user/${encodeURIComponent(ref)}/transactions`;
  const j = await cdpFetch("GET", "api.developer.coinbase.com", path, "?pageSize=25");
  const txs = (j.transactions as Record<string, unknown>[] | undefined) ?? [];
  const treasury = (await treasuryAddress()).toLowerCase();
  const out: OnrampTx[] = [];
  let pending = 0;
  for (const t of txs) {
    const status = String(t.status ?? "");
    if (/CREATED|IN_PROGRESS/.test(status)) pending++;
    if (status !== "ONRAMP_TRANSACTION_STATUS_SUCCESS") continue;
    const amt = amountOf(t.purchase_amount);
    const currency = String(t.purchase_currency ?? amt.currency ?? "").toUpperCase();
    const network = String(t.purchase_network ?? "").toLowerCase();
    const wallet = String(t.wallet_address ?? "").toLowerCase();
    if (currency && currency !== "USDC") continue;
    if (network && !network.includes("base")) continue;
    if (wallet && wallet !== treasury) continue;
    const id = String(t.transaction_id ?? t.tx_hash ?? "");
    if (!id) continue;
    out.push({ id, status, cents: Math.floor(amt.value * 100 + 1e-6), currency, network, wallet });
  }
  return { completed: out, pending };
}

// ---------------------------------------------------------------- payouts

export function isEvmAddress(a: string): a is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Sends real USDC on Base from the treasury. Only called when moneyInfo().payouts === "onchain". */
export async function sendUsdc(to: `0x${string}`, cents: number): Promise<string> {
  const account = await treasuryAccount();
  const amount = BigInt(cents) * BigInt(10000); // USDC has 6 decimals: 1 cent = 10,000 units
  const { transactionHash } = await account.transfer({ to, amount, token: "usdc", network: "base" });
  return transactionHash;
}
