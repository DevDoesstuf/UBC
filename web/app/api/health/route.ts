import { json } from "@/lib/http";
import { storageMode } from "@/lib/store";
import { moneyInfo, moneyProblems } from "@/lib/money";
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
    gemini: { enabled: process.env.GEMINI_DISABLED !== "1", games: allGames().filter((g) => g.gemini?.event).map((g) => g.id) },
    games: allGames().filter((g) => g.live).map((g) => ({ id: g.id, kind: g.kind ?? "clip", mode: g.mode ?? "market", questions: g.questions.length })),
    warnings,
  });
}
