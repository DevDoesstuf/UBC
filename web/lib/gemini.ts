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
import type { GeminiEventQuote, GeminiHint, ReplayGemini } from "./replay/types";

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

/**
 * Where a snapshot's prices come from:
 *  - live:     Gemini's API just now
 *  - snapshot: a stored copy (the API was unreachable, or the market has settled), with its real asOf
 *  - replay:   a replayed real game: Gemini's real price at this moment of that game (5 minute candles,
 *              captured by scripts/build-replays.mjs), asOf = the real time of the play on screen
 */
export type GeminiSource = "live" | "snapshot" | "replay";

export interface GeminiSnapshot {
  /** Wall ms when fetched (or when the bundled snapshot was taken). */
  at: number;
  asOf: string;
  live: boolean;
  ok: boolean;
  error?: string;
  events: GeminiEvent[];
  /** Missing on snapshots stored by older lobbies: read as "live" when live, else "snapshot". */
  source?: GeminiSource;
  /** One plain sentence for the UI, e.g. "Gemini settled this market on Nov 15; prices from before kickoff". */
  note?: string;
}

/** What a game config says about Gemini. */
export interface GeminiGameConfig {
  /** Ticker base shared by the game's markets, e.g. "NFL-2611221800-TEN-DAL". */
  event: string;
  home?: string; // team code in Gemini contracts, e.g. "DAL"
  away?: string;
  /** Last prices seen, used only when the live API is unreachable (shown with its real asOf time). */
  snapshot?: { asOf: string; events: { ticker: string; title?: string; slug?: string; contracts: { ticker: string; label: string; bestBid?: string; bestAsk?: string; lastTradePrice?: string }[] }[] };
  /** When Gemini settled the game's markets (real, finished games). After it, the API is not asked again. */
  settledAt?: string | null;
  /** Gemini web page for the game's moneyline. */
  url?: string;
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
  source?: GeminiSource;
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

/** A team as our screens name it, keyed by its Gemini contract code ("LAC" -> "Chargers"). */
export interface LabelTeam {
  code: string;
  name: string;
}

const PERIOD_WORD: Record<string, string> = { Q: "quarter", H: "half" };
function periodText(period: string | undefined): string | null {
  const m = /^(\d)([QH])$/i.exec(period ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return `${n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`} ${PERIOD_WORD[m[2].toUpperCase()]}`;
}

/**
 * Gemini names contracts by city, cut short where two teams share one ("Los Angeles C", "New York J"), and
 * adds rule words ("San Francisco wins 1st Quarter", "More than 56.5 points scored"). This is the label our
 * screens and the announcer use: the team as we call it ("Chargers to win the 1st quarter"), "Tie in the
 * 2nd half", "Over 56.5 points". The contract code decides the team; a label we cannot place is kept as is.
 */
export function friendlyLabel(ev: Pick<GeminiEvent, "kind" | "period">, c: { ticker: string; label: string }, teams: LabelTeam[] = []): string {
  const raw = String(c.label ?? "").replace(/\s+/g, " ").trim();
  const code = String(c.ticker ?? "").toUpperCase();
  if (ev.kind === "total") {
    const m = /^more than\s+(\d+(?:\.\d+)?)\s+(\w+)/i.exec(raw);
    return m ? `Over ${m[1]} ${m[2].toLowerCase()}` : raw;
  }
  if (ev.kind !== "moneyline" && ev.kind !== "period_winner") return raw;
  const per = ev.kind === "period_winner" ? periodText(ev.period) : null;
  if (code === "D" || /^(tie|draw)\b/i.test(raw)) return per ? `Tie in the ${per}` : /draw/i.test(raw) ? "Draw" : "Tie";
  let team = teams.find((t) => t.code && t.code.toUpperCase() === code);
  if (!team) {
    // "Los Angeles C" with no code match: the one team whose full name the label (minus its last initial) begins.
    const city = raw.replace(/\s+wins?\b.*$/i, "").trim();
    const hits = teams.filter((t) => t.name.toLowerCase().startsWith(city.toLowerCase()));
    if (hits.length === 1) team = hits[0];
  }
  if (!team) return raw;
  return per ? `${team.name} to win the ${per}` : team.name;
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
export function refForHint(s: GeminiSnapshot | null, hint: GeminiHint | undefined, yesTeam?: string, teams: LabelTeam[] = []): GeminiRef | null {
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
  return { prob: c.prob, label: friendlyLabel(ev, c, teams), asOf: s.asOf, url: ev.url, live: s.live, eventTicker: ev.ticker, contract: c.ticker, source: sourceOf(s) };
}

/** Direct mapping from a clip question's config: { event: "NFL-...-M", contract: "DAL" }. */
export function refForContract(s: GeminiSnapshot | null, eventTicker: string, contract: string, teams: LabelTeam[] = []): GeminiRef | null {
  const ev = s?.events.find((e) => e.ticker === eventTicker);
  const c = ev?.contracts.find((x) => x.ticker.toUpperCase() === contract.toUpperCase());
  if (!s || !ev || !c || c.prob === null) return null;
  return { prob: c.prob, label: friendlyLabel(ev, c, teams), asOf: s.asOf, url: ev.url, live: s.live, eventTicker: ev.ticker, contract: c.ticker, source: sourceOf(s) };
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

export function sourceOf(s: Pick<GeminiSnapshot, "source" | "live">): GeminiSource {
  return s.source ?? (s.live ? "live" : "snapshot");
}

/** Events of a stored snapshot (config or replay file), with the mid rule applied to the stored prices. */
export function eventsFromStored(snapshot: NonNullable<GeminiGameConfig["snapshot"]>): GeminiEvent[] {
  return snapshot.events.map((e) => toEvent({ ticker: e.ticker, title: e.title, slug: e.slug, contracts: e.contracts.map((c) => ({ ticker: c.ticker, label: c.label, prices: c })) }));
}

const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
};
const shortTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET`;
};

function snapshotFromConfig(cfg: GeminiGameConfig, error: string, note?: string): GeminiSnapshot | null {
  if (!cfg.snapshot) return null;
  const at = Date.parse(cfg.snapshot.asOf);
  const events = eventsFromStored(cfg.snapshot);
  // Listed but never traded (e.g. Man United v Aston Villa): say there is nothing to compare, not "prices from...".
  const unpriced = !events.some((e) => e.contracts.some((c) => c.prob !== null));
  return {
    at: Number.isNaN(at) ? 0 : at, asOf: cfg.snapshot.asOf, live: false, ok: true, error, events, source: "snapshot",
    note: unpriced
      ? "Gemini listed this game but it never traded, so there are no Gemini prices to compare with."
      : note ?? `Gemini could not be reached (${error}); showing the last prices seen, ${shortDate(cfg.snapshot.asOf)} ${shortTime(cfg.snapshot.asOf)}.`,
  };
}

/** True when the game's Gemini markets have settled (nothing live to fetch any more). */
export function isSettled(cfg: GeminiGameConfig | undefined, now = Date.now()): boolean {
  const t = cfg?.settledAt ? Date.parse(cfg.settledAt) : NaN;
  return Number.isFinite(t) && t <= now;
}

// ---------------------------------------------------------------- replayed real games

/** Value of a [[t, p], ...] series at time `t` (last point at or before it), or undefined before the first. */
export function seriesAt(points: [number, number][] | undefined, t: number): number | undefined {
  if (!points?.length || t < points[0][0]) return undefined;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid][0] <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo][1];
}

