// Gemini Prediction Markets: public, key-less reads (ported from Huddle packages/gemini/src).
//   GET https://api.gemini.com/v1/prediction-markets/events?status=active&category=sports&search=<ticker base>&limit=50
//   GET https://api.gemini.com/v1/prediction-markets/events/{eventTicker}
// Lists come wrapped as { data: [...] }, a single event comes bare. Prices are strings in 0..1.
// Mid-price rule: mid = (bestBid + bestAsk) / 2; if the spread is wider than 0.10 or a side is missing,
// use lastTradePrice; if that is missing too, the contract has no price (never a misleading number).
//
// Server only. Each fetch has a 3 s timeout; results (including failures) are cached 30 s in the store,
// so a slow or down Gemini never holds up a lobby.
import { kvGet, kvSet } from "./store";
import type { GeminiEventQuote, GeminiHint } from "./replay/types";

export const GEMINI_API_BASE = (process.env.GEMINI_API_BASE || "https://api.gemini.com").replace(/\/$/, "");
export const GEMINI_TIMEOUT_MS = 3000;
export const GEMINI_CACHE_MS = 30_000;
export const MAX_SPREAD = 0.1;
export const GEMINI_WEB = "https://www.gemini.com/predictions";

export interface GeminiContract {
  ticker: string; // short contract code inside the event: "DAL", "D", "O53"
  label: string;
  prob: number | null;
  source: "mid" | "last" | "unavailable";
}

export interface GeminiEvent {
  ticker: string; // e.g. NFL-2611221800-TEN-DAL-M
  title: string;
  kind: GeminiEventQuote["kind"];
  period?: string;
  url?: string;
  contracts: GeminiContract[];
}

export interface GeminiSnapshot {
  /** Wall ms when fetched (or when the bundled snapshot was taken). */
  at: number;
  asOf: string;
  live: boolean;
  ok: boolean;
  error?: string;
  events: GeminiEvent[];
}

/** What a game config says about Gemini. */
export interface GeminiGameConfig {
  /** Ticker base shared by the game's markets, e.g. "NFL-2611221800-TEN-DAL". */
  event: string;
  home?: string; // team code in Gemini contracts, e.g. "DAL"
  away?: string;
  /** Last prices seen, used only when the live API is unreachable (shown with its real asOf time). */
  snapshot?: { asOf: string; events: { ticker: string; title?: string; contracts: { ticker: string; label: string; bestBid?: string; bestAsk?: string; lastTradePrice?: string }[] }[] };
}

/** The `market.gemini` field of the public view. */
export interface GeminiRef {
  prob: number;
  label: string;
  asOf: string;
  url?: string;
  live: boolean;
  eventTicker: string;
  contract: string;
}

// ---------------------------------------------------------------- pure parsing

export function parsePrice(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export function quoteFromPrices(prices: { bestBid?: unknown; bestAsk?: unknown; lastTradePrice?: unknown } | null | undefined): { prob: number | null; source: GeminiContract["source"] } {
  const bid = parsePrice(prices?.bestBid);
  const ask = parsePrice(prices?.bestAsk);
  const last = parsePrice(prices?.lastTradePrice);
  if (bid !== undefined && ask !== undefined) {
    const spread = ask - bid;
    if (spread >= -1e-9 && spread <= MAX_SPREAD + 1e-9) return { prob: Math.round(((bid + ask) / 2) * 1e4) / 1e4, source: "mid" };
  }
  if (last !== undefined) return { prob: last, source: "last" };
  return { prob: null, source: "unavailable" };
}

interface RawContract {
  ticker?: string;
  label?: string;
  instrumentSymbol?: string;
  prices?: { bestBid?: unknown; bestAsk?: unknown; lastTradePrice?: unknown } | null;
}
interface RawEvent {
  ticker?: string;
  title?: string;
  slug?: string;
  sportsMarket?: { type?: string; subject?: string; scope?: { type?: string; ordinal?: number } };
  contracts?: RawContract[];
}

export function unwrapEvents(payload: unknown): RawEvent[] {
  const isEvent = (v: unknown): v is RawEvent => !!v && typeof v === "object" && typeof (v as RawEvent).ticker === "string";
  if (Array.isArray(payload)) return payload.filter(isEvent);
  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data.filter(isEvent);
    if (isEvent(data)) return [data];
    if (isEvent(payload)) return [payload];
  }
  return [];
}

