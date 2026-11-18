// Data polish: replay text the box can draw, Gemini labels in our team names, a scorecard that says what it
// compares, question variety (new templates and their resolvers), and a rejected ElevenLabs key. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9"; // unreachable: nothing in here may need the live API
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.ELEVENLABS_API_KEY;

const { getTimeline, replayIds } = await import("../lib/replay/timeline.ts");
const { HuddleQuestionEngine, familyOf } = await import("../lib/replay/engine.ts");
const { initialGameState } = await import("../lib/replay/types.ts");
const { simulate, MAX_PER_FAMILY, varietyBlock } = await import("../lib/replay/run.ts");
const builder = await import("../scripts/build-replays.mjs");
const { captionLine, fitText, MAX_CAPTION } = await import("../lib/announcer.ts");
const gem = await import("../lib/gemini.ts");
const { buildScorecard } = await import("../lib/scorecard.ts");
const tts = await import("../lib/tts.ts");

const LATIN1 = /^[\x20-\x7E\xA0-\xFF]*$/;

// ---------------------------------------------------------------- replay text

test("replay text: Latin-1, at most 150 characters, whole words, no feed boilerplate", () => {
  for (const id of replayIds()) {
    const t = getTimeline(id)!;
    for (const name of [t.info.home.name, t.info.away.name, t.info.title]) assert.ok(LATIN1.test(name), `${id}: ${name}`);
    for (const { event: e } of t.events) {
      for (const s of [e.text ?? "", e.player ?? ""]) assert.ok(LATIN1.test(s), `${id} #${e.seq}: ${s}`);
      const s = e.text ?? "";
      if (!s) continue;
      assert.ok(s.length <= builder.MAX_TEXT, `${id} #${e.seq} is ${s.length} chars: ${s}`);
      assert.match(s, /[.!?)"']$/, `${id} #${e.seq} ends mid-sentence: ${s}`);
      assert.doesNotMatch(s, /Shotgun|No Huddle|formation\)|Center-|Holder-|was injured during|reported in as eligible|\[|\*\*|enforced at|\(\d{1,2}:\d\d/, `${id} #${e.seq}: ${s}`);
      assert.doesNotMatch(s, /[a-z]\.[A-Z][a-z]{2,} /, `${id} #${e.seq} has a missing space after a sentence: ${s}`);
    }
  }
});

test("build-replays text rules: formations, tacklers, snappers, penalties, reviews, Latin-1, fit at boundaries", () => {
  const p = builder.tidyPlay;
  assert.equal(p("(Shotgun) J.Williams up the middle to SF 45 for 4 yards (D.Greenlaw; F.Warner)."), "J.Williams up the middle to SF 45 for 4 yards.");
  assert.equal(p("(No Huddle, Shotgun) B.Purdy pass incomplete short left to J.Watkins (J.Porter) [K.White]."), "B.Purdy pass incomplete short left to J.Watkins.");
  assert.equal(p(" B.Aubrey 52 yard field goal is GOOD, Center-T.Sieg, Holder-B.Anger."), "B.Aubrey 52 yard field goal is GOOD.");
  assert.equal(p("C.Waitman punts 44 yards to DAL 18, Center-J.Weeks. K.Turpin pushed ob at DAL 26 for 8 yards (A.Davis)."), "C.Waitman punts 44 yards to DAL 18. K.Turpin pushed out of bounds at DAL 26 for 8 yards.");
  assert.equal(
    p("J.Williams up the middle to DAL 48 for 2 yards (D.Buckner; O.Odighizuwa).PENALTY on SF-N.Bosa, Defensive Offside, 5 yards, enforced at DAL 46 - No Play."),
    "J.Williams up the middle to DAL 48 for 2 yards. Penalty on N.Bosa (SF), defensive offside, 5 yards, no play.",
  );
  assert.equal(p("B.Purdy sacked at SF 39 for -2 yards (sack split by J.Houston and O.Ogbonnia). DAL-O.Ogbonnia was injured during the play."), "B.Purdy sacked at SF 39 for -2 yards.");
  assert.equal(p("D.Prescott pass short right to G.Pickens for 5 yards, TOUCHDOWN. TWO-POINT CONVERSION ATTEMPT. D.Prescott pass to G.Pickens is incomplete. ATTEMPT FAILS."), "D.Prescott pass short right to G.Pickens for 5 yards, TOUCHDOWN. Two-point try fails.");
  assert.equal(p("J.Herbert pass incomplete deep right to T.Harris.Los Angeles Chargers challenged the incomplete pass ruling, and the play was REVERSED.J.Herbert pass deep right to T.Harris to BLT 26 for 31 yards (K.Hamilton)."), "After review: J.Herbert pass deep right to T.Harris to BLT 26 for 31 yards.");
  assert.equal(p("(Run formation) PENALTY on LAC, Delay of Game, 5 yards, enforced at BLT 1 - No Play."), "Penalty on LAC, delay of game, 5 yards, no play.");
  assert.equal(p("(14:56 - 1st) D.Henry right end to BLT 21 for -2 yards (K.Mack, D.Henley)."), "D.Henry right end to BLT 21 for -2 yards.");
  assert.equal(p("Aday Mara blocks Max Strus 's 5-foot two point shot"), "Aday Mara blocks Max Strus's 5-foot two point shot.");
  assert.equal(builder.tidySoccer("Alysson (Aston Villa) left footed shot from the right side of the box is saved in the bottom right corner by Senne Lammens (Manchester United)."), "Alysson (Aston Villa) left footed shot from the right side of the box is saved by Senne Lammens (Manchester United).");
  assert.equal(builder.latin1("Łukasz Fabiański – Ødegaard’s “cross”…"), "Lukasz Fabianski - Ødegaard's \"cross\"...");
  // Whole sentences while they fit, else a word boundary with "..."; never mid-word.
  const long = "GOAL! Manchester United 0, Aston Villa 2. Nicolas Jackson (Aston Villa) right footed shot from very close range. Assisted by Youri Tielemans with a cross.";
  assert.equal(builder.fitText(long, 120), "GOAL! Manchester United 0, Aston Villa 2. Nicolas Jackson (Aston Villa) right footed shot from very close range.");
  const one = builder.fitText("Attempt saved. Alysson (Aston Villa) left footed shot from the right side of the box is saved by Senne Lammens", 60);
  assert.ok(one.length <= 60 && one.endsWith("..."), one);
  const lastWord = one.slice(0, -3).split(" ").pop()!;
  assert.ok(["Attempt", "saved.", "Alysson", "(Aston", "Villa)", "left", "footed", "shot", "from", "the", "right"].includes(lastWord), `cut mid-word: ${one}`);
});

test("captions never exceed what the box draws, and are cut at a word", () => {
  const huge = `${"D.Prescott pass short right to G.Pickens for 35 yards, TOUCHDOWN. ".repeat(4)}`;
  const line = captionLine({ type: "play", text: huge }, "nfl", "s")!;
  assert.ok(line.length <= MAX_CAPTION, `${line.length}`);
  const end = captionLine({ type: "end", leader: { name: "Samantha Longname", cents: 1250 }, verdict: "The room beat the model by 0.04 tonight. Gemini priced 3 of 8: the room out-called Gemini on those." }, "nfl", "x")!;
  assert.ok(end.length <= MAX_CAPTION && /[.!?]$/.test(end), end);
  assert.equal(fitText("short line."), "short line.");
  const w = fitText(`${"word ".repeat(60)}end`, 50);
  assert.ok(w.endsWith("...") && w.length <= 50 && /word\.\.\.$/.test(w), w);
});

test("every simulated question reads on the box: Latin-1, short line fits", () => {
  for (const id of replayIds()) {
    for (const q of simulate(id, { pregame: true })) {
      assert.ok(LATIN1.test(q.text) && LATIN1.test(q.short), `${id}: ${q.text}`);
      assert.ok(q.text.length <= 90, `${id}: ${q.text}`);
      assert.ok(q.short.length <= 40, `${id}: ${q.short}`);
      assert.doesNotMatch(q.text, /\b\d+(?:st|nd|rd|th)\b/.test(q.text) ? /\b(?:1[1-3]|[02-9]?[1-3])th\b|\b\d*[4-90]st\b/ : /$^/, `${id}: bad ordinal in ${q.text}`);
    }
  }
});

// ---------------------------------------------------------------- Gemini labels

test("Gemini labels: our team names, never Gemini's cut-short city ('Los Angeles C')", () => {
  const teams = [{ code: "BAL", name: "Ravens" }, { code: "LAC", name: "Chargers" }];
  const ml = { kind: "moneyline" as const, period: undefined };
  assert.equal(gem.friendlyLabel(ml, { ticker: "LAC", label: "Los Angeles C" }, teams), "Chargers");
  assert.equal(gem.friendlyLabel(ml, { ticker: "BAL", label: "Baltimore" }, teams), "Ravens");
  assert.equal(gem.friendlyLabel({ kind: "period_winner", period: "1H" }, { ticker: "LAC", label: "Los Angeles C wins 1st Half" }, teams), "Chargers to win the 1st half");
  assert.equal(gem.friendlyLabel({ kind: "period_winner", period: "2H" }, { ticker: "D", label: "Tie in 2nd Half" }, teams), "Tie in the 2nd half");
  assert.equal(gem.friendlyLabel({ kind: "total" }, { ticker: "O39", label: "More than 39.5 points scored" }, teams), "Over 39.5 points");
  // No code match: the one team whose name the city starts.
  assert.equal(gem.friendlyLabel(ml, { ticker: "X", label: "Los Angeles C" }, [{ code: "LAC", name: "Los Angeles Chargers" }, { code: "BAL", name: "Baltimore Ravens" }]), "Los Angeles Chargers");
  // Every label in the replayed real games maps to a name without Gemini's truncation.
  for (const id of replayIds()) {
    const t = getTimeline(id)!;
    const snap = gem.replaySnapshotAt(t.gemini, 0, null);
    if (!snap) continue;
    const say = (n: string) => n.split(/\s+/).pop()!;
    const tm = [{ code: t.gemini!.home ?? t.info.home.short, name: say(t.info.home.name) }, { code: t.gemini!.away ?? t.info.away.short, name: say(t.info.away.name) }];
    for (const e of snap.events) {
      for (const c of e.contracts) {
        const l = gem.friendlyLabel(e, c, tm);
        assert.doesNotMatch(l, /\b(Los Angeles|New York) [A-Z]\b|More than|wins \d/, `${id} ${e.ticker} ${c.ticker}: ${l}`);
        assert.ok(LATIN1.test(l) && l.length <= 40, l);
      }
    }
    const ref = gem.refForHint(snap, { kind: "moneyline" }, t.gemini!.away, tm);
    if (ref) assert.equal(ref.label, tm[1].name, id);
  }
});

test("lobby: the Chargers game shows Gemini as 'Chargers', the caption too", async () => {
  const lobby = await import("../lib/lobby.ts");
  const { kioskTouch } = await import("../lib/kiosk.ts");
  await kioskTouch("641", "game:nfl-lac-bal", "http://x");
  await kioskTouch("641", "start", "http://x");
  const l = (await lobby.getKioskLobby("641"))!;
  assert.ok(l.market?.gemini, "pregame moneyline has Gemini");
  assert.equal(l.market!.gemini!.label, "Ravens");
  const cap = l.captions!.at(-1)!.text;
  assert.match(cap, /Gemini has Ravens at \d+%/);
  assert.doesNotMatch(JSON.stringify(lobby.publicView(l, null, "http://x")), /Los Angeles C\b"/);
});

// ---------------------------------------------------------------- scorecard

test("scorecard: says on how many questions Gemini was compared; unpriced games get a note, not a verdict", () => {
  const e = (room: number, model: number, gemini: number | null, outcome: 0 | 1, extra = {}) => ({ room, model, gemini, outcome, ...extra });
  const sc = buildScorecard([e(0.7, 0.6, 0.8, 1), e(0.3, 0.4, 0.2, 0), e(0.6, 0.5, null, 1), e(0.5, 0.5, null, 0), e(0.8, 0.6, 0.7, 1), e(0.4, 0.5, null, 1), e(0.2, 0.3, null, 0), e(0.9, 0.7, null, 1)]);
  assert.equal(sc.n, 8);
  assert.match(sc.verdict, /^The room beat the model by 0\.\d\d tonight\. Gemini priced 3 of 8: /);
  assert.match(sc.verdict, /(Gemini called those best|out-called Gemini on those|level on those)\.$/);
  // The game Gemini never priced (Man United v Aston Villa): no Gemini verdict, a plain note.
  const un = buildScorecard([e(0.6, 0.5, null, 1, { geminiUnpriced: true }), e(0.4, 0.5, null, 0, { geminiUnpriced: true })]);
  assert.match(un.verdict, /Gemini listed this game but never priced it, so there is no Gemini comparison\.$/);
  assert.doesNotMatch(un.verdict, /out-called Gemini|Gemini still wins|Gemini priced \d/);
  assert.equal(un.gemini, null);
  // A game with a Gemini market where none of our questions was comparable.
  assert.match(buildScorecard([e(0.6, 0.5, null, 1, { geminiUnpriced: false })]).verdict, /Gemini priced none of the 1 questions\.$/);
  // Games with no Gemini mapping at all say nothing about Gemini.
  assert.doesNotMatch(buildScorecard([e(0.6, 0.5, null, 1)]).verdict, /Gemini/);
});

test("Man United v Aston Villa: Gemini note says it never traded; the verdict says there is nothing to compare", async () => {
  const lobby = await import("../lib/lobby.ts");
  const { kioskTouch } = await import("../lib/kiosk.ts");
  await kioskTouch("642", "game:epl-mun-avl", "http://x");
  await kioskTouch("642", "start", "http://x");
  let l = (await lobby.getKioskLobby("642"))!;
  const v = lobby.publicView(l, null, "http://x");
  assert.match(v.gemini?.note ?? "", /never traded/);
  await kioskTouch("642", "lock", "http://x");
  await kioskTouch("642", "resolve:yes", "http://x");
  l = (await lobby.getKioskLobby("642"))!;
  const sc = lobby.publicView(l, null, "http://x").scorecard;
  assert.equal(sc.n, 1);
  assert.match(sc.verdict, /never priced it, so there is no Gemini comparison/);
});

// ---------------------------------------------------------------- variety

test("variety: no question family twice in a row, at most MAX_PER_FAMILY a game, new templates are asked", () => {
  const seen = new Set<string>();
  for (const id of replayIds()) {
    const qs = simulate(id, { pregame: true }).slice(1); // the pregame winner is parked, not "in a row"
    for (let i = 1; i < qs.length; i++) assert.notEqual(familyOf(qs[i].templateId), familyOf(qs[i - 1].templateId), `${id}: ${qs[i - 1].text} then ${qs[i].text}`);
    const by = new Map<string, number>();
    for (const q of qs) by.set(familyOf(q.templateId), (by.get(familyOf(q.templateId)) ?? 0) + 1);
    for (const [f, n] of by) assert.ok(n <= MAX_PER_FAMILY, `${id}: ${f} asked ${n} times`);
    for (const q of qs) seen.add(q.templateId);
  }
  for (const t of ["nfl.scoring_drive", "nfl.field_goal", "nfl.next_score_td", "nfl.late_score", "nba.next_basket_three", "nba.lead_change", "soccer.corner_window", "soccer.sot_window", "soccer.card_window"]) {
    assert.ok(seen.has(t), `${t} is asked in at least one replay`);
  }
  assert.equal(varietyBlock({ askedTemplates: ["nfl.drive_result"] }, "nfl.red_zone_td"), "repeat", "touchdown questions are one family");
  assert.equal(varietyBlock({ askedTemplates: ["nfl.conversion", "x", "nfl.conversion", "y", "nfl.conversion", "z"] }, "nfl.conversion"), "cap");
  assert.equal(varietyBlock({ askedTemplates: ["nfl.conversion"] }, "nfl.scoring_drive"), null);
});

// ---------------------------------------------------------------- new resolvers

const YN = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
const mk = (type: string, params: Record<string, unknown>) => ({ templateId: "x", state: "locked" as const, createdAtSeq: 1, resolver: { type, params }, outcomes: YN, prior: {} });
function ev(sport: "nfl" | "nba" | "soccer", seq: number, type: string, extra: Record<string, unknown> = {}) {
  const { team, score, period, ...data } = extra as { team?: string; score?: [number, number]; period?: number };
  return { gameId: "g", sport, seq, clock: { period: period ?? 2, display: "5:00" }, type: type as never, team, data, score: { home: score?.[0] ?? 10, away: score?.[1] ?? 7 } };
}

test("NFL resolvers: scoring drive, field goal, turnover on the drive, next score type, late points", () => {
  const e = new HuddleQuestionEngine();
  const st = initialGameState("g", "nfl", { name: "Dallas Cowboys", short: "DAL" }, { name: "San Francisco 49ers", short: "SF" });
  const pts = mk("drive_result", { team: "DAL", yesOn: ["td", "fg"], startHome: 10, startAway: 7 });
  assert.equal(e.evaluate(pts, ev("nfl", 2, "play_result", { team: "DAL", playType: "run", gained: 4 }), st), null);
  assert.deepEqual(e.evaluate(pts, ev("nfl", 2, "play_result", { team: "DAL", playType: "kick", good: true, score: [13, 7] }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(pts, ev("nfl", 2, "play_result", { team: "DAL", playType: "punt" }), st), { outcome: "no" });
  assert.deepEqual(e.evaluate(pts, ev("nfl", 2, "drive_end", { team: "DAL", result: "td" }), st), { outcome: "yes" });
  const fg = mk("drive_result", { team: "DAL", yesOn: ["fg"], startHome: 10, startAway: 7 });
  assert.deepEqual(e.evaluate(fg, ev("nfl", 2, "play_result", { team: "DAL", playType: "pass", touchdown: true, score: [17, 7] }), st), { outcome: "no" });
  assert.deepEqual(e.evaluate(fg, ev("nfl", 2, "play_result", { team: "DAL", playType: "kick", good: true }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(fg, ev("nfl", 2, "play_result", { team: "DAL", playType: "kick", good: false }), st), { outcome: "no" });

  const to = mk("drive_turnover", { team: "DAL" });
  assert.equal(e.evaluate(to, ev("nfl", 2, "play_result", { team: "DAL", playType: "pass", gained: 8 }), st), null);
  assert.deepEqual(e.evaluate(to, ev("nfl", 2, "play_result", { team: "DAL", playType: "pass", turnover: true }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(to, ev("nfl", 2, "play_result", { team: "DAL", playType: "punt" }), st), { outcome: "no" });
  assert.deepEqual(e.evaluate(to, ev("nfl", 2, "drive_end", { team: "DAL", result: "downs" }), st), { outcome: "no" });
  assert.deepEqual(e.evaluate(to, ev("nfl", 2, "drive_end", { team: "DAL", result: "turnover" }), st), { outcome: "yes" });
  assert.equal(e.evaluate(to, ev("nfl", 2, "play_result", { team: "DAL", playType: "pass", turnover: true, noPlay: true }), st), null, "a penalty wipes it out");

  const ns = mk("next_score_type", { startHome: 10, startAway: 7 });
  assert.equal(e.evaluate(ns, ev("nfl", 2, "play_result", { team: "SF" }), st), null);
  assert.deepEqual(e.evaluate(ns, ev("nfl", 2, "play_result", { team: "SF", score: [10, 14] }), st), { outcome: "yes" }, "TD + PAT");
  assert.deepEqual(e.evaluate(ns, ev("nfl", 2, "play_result", { team: "SF", score: [10, 13] }), st), { outcome: "yes" }, "TD, missed PAT");
  assert.deepEqual(e.evaluate(ns, ev("nfl", 2, "play_result", { team: "DAL", score: [13, 7] }), st), { outcome: "no" }, "field goal");
  assert.deepEqual(e.evaluate(ns, ev("nfl", 2, "play_result", { team: "SF", score: [10, 9] }), st), { outcome: "no" }, "safety");
  assert.ok("void" in (e.evaluate(ns, ev("nfl", 2, "final", {}), st) ?? {}));

  const late = mk("score_change", { period: 2, startHome: 10, startAway: 7 });
  assert.equal(e.evaluate(late, ev("nfl", 2, "play_result", { team: "DAL" }), st), null);
  assert.deepEqual(e.evaluate(late, ev("nfl", 2, "play_result", { team: "DAL", score: [13, 7] }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(late, ev("nfl", 2, "period_end", { period: 2 }), st), { outcome: "no" });
});

test("NBA resolvers: next basket a three, lead change before the end of the quarter", () => {
  const e = new HuddleQuestionEngine();
  const st = initialGameState("g", "nba", { name: "LA Clippers", short: "LAC" }, { name: "Oklahoma City Thunder", short: "OKC" });
  const three = mk("next_basket_three", {});
  assert.equal(e.evaluate(three, ev("nba", 2, "shot", { team: "OKC", made: false, three: true }), st), null, "a miss does not count");
  assert.equal(e.evaluate(three, ev("nba", 2, "free_throw", { team: "OKC", made: true, points: 1 }), st), null, "free throws do not count");
  assert.deepEqual(e.evaluate(three, ev("nba", 2, "shot", { team: "OKC", made: true, points: 3, three: true }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(three, ev("nba", 2, "shot", { team: "LAC", made: true, points: 2, three: false }), st), { outcome: "no" });
  assert.ok("void" in (e.evaluate(three, ev("nba", 2, "period_end", { period: 2 }), st) ?? {}));

  const lc = mk("lead_change", { trailing: "away", period: 3 }); // OKC trails LAC
  assert.equal(e.evaluate(lc, ev("nba", 2, "shot", { period: 3, score: [80, 80] }), st), null, "a tie is not the lead");
  assert.deepEqual(e.evaluate(lc, ev("nba", 2, "shot", { period: 3, score: [80, 82] }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(lc, ev("nba", 2, "period_end", { period: 3, score: [84, 80] }), st), { outcome: "no" });
  // Priced from the margin: trailing by 2 with about 2 minutes left in a quarter is a real question.
  const s2 = { ...st, clock: { period: 3, display: "2:00" }, score: { home: 80, away: 78 } };
  const c = e.propose(ev("nba", 5, "shot", { period: 3, score: [80, 78], secondsRemaining: 720 + 120 }), s2, []).find((x) => x.templateId === "nba.lead_change");
  assert.ok(c && c.prior.yes > 0.15 && c.prior.yes < 0.6, JSON.stringify(c?.prior));
  assert.match(c!.question, /Will the Thunder take the lead before the end of the 3rd quarter\?/);
});

test("soccer resolvers: corner, shot on target and card windows in match minutes", () => {
  const e = new HuddleQuestionEngine();
  const st = initialGameState("g", "soccer", { name: "Manchester United", short: "MUN" }, { name: "Aston Villa", short: "AVL" });
  const corner = mk("event_window", { event: "corner", fromMinute: 30, untilMinute: 35 });
  assert.equal(e.evaluate(corner, ev("soccer", 2, "corner", { minute: 32, shotOnTarget: false }), st), null, "a corner's outcome line is not a new corner");
  assert.deepEqual(e.evaluate(corner, ev("soccer", 2, "corner", { minute: 34 }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(corner, ev("soccer", 2, "sub", { minute: 36 }), st), { outcome: "no" });
  assert.deepEqual(e.evaluate(corner, ev("soccer", 2, "corner", { minute: 36 }), st), { outcome: "no" }, "too late");
  const shot = mk("event_window", { event: "shot", fromMinute: 50, untilMinute: 55 });
  assert.equal(e.evaluate(shot, ev("soccer", 2, "score_update", { minute: 51, woodwork: true }), st), null);
  assert.deepEqual(e.evaluate(shot, ev("soccer", 2, "score_update", { minute: 52, shotOnTarget: true }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(shot, ev("soccer", 2, "goal", { minute: 55 }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(shot, ev("soccer", 2, "corner", { minute: 53, shotOnTarget: true }), st), { outcome: "yes" }, "a corner that ends in a shot on target");
  assert.equal(e.evaluate(shot, ev("soccer", 2, "corner", { minute: 53, shotOnTarget: false }), st), null);
  const card = mk("event_window", { event: "card", fromMinute: 60, untilMinute: 70 });
  assert.deepEqual(e.evaluate(card, ev("soccer", 2, "card", { minute: 69, color: "yellow" }), st), { outcome: "yes" });
  assert.deepEqual(e.evaluate(card, ev("soccer", 2, "period_end", { minute: 90 }), st), { outcome: "no" });
  // Windows never cross halftime.
  const s1 = { ...st, clock: { period: 1, display: "42'" }, minute: 42 };
  assert.ok(!e.propose(ev("soccer", 9, "corner", { minute: 42, period: 1, shotOnTarget: false }), s1, []).some((x) => x.templateId === "soccer.corner_window"));
});

// ---------------------------------------------------------------- ElevenLabs: a rejected key

test("ElevenLabs 401: the key is remembered as bad, TTS is not listed or served (no-key behaviour), then it recovers", async () => {
  const lobby = await import("../lib/lobby.ts");
  const { kioskTouch } = await import("../lib/kiosk.ts");
  const audio = await import("../app/api/kiosk/audio/route.ts");
  const ttsRoute = await import("../app/api/tts/route.ts");
  await kioskTouch("652", "game:nfl-sf-dal", "http://x");
  await kioskTouch("652", "start", "http://x");
  const l = (await lobby.getKioskLobby("652"))!;
  assert.ok((l.captions ?? []).length > 0);
  const list = async () => {
    const items: string[] = [];
    let after = 0;
    for (let i = 0; i < 40; i++) {
      const r = await (await audio.GET(new Request(`http://x/api/kiosk/audio?kiosk=652&after=${after}`))).json();
      if (!r.url) break;
      items.push(r.url);
      after = r.id;
    }
    return items;
  };
  process.env.ELEVENLABS_API_KEY = "sk-invalid-test-key";
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    calls++;
    assert.match(String(url), /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/[^/]+\/stream\?output_format=/);
    return new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), { status: 401, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await tts.resetTtsKeyCheck();
    assert.equal(await tts.ttsAvailable(), true);
    assert.ok((await list()).some((u) => u.includes("/api/tts?code=")), "a key is set: captions are listed");
    // The speaker fetches the first caption: ElevenLabs says 401.
    const first = await ttsRoute.GET(new Request(`http://x/api/tts?code=${l.code}&id=${l.captions![0].id}&format=wav`));
    assert.equal(first.status, 502);
    assert.equal(calls, 1);
    assert.equal(await tts.ttsKeyRejected(), true);
    assert.equal(await tts.ttsAvailable(), false);
    // From now on: exactly the no-key behaviour, and ElevenLabs is not asked again.
    const urls = await list();
    assert.ok(urls.length > 0 && urls.every((u) => u.endsWith(".wav") && !u.includes("/api/tts")), urls.join(" "));
    const again = await ttsRoute.GET(new Request(`http://x/api/tts?code=${l.code}&id=${l.captions![0].id}`));
    assert.equal(again.status, 204);
    assert.equal(again.headers.get("x-tts"), "rejected-key");
    await assert.rejects(tts.synthesize("Another line.", "nfl"), /rejected the API key/);
    assert.equal(calls, 1, "no more calls with a key known to be bad");
    // A few minutes later it tries again.
    assert.equal(await tts.ttsKeyRejected(Date.now() + tts.BAD_KEY_MS + 1000), false);
    // A different (new) key is not affected by the old key's rejection.
    process.env.ELEVENLABS_API_KEY = "sk-another-test-key";
    assert.equal(await tts.ttsAvailable(), true);
  } finally {
    globalThis.fetch = realFetch;
    await tts.resetTtsKeyCheck();
    delete process.env.ELEVENLABS_API_KEY;
  }
});
