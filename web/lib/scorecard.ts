// Friends vs. the model vs. Gemini (ported from Huddle packages/shared/src/math/scorecard.ts).
// Brier score per forecaster over resolved questions: mean of (p - outcome)^2 where p is the probability
// given to YES and outcome is 1 for YES, 0 for NO. Lower is better. Pure module.

export interface ScoreEntry {
  /** Room: the YES price when trading locked. */
  room: number;
  /** Model: the YES prior the question opened at (null when there was no model). */
  model: number | null;
  /** Gemini's YES probability at lock (null when not comparable). */
  gemini: number | null;
  /** 1 = YES happened, 0 = NO. */
  outcome: 0 | 1;
}

export interface Scorecard {
  room: number | null;
  model: number | null;
  gemini: number | null;
  n: number;
  verdict: string;
}

export function brier(pairs: { p: number; o: 0 | 1 }[]): number | null {
  if (!pairs.length) return null;
  return pairs.reduce((a, { p, o }) => a + (p - o) ** 2, 0) / pairs.length;
}

const r3 = (x: number | null) => (x === null ? null : Math.round(x * 1000) / 1000);

export function buildScorecard(entries: ScoreEntry[]): Scorecard {
  const withModel = entries.filter((e) => typeof e.model === "number");
  const withGemini = entries.filter((e) => typeof e.gemini === "number");
  const room = brier(entries.map((e) => ({ p: e.room, o: e.outcome })));
  const model = brier(withModel.map((e) => ({ p: e.model as number, o: e.outcome })));
  const gemini = brier(withGemini.map((e) => ({ p: e.gemini as number, o: e.outcome })));
  // Compare like with like: the room against the model on the questions the model priced.
  const roomM = brier(withModel.map((e) => ({ p: e.room, o: e.outcome })));
  const roomG = brier(withGemini.map((e) => ({ p: e.room, o: e.outcome })));
  const modelG = brier(withGemini.filter((e) => typeof e.model === "number").map((e) => ({ p: e.model as number, o: e.outcome })));

  let verdict = "No resolved questions yet.";
  if (room !== null) verdict = `Room Brier ${room.toFixed(2)} over ${entries.length} question${entries.length === 1 ? "" : "s"}.`;
  if (roomM !== null && model !== null) {
    const diff = Math.abs(roomM - model);
    if (diff < 0.005) verdict = "The room and the model are dead even tonight";
    else if (roomM < model) verdict = `The room beat the model by ${diff.toFixed(2)} tonight`;
    else verdict = `The model beat the room by ${diff.toFixed(2)} tonight`;
    if (gemini !== null && roomG !== null) {
      const best = Math.min(roomG, modelG ?? Infinity);
      if (gemini < best - 0.005) verdict += "; Gemini still wins";
      else if (gemini > best + 0.005) verdict += modelG === null || roomG <= modelG ? "; and the room out-called Gemini" : "; and the model out-called Gemini";
      else verdict += "; Gemini is level with the best of them";
    }
    verdict += ".";
  }
  return { room: r3(room), model: r3(model), gemini: r3(gemini), n: entries.length, verdict };
}