/**
 * Gemini as it stood at replay time `atMs` of a replayed real game: every stored contract priced at its real
 * price at that moment (the pregame price before the first tracked point). `wallMs` is the real time of the
 * play on screen; it becomes asOf.
 */
export function replaySnapshotAt(g: ReplayGemini | null | undefined, atMs: number, wallMs: number | null): GeminiSnapshot | null {
  if (!g?.snapshot) return null;
  const events = eventsFromStored(g.snapshot).map((e) => ({
    ...e,
    contracts: e.contracts.map((c) => {
      const p = seriesAt(g.track?.[e.ticker]?.[c.ticker], atMs);
      return p === undefined ? c : { ...c, prob: p, source: "last" as const };
    }),
  }));
  const asOf = wallMs !== null && Number.isFinite(wallMs) ? new Date(wallMs).toISOString() : g.snapshot.asOf;
  const settled = g.settledAt ? ` The market settled ${shortDate(g.settledAt)}.` : "";
  return {
    at: Date.parse(asOf) || 0, asOf, live: false, ok: true, events, source: "replay",
    note: wallMs !== null
      ? `Gemini's real price at this moment of the game (${shortDate(asOf)}, ${shortTime(asOf)}).${settled}`
      : `Gemini's price one minute before kickoff (${shortDate(asOf)}, ${shortTime(asOf)}).${settled}`,
  };
}

/** Gemini's home-win probability over a replayed game up to `atMs` (for the TV chart), at most `max` points. */
export function replayMoneylineTrack(g: ReplayGemini | null | undefined, homeCode: string | undefined, atMs: number, max = 80): { t: number; p: number }[] {
  if (!g?.track || !homeCode) return [];
  const ml = Object.keys(g.track).find((k) => /-M$/.test(k));
  const pts = (ml ? g.track[ml]?.[homeCode] : undefined)?.filter(([t]) => t <= atMs) ?? [];
  if (pts.length <= max) return pts.map(([t, p]) => ({ t, p }));
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]).map(([t, p]) => ({ t, p }));
}