/** Market kind from sportsMarket when present, else the ticker suffix (-M, -1QM, -T, -S). */
export function classify(ev: RawEvent): { kind: GeminiEventQuote["kind"]; period?: string } {
  const sm = ev.sportsMarket;
  const scope = sm?.scope?.type;
  const period = (scope === "quarter" || scope === "half") && sm?.scope?.ordinal ? `${sm.scope.ordinal}${scope === "quarter" ? "Q" : "H"}` : undefined;
  if (sm?.type) {
    if (sm.type === "moneyline") return period ? { kind: "period_winner", period } : { kind: "moneyline" };
    if (sm.type === "total") return sm.subject && sm.subject !== "contest" ? { kind: "other" } : period ? { kind: "total", period } : { kind: "total" };
    if (sm.type === "spread") return { kind: "spread", period };
    return { kind: "other" };
  }
  const suffix = (ev.ticker ?? "").split("-").pop() ?? "";
  const m = /^(\d)(Q|H)(M|T|S)$/.exec(suffix);
  if (m) {
    const p = `${m[1]}${m[2]}`;
    return m[3] === "M" ? { kind: "period_winner", period: p } : m[3] === "T" ? { kind: "total", period: p } : { kind: "spread", period: p };
  }
  if (suffix === "M") return { kind: "moneyline" };
  if (suffix === "T") return { kind: "total" };
  if (suffix === "S") return { kind: "spread" };
  return { kind: "other" };
}

export function toEvent(ev: RawEvent): GeminiEvent {
  const { kind, period } = classify(ev);
  const ticker = ev.ticker ?? "";
  return {
    ticker,
    title: ev.title ?? ticker,
    kind,
    period,
    url: ticker ? (ev.slug ? `${GEMINI_WEB}/${ticker}/${ev.slug}` : `${GEMINI_WEB}/${ticker}`) : undefined,
    contracts: (ev.contracts ?? []).map((c) => {
      const q = quoteFromPrices(c.prices);
      return { ticker: c.ticker ?? (c.instrumentSymbol ?? "").split("-").pop() ?? "", label: c.label ?? c.ticker ?? "", prob: q.prob, source: q.source };
    }),
  };
}

/** "More than 53.5 points scored" -> 53.5 */
export function contractLine(label: string): number | undefined {
  const m = /more than\s+(\d+(?:\.\d+)?)/i.exec(label);
  return m ? Number(m[1]) : undefined;
}

/** Engine calibration input. */
export function toEngineQuotes(s: GeminiSnapshot | null): GeminiEventQuote[] {
  if (!s) return [];
  return s.events.map((e) => ({
    eventTicker: e.ticker,
    kind: e.kind,
    period: e.period,
    contracts: e.contracts.map((c) => ({ contractTicker: c.ticker, label: c.label, prob: c.prob })),
  }));
}

/**
 * Gemini's probability for the YES side of one of our questions, when comparable:
 *  - moneyline / period_winner: the contract for team `yesTeam` (a Gemini team code like "DAL")
 *  - total: the "More than <line>" contract with exactly our line
 */
export function refForHint(s: GeminiSnapshot | null, hint: GeminiHint | undefined, yesTeam?: string): GeminiRef | null {
  if (!s || !hint || !s.events.length) return null;
  const ev =
    hint.kind === "moneyline"
      ? s.events.find((e) => e.kind === "moneyline" && !e.period)
      : hint.kind === "period_winner"
        ? s.events.find((e) => e.kind === "period_winner" && !!hint.period && e.period?.toUpperCase() === hint.period.toUpperCase())
        : s.events.find((e) => e.kind === "total" && (hint.period ? e.period?.toUpperCase() === hint.period.toUpperCase() : !e.period));
  if (!ev) return null;
  const c =
    hint.kind === "total"
      ? ev.contracts.find((x) => x.prob !== null && hint.line !== undefined && contractLine(x.label) === hint.line)
      : ev.contracts.find((x) => x.prob !== null && !!yesTeam && x.ticker.toUpperCase() === yesTeam.toUpperCase());
  if (!c || c.prob === null) return null;
  return { prob: c.prob, label: c.label, asOf: s.asOf, url: ev.url, live: s.live, eventTicker: ev.ticker, contract: c.ticker };
}

