// Optional lobby fields the backend may add (replay scorebug, pool / head-to-head markets, model and Gemini
// prices, announcer captions, end-of-game scorecard). Every reader returns null/[] when the field is absent,
// so the UI renders a block only when the server really sent it. Never fake these values.
import type { LobbyData } from "./client";

export type MarketMode = "market" | "pool" | "h2h";
export type Score = { home: string; away: string; homeScore: number; awayScore: number; clock: string };
export type Offer = { id: string; by: string; side: "yes" | "no"; cents: number; odds: number; open: boolean };
export type Gemini = { prob: number; label: string; asOf: string; url?: string };
export type Caption = { id: number; at: number; text: string };
export type Scorecard = { room: number | null; model: number | null; gemini: number | null; n: number; verdict: string };

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function gameKind(l: LobbyData): "clip" | "replay" | null {
  const k = obj(l.game)?.kind;
  return k === "clip" || k === "replay" ? k : null;
}

export function gameScore(l: LobbyData): Score | null {
  const s = obj(obj(l.game)?.score);
  if (!s) return null;
  const home = str(s.home), away = str(s.away), hs = num(s.homeScore), as = num(s.awayScore);
  if (home === null || away === null || hs === null || as === null) return null;
  return { home, away, homeScore: hs, awayScore: as, clock: str(s.clock) ?? "" };
}

export function marketMode(l: LobbyData): MarketMode {
  const m = obj(l.market)?.mode;
  return m === "pool" || m === "h2h" ? m : "market";
}

export function marketPool(l: LobbyData): { yesCents: number; noCents: number } | null {
  const p = obj(obj(l.market)?.pool);
  if (!p) return null;
  const y = num(p.yesCents), n = num(p.noCents);
  return y === null || n === null ? null : { yesCents: y, noCents: n };
}

export function marketOffers(l: LobbyData): Offer[] {
  const list = obj(l.market)?.offers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((o): Offer[] => {
    const x = obj(o);
    if (!x) return [];
    const id = str(x.id), by = str(x.by), cents = num(x.cents), odds = num(x.odds);
    const side = x.side === "yes" || x.side === "no" ? x.side : null;
    if (!id || by === null || !side || cents === null || odds === null) return [];
    return [{ id, by, side, cents, odds, open: x.open !== false }];
  });
}

/** Model's YES probability, 0..1. */
export function marketModel(l: LobbyData): number | null {
  const v = num(obj(l.market)?.model);
  return v === null ? null : Math.min(1, Math.max(0, v));
}

export function marketGemini(l: LobbyData): Gemini | null {
  const g = obj(obj(l.market)?.gemini);
  if (!g) return null;
  const prob = num(g.prob);
  if (prob === null) return null;
  return { prob: Math.min(1, Math.max(0, prob)), label: str(g.label) ?? "", asOf: str(g.asOf) ?? "", url: str(g.url) ?? undefined };
}

/** The newest announcer line, or null. */
export function latestCaption(l: LobbyData): Caption | null {
  const list = (l as unknown as Loose).captions;
  if (!Array.isArray(list)) return null;
  let best: Caption | null = null;
  for (const c of list) {
    const x = obj(c);
    const id = num(x?.id), at = num(x?.at), text = str(x?.text);
    if (id === null || text === null || !text.trim()) continue;
    if (!best || id > best.id) best = { id, at: at ?? 0, text };
  }
  return best;
}

export function scorecard(l: LobbyData): Scorecard | null {
  const s = obj((l as unknown as Loose).scorecard);
  if (!s) return null;
  return { room: num(s.room), model: num(s.model), gemini: num(s.gemini), n: num(s.n) ?? 0, verdict: str(s.verdict) ?? "" };
}

/** 0..1 probability as whole cents, clamped to 1..99 like the market's own prices. */
export const probCents = (p: number) => Math.min(99, Math.max(1, Math.round(p * 100)));