const cacheKey = (base: string) => `gemini:${base}`;

/**
 * Cached Gemini quotes for a game (30 s, failures included). Never throws: when the API is unreachable it
 * returns the config's last-seen snapshot (live=false, real asOf) or null.
 */
export async function geminiForGame(cfg: GeminiGameConfig | undefined, now = Date.now(), opts: { fetch?: FetchLike } = {}): Promise<GeminiSnapshot | null> {
  if (!cfg?.event || process.env.GEMINI_DISABLED === "1") return null;
  // A settled market has nothing live to show: use the stored pregame prices without a network call.
  if (isSettled(cfg, now)) {
    return snapshotFromConfig(cfg, "settled", `Gemini settled this market on ${shortDate(cfg.settledAt!)}; showing its prices from just before kickoff (${shortTime(cfg.snapshot?.asOf ?? cfg.settledAt!)}).`);
  }
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
    return hit ? (JSON.parse(hit) as { snap: GeminiSnapshot | null }).snap : snapshotFromConfig(cfg, "refreshing", "Gemini prices are refreshing; showing the last prices seen.");
  }
  let snap: GeminiSnapshot | null;
  try {
    const events = await fetchGameEvents(cfg.event, opts);
    if (!events.some((e) => e.contracts.some((c) => c.prob !== null))) {
      // Listed but not trading (settled, or no orders on either side): the stored prices say more.
      snap = snapshotFromConfig(cfg, "no live prices", "Gemini lists this game but has no live prices right now (settled or not trading); showing the last prices seen.")
        ?? { at: now, asOf: new Date(now).toISOString(), live: true, ok: true, events, source: "live", note: "Gemini lists this game but has no live prices right now." };
    } else {
      snap = { at: now, asOf: new Date(now).toISOString(), live: true, ok: true, events, source: "live", note: "Live from Gemini Prediction Markets." };
    }
  } catch (e) {
    snap = snapshotFromConfig(cfg, e instanceof Error ? e.message : String(e));
  }
  await kvSet(key, JSON.stringify({ fetchedAt: now, snap }), { px: 10 * 60_000 }).catch(() => undefined);
  return snap;
}

// ---------------------------------------------------------------- market discovery

/** One game Gemini is trading, as the host's "what's on" list shows it. */
export interface DiscoveredGame {
  /** Ticker base, e.g. "NFL-2611221800-TEN-DAL" (the moneyline is `${base}-M`). */
  base: string;
  league: string;
  title: string;
  startTime: string | null;
  /** Gemini marks the game in progress. */
  isLive: boolean;
  url?: string;
  home: { code: string; name: string; prob: number | null } | null;
  away: { code: string; name: string; prob: number | null } | null;
  /** Soccer three-way markets: the draw. */
  draw: number | null;
  /** Dollars traded on the moneyline. */
  volume: number | null;
}

export interface Discovery {
  asOf: string;
  live: boolean;
  source: "live" | "snapshot" | "unavailable";
  note: string;
  leagues: string[];
  games: DiscoveredGame[];
}

export const DISCOVERY_LEAGUES = ["NFL", "NBA", "EPL", "NHL", "NCAAF", "NCAAM", "MLB", "MLS", "UCL"] as const;
export const DISCOVERY_DEFAULT = ["NFL", "NBA", "EPL"];
export const DISCOVERY_CACHE_MS = 120_000;
const DISCOVERY_PAGE = 200;
const DISCOVERY_PAGES = 3;

interface RawListEvent extends RawEvent {
  startTime?: string;
  isLive?: boolean;
  volume?: string;
  status?: string;
  participants?: { name?: string; abbreviation?: string; side?: string }[];
}

/** The full-game moneylines in an events list, as discovered games (pure; exported for tests). */
export function toDiscovered(raw: RawListEvent[], league: string): DiscoveredGame[] {
  const out: DiscoveredGame[] = [];
  for (const e of raw) {
    const t = e.ticker ?? "";
    if (!t.startsWith(`${league}-`) || !/-M$/.test(t)) continue;
    const ev = toEvent(e);
    const side = (s: "home" | "away") => {
      const p = (e.participants ?? []).find((x) => x.side === s);
      if (!p?.abbreviation) return null;
      const c = ev.contracts.find((x) => x.ticker.toUpperCase() === p.abbreviation!.toUpperCase());
      return { code: p.abbreviation, name: p.name ?? p.abbreviation, prob: c?.prob ?? null };
    };
    const draw = ev.contracts.find((x) => x.ticker.toUpperCase() === "D")?.prob ?? null;
    const vol = Number(e.volume);
    out.push({
      base: t.replace(/-M$/, ""), league, title: e.title ?? t, startTime: e.startTime ?? null, isLive: e.isLive === true,
      url: ev.url, home: side("home"), away: side("away"), draw, volume: Number.isFinite(vol) ? vol : null,
    });
  }
  return out;
}