/** Direct mapping from a clip question's config: { event: "NFL-...-M", contract: "DAL" }. */
export function refForContract(s: GeminiSnapshot | null, eventTicker: string, contract: string): GeminiRef | null {
  const ev = s?.events.find((e) => e.ticker === eventTicker);
  const c = ev?.contracts.find((x) => x.ticker.toUpperCase() === contract.toUpperCase());
  if (!s || !ev || !c || c.prob === null) return null;
  return { prob: c.prob, label: c.label, asOf: s.asOf, url: ev.url, live: s.live, eventTicker: ev.ticker, contract: c.ticker };
}

// ---------------------------------------------------------------- fetching

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" }, cache: "no-store" });
    if (!r.ok) throw new Error(`Gemini HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`Gemini timed out after ${timeoutMs} ms`);
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}

/** All of a game's markets in one search by ticker base, falling back to the moneyline and total by ticker. */
export async function fetchGameEvents(base: string, opts: { fetch?: FetchLike; timeoutMs?: number; apiBase?: string } = {}): Promise<GeminiEvent[]> {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const t = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const api = opts.apiBase ?? GEMINI_API_BASE;
  const q = new URLSearchParams({ status: "active", category: "sports", search: base, limit: "50" });
  let raw: RawEvent[] = [];
  try {
    raw = unwrapEvents(await getJson(`${api}/v1/prediction-markets/events?${q}`, f, t)).filter((e) => (e.ticker ?? "").startsWith(base));
  } catch {
    raw = [];
  }
  if (!raw.length) {
    const got = await Promise.allSettled([`${base}-M`, `${base}-T`].map((tk) => getJson(`${api}/v1/prediction-markets/events/${encodeURIComponent(tk)}`, f, t)));
    for (const g of got) if (g.status === "fulfilled") raw.push(...unwrapEvents(g.value));
    if (!raw.length) {
      const err = got.find((g) => g.status === "rejected") as PromiseRejectedResult | undefined;
      throw err?.reason instanceof Error ? err.reason : new Error("Gemini lists no markets for this game");
    }
  }
  return raw.map(toEvent).filter((e) => e.kind !== "other" && e.contracts.length > 0);
}

function snapshotFromConfig(cfg: GeminiGameConfig, error: string): GeminiSnapshot | null {
  if (!cfg.snapshot) return null;
  const events = cfg.snapshot.events.map((e) => toEvent({ ticker: e.ticker, title: e.title, contracts: e.contracts.map((c) => ({ ticker: c.ticker, label: c.label, prices: c })) }));
  const at = Date.parse(cfg.snapshot.asOf);
  return { at: Number.isNaN(at) ? 0 : at, asOf: cfg.snapshot.asOf, live: false, ok: true, error, events };
}

const cacheKey = (base: string) => `gemini:${base}`;

/**
 * Cached Gemini quotes for a game (30 s, failures included). Never throws: when the API is unreachable it
 * returns the config's last-seen snapshot (live=false, real asOf) or null.
 */
export async function geminiForGame(cfg: GeminiGameConfig | undefined, now = Date.now(), opts: { fetch?: FetchLike } = {}): Promise<GeminiSnapshot | null> {
  if (!cfg?.event || process.env.GEMINI_DISABLED === "1") return null;
  const key = cacheKey(cfg.event);
  try {
    const hit = await kvGet(key);
    if (hit) {
      const c = JSON.parse(hit) as { fetchedAt: number; snap: GeminiSnapshot | null };
      if (now - c.fetchedAt < GEMINI_CACHE_MS) return c.snap;
    }
  } catch {
    /* cache miss */
  }
  // One refresher at a time per game; others use what is cached (or the snapshot).
  const gate = await kvSet(`${key}:refresh`, "1", { px: GEMINI_TIMEOUT_MS * 2 + 1000, nx: true }).catch(() => false);
  if (!gate) {
    const hit = await kvGet(key).catch(() => null);
    return hit ? (JSON.parse(hit) as { snap: GeminiSnapshot | null }).snap : snapshotFromConfig(cfg, "refreshing");
  }
  let snap: GeminiSnapshot | null;
  try {
    const events = await fetchGameEvents(cfg.event, opts);
    snap = { at: now, asOf: new Date(now).toISOString(), live: true, ok: true, events };
  } catch (e) {
    snap = snapshotFromConfig(cfg, e instanceof Error ? e.message : String(e));
  }
  await kvSet(key, JSON.stringify({ fetchedAt: now, snap }), { px: 10 * 60_000 }).catch(() => undefined);
  return snap;
}
