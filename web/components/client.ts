"use client";
// Small browser helpers shared by the pages: fetch wrapper, polling hook, money formatting, player token storage.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicLobby } from "@/lib/lobby";
import type { moneyInfo } from "@/lib/money";
import type { KioskScreen } from "@/lib/kiosk";

export type LobbyData = PublicLobby & {
  money: ReturnType<typeof moneyInfo>;
  buy: { options: number[]; min: number; max: number };
};
export type { KioskScreen };

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export class HttpError extends Error {
  constructor(message: string, public status: number, public data: unknown) {
    super(message);
  }
}

export async function api<T>(
  url: string,
  opts: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers["x-player-token"] = opts.token;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(url, {
    method: opts.body !== undefined ? "POST" : "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new HttpError(j.error || `HTTP ${r.status}`, r.status, j);
  return j as T;
}

/** Calls `load` every `ms` (waiting for each call to finish first). Pass null to pause. */
export function usePoll<T>(load: (() => Promise<T>) | null, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<HttpError | Error | null>(null);
  const [lastOk, setLastOk] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const refresh = useCallback(async () => {
    const f = loadRef.current;
    if (!f) return;
    try {
      setData(await f());
      setError(null);
      setLastOk(Date.now());
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  const active = load !== null;
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (alive) t = setTimeout(loop, ms);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [refresh, ms, active]);
  return { data, error, refresh, lastOk };
}

/** Re-renders every `ms` (for countdowns). */
export function useNow(ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Query string value, read after mount (avoids Suspense requirements of useSearchParams). */
export function useQueryParam(name: string): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    setV(new URLSearchParams(window.location.search).get(name));
  }, [name]);
  return v;
}

const tokenKey = (code: string, seat: string | null) => `ll:${code}${seat ? `:${seat}` : ""}`;

export function loadToken(code: string, seat: string | null): string | null {
  try {
    return localStorage.getItem(tokenKey(code, seat));
  } catch {
    return null;
  }
}

export function saveToken(code: string, seat: string | null, token: string | null) {
  try {
    if (token) localStorage.setItem(tokenKey(code, seat), token);
    else localStorage.removeItem(tokenKey(code, seat));
  } catch {
    /* private mode: the token only lives for this page view */
  }
}

export const fmtClock = (secs: number) => `${Math.floor(secs / 60)}:${String(Math.max(0, secs) % 60).padStart(2, "0")}`;
