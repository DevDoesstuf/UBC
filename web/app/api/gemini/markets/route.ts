// GET /api/gemini/markets                     live Gemini sports markets (NFL, NBA, EPL full-game moneylines), soonest first
//     ?league=NFL,NBA,NHL                     other leagues: NFL NBA EPL NHL NCAAF NCAAM MLB MLS UCL
//     ?team=DAL                               only games with that team code
// Each of our games also lists the Gemini markets its teams play next ("ours"), so the host can see what is on.
// Cached 2 min; when Gemini is unreachable it serves the last good list (live=false, real asOf). Never 5xx for Gemini.
import { json, handle } from "@/lib/http";
import { allGames } from "@/lib/games";
import { discoverMarkets, isSettled } from "@/lib/gemini";
import { getTimeline } from "@/lib/replay/timeline";

export const dynamic = "force-dynamic";

const LEAGUE_OF: Record<string, string> = { NFL: "NFL", NBA: "NBA", "Premier League": "EPL" };

export async function GET(req: Request) {
  return handle(async () => {
    const u = new URL(req.url);
    const leagues = (u.searchParams.get("league") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const team = (u.searchParams.get("team") ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const d = await discoverMarkets({ leagues });
    const games = team ? d.games.filter((g) => g.home?.code === team || g.away?.code === team) : d.games;
    const ours = allGames()
      .filter((g) => g.live && g.gemini?.event)
      .map((g) => {
        const t = g.replay ? getTimeline(g.replay) : undefined;
        const league = (g.league && LEAGUE_OF[g.league]) || g.gemini!.event.split("-")[0];
        const codes = [g.gemini!.home, g.gemini!.away].filter((c): c is string => !!c);
        const next = d.games.filter((x) => x.league === league && x.base !== g.gemini!.event && codes.some((c) => x.home?.code === c || x.away?.code === c));
        return {
          gameId: g.id, title: g.title, event: g.gemini!.event, real: g.real ?? false, date: g.date ?? null,
          settled: isSettled(g.gemini), hasPriceHistory: !!t?.gemini?.track && Object.keys(t.gemini.track).length > 0,
          liveNow: d.games.find((x) => x.base === g.gemini!.event) ?? null,
          upcoming: next.slice(0, 4),
        };
      });
    return json({ asOf: d.asOf, live: d.live, source: d.source, note: d.note, leagues: d.leagues, count: games.length, games, ours });
  });
}