// The events list cannot be filtered to moneylines and player-prop events carry long rule texts, so a page of
// 200 NFL events is ~13 MB and takes ~3 s: discovery gets its own, longer timeout and fetches the remaining
// pages in parallel once the first one says how many there are.
export const DISCOVERY_TIMEOUT_MS = 10_000;

async function discoverLeague(league: string, f: FetchLike, timeoutMs: number, api: string): Promise<DiscoveredGame[]> {
  const page = async (n: number) => {
    const q = new URLSearchParams({ status: "active", category: "sports", search: `${league}-`, limit: String(DISCOVERY_PAGE), offset: String(n * DISCOVERY_PAGE) });
    return (await getJson(`${api}/v1/prediction-markets/events?${q}`, f, timeoutMs)) as { data?: unknown; pagination?: { total?: number } };
  };
  const first = await page(0);
  const total = Number(first?.pagination?.total ?? 0);
  const more = Math.min(DISCOVERY_PAGES, Math.ceil(total / DISCOVERY_PAGE)) - 1;
  const rest = await Promise.allSettled(Array.from({ length: Math.max(0, more) }, (_, i) => page(i + 1)));
  const payloads = [first, ...rest.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<typeof first>).value)];
  const seen = new Set<string>();
  return payloads.flatMap((p) => toDiscovered(unwrapEvents(p) as RawListEvent[], league)).filter((g) => !seen.has(g.base) && !!seen.add(g.base));
}

/**
 * Live sports markets on Gemini (full-game moneylines), soonest first. Cached 60 s; the last good answer is
 * kept a day and served (live=false, real asOf) when Gemini cannot be reached. Never throws.
 */
export async function discoverMarkets(opts: { leagues?: string[]; fetch?: FetchLike; now?: number; apiBase?: string } = {}): Promise<Discovery> {
  const now = opts.now ?? Date.now();
  const leagues = (opts.leagues?.length ? opts.leagues : DISCOVERY_DEFAULT).map((l) => l.toUpperCase()).filter((l) => (DISCOVERY_LEAGUES as readonly string[]).includes(l));
  const key = `gemini:discover:${[...leagues].sort().join(",")}`;
  const lastKey = `${key}:last`;
  if (process.env.GEMINI_DISABLED === "1") return { asOf: new Date(now).toISOString(), live: false, source: "unavailable", note: "Gemini is turned off (GEMINI_DISABLED=1).", leagues, games: [] };
  // Every asked-for league was unknown: say so (Gemini was never called, so it is not "unreachable").
  if (!leagues.length) {
    return { asOf: new Date(now).toISOString(), live: false, source: "unavailable", note: `No supported league asked for. Try ${DISCOVERY_LEAGUES.join(", ")}.`, leagues, games: [] };
  }
  try {
    const hit = await kvGet(key);
    if (hit) {
      const c = JSON.parse(hit) as { fetchedAt: number; d: Discovery };
      if (now - c.fetchedAt < DISCOVERY_CACHE_MS) return c.d;
    }
  } catch {
    /* cache miss */
  }
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = opts.apiBase ?? GEMINI_API_BASE;
  const got = await Promise.allSettled(leagues.map((l) => discoverLeague(l, f, DISCOVERY_TIMEOUT_MS, api)));
  const ok = got.filter((g): g is PromiseFulfilledResult<DiscoveredGame[]> => g.status === "fulfilled");
  if (!ok.length) {
    const err = got.find((g) => g.status === "rejected") as PromiseRejectedResult | undefined;
    const msg = err?.reason instanceof Error ? err.reason.message : "Gemini unreachable";
    const last = await kvGet(lastKey).catch(() => null);
    if (last) {
      const d = JSON.parse(last) as Discovery;
      return { ...d, live: false, source: "snapshot", note: `Gemini could not be reached (${msg}); showing the list as of ${shortDate(d.asOf)} ${shortTime(d.asOf)}.` };
    }
    return { asOf: new Date(now).toISOString(), live: false, source: "unavailable", note: `Gemini could not be reached (${msg}).`, leagues, games: [] };
  }
  const games = ok.flatMap((g) => g.value).sort((a, b) => (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.base.localeCompare(b.base));
  const partial = ok.length < leagues.length ? " Some leagues could not be loaded." : "";
  const d: Discovery = { asOf: new Date(now).toISOString(), live: true, source: "live", note: `Live from Gemini Prediction Markets.${partial}`, leagues, games };
  await kvSet(key, JSON.stringify({ fetchedAt: now, d }), { px: 10 * 60_000 }).catch(() => undefined);
  await kvSet(lastKey, JSON.stringify(d), { px: 24 * 60 * 60_000 }).catch(() => undefined);
  return d;
}
