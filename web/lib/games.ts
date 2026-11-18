import config from "@/config/games.json";
import { simulate } from "./replay/run";
import { getTimeline } from "./replay/timeline";
import type { Game, Question } from "./types";

// The games config is bundled at build time. Edit config/games.json and redeploy (or restart `npm run dev`).
//
// kind "clip" (default): Dev's flow, a YouTube clip and the questions written in the config.
// kind "replay": a game timeline from config/replays; the question engine writes the questions as the
// game plays. Their `questions` list is the script the engine asks when nobody taps (simulated once at
// load), so the kiosk's "Question N of M" and the select tile keep working unchanged.
function replayQuestions(replayId: string | undefined, pregame: boolean): Question[] {
  if (!replayId || !getTimeline(replayId)) return [];
  return simulate(replayId, { pregame }).map((q, i) => ({
    id: `r${i + 1}`, text: q.text, short: q.short, startAt: 0, lockAt: 0, resolveAt: null, answer: null, prior: q.yesPrior,
  }));
}

const GAMES: Game[] = (config.games as unknown as Game[]).map((g) => {
  const kind = g.kind === "replay" ? "replay" : "clip";
  return {
    ...g,
    kind,
    b: g.b && g.b > 0 ? g.b : 10,
    questions:
      kind === "replay"
        ? replayQuestions(g.replay, !!g.gemini?.event)
        : (g.questions || []).map((q) => ({ ...q, answer: q.answer ?? null, resolveAt: q.resolveAt ?? null, prior: q.prior ?? null })),
  };
});

export function allGames(): Game[] {
  return GAMES;
}

export function getGame(id: string): Game | undefined {
  return GAMES.find((g) => g.id === id);
}

export function hasVideo(g: Game): boolean {
  return /^[\w-]{11}$/.test(g.youtubeId || "");
}

export function isReplay(g: Game | undefined): boolean {
  return g?.kind === "replay";
}
