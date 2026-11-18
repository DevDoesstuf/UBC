import { json } from "@/lib/http";
import { allGames, hasVideo } from "@/lib/games";

export async function GET() {
  return json({
    games: allGames().map((g) => ({
      id: g.id, title: g.title, subtitle: g.subtitle ?? "", live: g.live, color: g.color ?? null,
      hasVideo: hasVideo(g), questions: g.questions.map((q) => ({ id: q.id, text: q.text })),
    })),
  });
}
