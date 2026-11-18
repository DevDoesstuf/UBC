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

/**
 * Real replayed games carry their league, date, source and Gemini mapping in the replay file (written by
 * scripts/build-replays.mjs); a games.json entry only has to point at the file. Values in games.json win.
 */
function fromReplay(g: Game): Partial<Game> {
  const t = g.kind === "replay" && g.replay ? getTimeline(g.replay) : undefined;
  if (!t) return {};
  const out: Partial<Game> = {};
  if (t.meta.league) out.league = t.meta.league;
  if (t.meta.date) out.date = t.meta.date;
  if (t.meta.real) out.real = true;
  if (t.meta.source) out.source = t.meta.source;
  if (t.gemini?.event) {
    out.gemini = {
      event: t.gemini.event, home: t.gemini.home, away: t.gemini.away, snapshot: t.gemini.snapshot,
      settledAt: t.gemini.settledAt ?? null, url: t.gemini.url,
    };
  }
  if (t.info.sport) out.sport = t.info.sport;
  return out;
}

const GAMES: Game[] = (config.games as unknown as Game[]).map((raw) => {
  const kind = raw.kind === "replay" ? "replay" : "clip";
  const g: Game = { ...fromReplay({ ...raw, kind }), ...raw };
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
