import config from "@/config/games.json";
import type { Game } from "./types";

// The games config is bundled at build time. Edit config/games.json and redeploy (or restart `npm run dev`).
const GAMES: Game[] = (config.games as unknown as Game[]).map((g) => ({
  ...g,
  b: g.b && g.b > 0 ? g.b : 10,
  questions: (g.questions || []).map((q) => ({ ...q, answer: q.answer ?? null, resolveAt: q.resolveAt ?? null })),
}));

export function allGames(): Game[] {
  return GAMES;
}

export function getGame(id: string): Game | undefined {
  return GAMES.find((g) => g.id === id);
}

export function hasVideo(g: Game): boolean {
  return /^[\w-]{11}$/.test(g.youtubeId || "");
}
