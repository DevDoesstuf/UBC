import { json } from "@/lib/http";
import { storageMode } from "@/lib/store";
import { MONEY_MODE, REQUESTED_MONEY_MODE, moneyInfo, moneyProblems } from "@/lib/money";
import { solanaProblems, treasuryInfo } from "@/lib/solana";
import { allGames, hasVideo } from "@/lib/games";
import { ttsEnabled } from "@/lib/tts";

export const dynamic = "force-dynamic";

export async function GET() {
  const warnings = [...moneyProblems()];
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
      active: MONEY_MODE === "solana",
      network: "devnet",
      problems: REQUESTED_MONEY_MODE === "solana" ? solanaProblems() : [],
      treasury: MONEY_MODE === "solana" ? await treasuryInfo().catch((e) => ({ error: String(e) })) : null,
    },
    gemini: { enabled: process.env.GEMINI_DISABLED !== "1", games: allGames().filter((g) => g.gemini?.event).map((g) => g.id) },
    games: allGames().filter((g) => g.live).map((g) => ({ id: g.id, kind: g.kind ?? "clip", mode: g.mode ?? "market", questions: g.questions.length })),
    warnings,
  });
}
