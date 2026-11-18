import { json } from "@/lib/http";
import { storageMode } from "@/lib/store";
import { MONEY_MODE, REQUESTED_MONEY_MODE, moneyInfo, moneyProblems } from "@/lib/money";
import { SOLANA_RPC_URL, redactRpc, solanaProblems, solanaReadiness } from "@/lib/solana";
import { allGames, hasVideo } from "@/lib/games";
import { ttsEnabled } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET() {
  const warnings = [...moneyProblems()];
  // Solana: live checks (cluster, treasury SOL/USDC, mint) whenever MONEY_MODE=solana or the keys are present.
  const solanaAsked = REQUESTED_MONEY_MODE === "solana" || !!process.env.SOLANA_TREASURY_SECRET_KEY;
  const readiness = solanaAsked ? await solanaReadiness().catch((e) => ({ ready: false, problems: [String(e)], nextSteps: [] as string[] })) : null;
  if (readiness && REQUESTED_MONEY_MODE === "solana") for (const p of readiness.problems) if (!warnings.some((w) => w.includes(p))) warnings.push(`Solana: ${p}`);
  if (process.env.VERCEL && storageMode === "memory") {
    warnings.push("Running on Vercel without Redis: lobbies will randomly disappear. Add Upstash Redis (see README).");
  }
  for (const g of allGames()) if (g.live && g.kind !== "replay" && !hasVideo(g)) warnings.push(`Game "${g.id}" has no YouTube id yet (config/games.json)`);
  const tts = ttsEnabled();
  return json({
    ok: true,
    storage: storageMode,
    money: moneyInfo(),
    kioskKey: !!process.env.KIOSK_KEY,
    tts: { elevenlabs: tts, fallback: tts ? null : "webspeech" },
    solana: {
      requested: REQUESTED_MONEY_MODE === "solana",
      /** MONEY_MODE=solana is on (env complete); `ready` says whether the chain side works right now. */
      active: MONEY_MODE === "solana",
      ready: MONEY_MODE === "solana" && !!readiness?.ready,
      /** "devnet" (default), or what the RPC really is once checked ("localnet" for solana-test-validator). */
      network: (readiness && "cluster" in readiness && readiness.cluster) || "devnet",
      rpc: redactRpc(SOLANA_RPC_URL),
      problems: REQUESTED_MONEY_MODE === "solana" ? [...new Set([...solanaProblems(), ...(readiness?.problems ?? [])])] : [],
      nextSteps: readiness?.nextSteps ?? (REQUESTED_MONEY_MODE === "solana" ? ["Run `node scripts/solana-setup.mjs` in web/"] : []),
      treasury: readiness && "treasury" in readiness && readiness.treasury ? { address: readiness.treasury, mint: process.env.USDC_MINT?.trim() || null, rpc: redactRpc(SOLANA_RPC_URL) } : null,
      checks: readiness && "checkedAt" in readiness ? readiness : null,
    },
    gemini: { enabled: process.env.GEMINI_DISABLED !== "1", games: allGames().filter((g) => g.gemini?.event).map((g) => g.id) },
    games: allGames().filter((g) => g.live).map((g) => ({ id: g.id, kind: g.kind ?? "clip", mode: g.mode ?? "market", questions: g.questions.length })),
    warnings,
  });
}
