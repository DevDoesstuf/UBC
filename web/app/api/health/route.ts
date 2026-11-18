import { json } from "@/lib/http";
import { storageMode } from "@/lib/store";
import { moneyInfo, moneyProblems } from "@/lib/money";
import { allGames, hasVideo } from "@/lib/games";

export const dynamic = "force-dynamic";

export async function GET() {
  const warnings = [...moneyProblems()];
  if (process.env.VERCEL && storageMode === "memory") {
    warnings.push("Running on Vercel without Redis: lobbies will randomly disappear. Add Upstash Redis (see README).");
  }
  for (const g of allGames()) if (g.live && !hasVideo(g)) warnings.push(`Game "${g.id}" has no YouTube id yet (config/games.json)`);
  return json({ ok: true, storage: storageMode, money: moneyInfo(), kioskKey: !!process.env.KIOSK_KEY, warnings });
}
