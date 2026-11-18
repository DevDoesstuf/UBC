// Tiny key-value store with two backends:
//  - Upstash Redis over its REST API (what Vercel's "Upstash for Redis" marketplace integration sets up).
//    Needed on Vercel, because serverless functions do not share memory between instances.
//  - In-process memory, used automatically when no Redis env vars are set (local `npm run dev`).
// Only the handful of commands the app needs: get, set (with NX / PX), del.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export const storageMode: "redis" | "memory" = REDIS_URL && REDIS_TOKEN ? "redis" : "memory";

type MemEntry = { v: string; exp: number | null };
const g = globalThis as unknown as { __llMem?: Map<string, MemEntry> };
const mem: Map<string, MemEntry> = g.__llMem ?? (g.__llMem = new Map());

async function redis(cmd: (string | number)[]): Promise<unknown> {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  const j = (await r.json().catch(() => ({}))) as { result?: unknown; error?: string };
  if (!r.ok || j.error) throw new Error(`redis ${cmd[0]} failed: ${j.error || r.status}`);
  return j.result;
}

function memGet(key: string): string | null {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp !== null && e.exp <= Date.now()) {
    mem.delete(key);
    return null;
  }
  return e.v;
}

export async function kvGet(key: string): Promise<string | null> {
  if (storageMode === "redis") return ((await redis(["GET", key])) as string | null) ?? null;
  return memGet(key);
}

/** Returns false when `nx` is set and the key already exists. */
export async function kvSet(key: string, value: string, opts: { px?: number; nx?: boolean } = {}): Promise<boolean> {
  if (storageMode === "redis") {
    const cmd: (string | number)[] = ["SET", key, value];
    if (opts.px) cmd.push("PX", opts.px);
    if (opts.nx) cmd.push("NX");
    return (await redis(cmd)) === "OK";
  }
  if (opts.nx && memGet(key) !== null) return false;
  mem.set(key, { v: value, exp: opts.px ? Date.now() + opts.px : null });
  return true;
}

export async function kvDel(key: string): Promise<void> {
  if (storageMode === "redis") await redis(["DEL", key]);
  else mem.delete(key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding a short lock, so two phones buying at the same moment cannot
 * overwrite each other's trade. Lock expires on its own after 8 s if a function crashes.
 */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const key = `lock:${name}`;
  const token = Math.random().toString(36).slice(2);
  const deadline = Date.now() + 5000;
  while (!(await kvSet(key, token, { px: 8000, nx: true }))) {
    if (Date.now() > deadline) throw new Error("The lobby is busy, try again");
    await sleep(30 + Math.random() * 70);
  }
  try {
    return await fn();
  } finally {
    if ((await kvGet(key)) === token) await kvDel(key);
  }
}
