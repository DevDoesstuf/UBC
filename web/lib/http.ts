import { NextResponse } from "next/server";
import { ApiError } from "./lobby";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** Wraps a route body: ApiError becomes a JSON error with its status, anything else a 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api]", msg);
    return json({ error: msg || "Server error" }, 500);
  }
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The site's public origin. PUBLIC_BASE_URL wins (set it when phones reach the site by a different name). */
export function baseUrl(req: Request): string {
  const fixed = (process.env.PUBLIC_BASE_URL || "").trim();
  if (fixed) return fixed.replace(/\/+$/, "");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || (/^(localhost|127\.|10\.|192\.168\.|172\.)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/** End user's IP, which Coinbase Onramp asks for. Vercel sets x-real-ip / x-forwarded-for itself. */
export function clientIp(req: Request): string | null {
  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  return ip && ip !== "::1" && ip !== "127.0.0.1" ? ip : null;
}

export function playerToken(req: Request): string | null {
  return req.headers.get("x-player-token");
}

/** If KIOSK_KEY is set, kiosk actions need it (header x-kiosk-key, or ?key= for the web kiosk). */
export function checkKioskKey(req: Request): void {
  const key = (process.env.KIOSK_KEY || "").trim();
  if (!key) return;
  const got = req.headers.get("x-kiosk-key") || new URL(req.url).searchParams.get("key");
  if (got !== key) throw new ApiError(401, "Wrong kiosk key");
}
