// Real replayed games, the NBA question engine, Gemini price history / settled fallback / discovery, and the
// ElevenLabs request (against a mock). Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9"; // unreachable: nothing in here may need the live API
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.ELEVENLABS_API_KEY;

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

const { getTimeline, replayIds, buildTimeline, wallAt } = await import("../lib/replay/timeline.ts");
const { HuddleQuestionEngine } = await import("../lib/replay/engine.ts");
const { reduce, nbaSecondsRemaining } = await import("../lib/replay/reduce.ts");
const { initialGameState } = await import("../lib/replay/types.ts");
const { simulate } = await import("../lib/replay/run.ts");
const nba = await import("../lib/replay/nba.ts");
const gem = await import("../lib/gemini.ts");
const lobby = await import("../lib/lobby.ts");
const { allGames, getGame } = await import("../lib/games.ts");
const builder = await import("../scripts/build-replays.mjs");
const tts = await import("../lib/tts.ts");

const REAL = ["replay-sf-dal", "replay-lac-bal", "replay-mia-ind", "replay-avl-mun", "replay-okc-lac"];

// ---------------------------------------------------------------- timeline conversion

test("real replays: valid timelines, real metadata, final score matches ESPN, 5-8 minutes of demo", () => {
  for (const id of REAL) {
    assert.ok(replayIds().includes(id), id);
    const t = getTimeline(id)!;
    assert.equal(t.meta.real, true, id);
    assert.match(t.meta.date ?? "", /^2026-11-\d\d$/, id);
    assert.equal(t.meta.source?.provider, "ESPN");
    assert.ok(t.info.durationMs >= 300_000 && t.info.durationMs <= 480_000, `${id} lasts ${t.info.durationMs}`);
    let prev = -1;
    for (const e of t.events) {
      assert.ok(e.atMs >= prev, `${id} events in order`);
      prev = e.atMs;
    }
    const last = t.events[t.events.length - 1].event;
    assert.equal(last.type, "final");
    // Fold the whole game: the reducer ends on the real final score, game over.
    let s = initialGameState(t.info.id, t.info.sport, t.info.home, t.info.away);
    for (const { event } of t.events) s = reduce(s, event);
    assert.equal(s.status, "final");
    const file = (t as unknown as { events: { wallMs?: number }[] }).events.filter((e) => e.wallMs !== undefined).length;
    assert.ok(file > t.events.length * 0.8, `${id}: most events carry the real wall-clock time`);
  }
  // Known finals (home-away): Cowboys 40-46 49ers, Ravens 20-23 Chargers, Colts 24-22 Dolphins, Man Utd 4-4 Villa, Clippers 113-112 Thunder.
  const finals: Record<string, [number, number]> = { "replay-sf-dal": [40, 46], "replay-lac-bal": [20, 23], "replay-mia-ind": [24, 22], "replay-avl-mun": [4, 4], "replay-okc-lac": [113, 112] };
  for (const [id, [h, a]] of Object.entries(finals)) {
    const ev = getTimeline(id)!.events.at(-1)!.event;
    assert.deepEqual([ev.score.home, ev.score.away], [h, a], id);
  }
});

test("build script: scheduling fits the target and gives dwell time; Gemini candles interpolate; play types", () => {
  const raw = [
    { type: "kickoff", fixed: 3000 },
    { type: "play_result" },
    { type: "snap", dwell: 14500, fixed: 0 },
    { type: "play_result", weight: 2 },
    { type: "final", fixed: 3000 },
  ];
  const out = builder.schedule(raw, 30_000);
  assert.equal(out[0].atMs, 2000);
  assert.ok(out[3].atMs - out[2].atMs >= 14500, "the 3rd down gets its trading window");
  assert.ok(out.every((e: { dwell?: number; weight?: number }) => e.dwell === undefined && e.weight === undefined));
  // 5 minute candles [start, open, high, low, close]: before the first one there is no price; inside one we
  // interpolate open -> close; after it we hold the close.
  const c = [[0, 0.4, 0.5, 0.4, 0.5], [300_000, 0.5, 0.7, 0.5, 0.7]];
  assert.equal(builder.priceAt(c, -1), null);
  assert.equal(builder.priceAt(c, 150_000), 0.45);
  assert.equal(builder.priceAt(c, 299_999 + 300_001), 0.7);
  assert.equal(builder.classify("Pass Reception").playType, "pass");
  assert.equal(builder.classify("Rushing Touchdown").playType, "run");
  assert.equal(builder.classify("Field Goal Good").playType, "kick");
  assert.equal(builder.classify("Fumble Recovery (Own)", "B.Purdy sacked").playType, "pass");
  assert.equal(builder.classify("Timeout").playType, undefined);
});

test("NBA timeline: clocks under a minute ('32.3') and over time parse", () => {
  assert.equal(nbaSecondsRemaining(1, "12:00"), 2880);
  assert.equal(nbaSecondsRemaining(4, "1:05"), 65);
  assert.equal(nbaSecondsRemaining(4, "32.3"), 32);
  assert.equal(nbaSecondsRemaining(5, "4:00"), 240);
  const t = buildTimeline({
    id: "t-nba", sport: "nba", title: "A at B", home: { name: "B Bees", short: "BBB" }, away: { name: "A Ants", short: "AAA" },
    events: [
      { atMs: 0, type: "kickoff", period: 1, clock: "12:00", score: [0, 0] },
      { atMs: 1000, type: "shot", clock: "45.0", period: 4, team: "BBB", data: { made: true, points: 3, three: true }, score: [3, 0], wall: "2026-11-14T05:00:00Z" },
      { atMs: 2000, type: "final", score: [3, 0] },
    ],
  });
  assert.equal(t.events[1].event.data.secondsRemaining, 45);
  assert.equal(t.events[1].wallMs, Date.parse("2026-11-14T05:00:00Z"));
  assert.equal(wallAt(t, 1500), Date.parse("2026-11-14T05:00:00Z"));
});

// ---------------------------------------------------------------- NBA resolvers and priors

function nbaEvent(seq: number, type: string, extra: Record<string, unknown> = {}) {
  const { team, player, score, period, ...data } = extra as { team?: string; player?: string; score?: [number, number]; period?: number };
  return {
    gameId: "g", sport: "nba" as const, seq, clock: { period: period ?? 4, display: "1:00" }, type: type as never, team, player,
    data: { secondsRemaining: 60, ...data }, score: { home: score?.[0] ?? 100, away: score?.[1] ?? 98 },
  };
}

test("NBA resolvers: free-throw trip, next score, three window, quarter winner, crunch time", () => {
  const e = new HuddleQuestionEngine();
  const home = { name: "LA Clippers", short: "LAC" };
  const away = { name: "Oklahoma City Thunder", short: "OKC" };
  const state = initialGameState("g", "nba", home, away);
  const mk = (type: string, params: Record<string, unknown>, outcomes = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]) =>
    ({ templateId: "x", state: "locked" as const, createdAtSeq: 1, resolver: { type, params }, outcomes, prior: {} });

  const ft = mk("ft_trip", { player: "Shai", team: "OKC", attempts: 2 });
  assert.equal(e.evaluate(ft, nbaEvent(2, "free_throw", { team: "OKC", player: "Shai", made: true, n: 1, of: 2 }), state), null);
  assert.deepEqual(e.evaluate(ft, nbaEvent(3, "free_throw", { team: "OKC", player: "Shai", made: true, n: 2, of: 2 }), state), { outcome: "yes" });
  assert.deepEqual(e.evaluate(ft, nbaEvent(3, "free_throw", { team: "OKC", player: "Shai", made: false, n: 1, of: 2 }), state), { outcome: "no" });
  assert.equal(e.evaluate(ft, nbaEvent(3, "free_throw", { team: "LAC", player: "Other", made: false, n: 1, of: 2 }), state), null, "someone else's free throw");

  const ns = mk("next_score", { team: "OKC" });
  assert.equal(e.evaluate(ns, nbaEvent(2, "shot", { team: "OKC", made: false, points: 0 }), state), null);
  assert.deepEqual(e.evaluate(ns, nbaEvent(3, "shot", { team: "LAC", made: true, points: 2 }), state), { outcome: "no" });
  assert.deepEqual(e.evaluate(ns, nbaEvent(3, "free_throw", { team: "OKC", made: true, points: 1 }), state), { outcome: "yes" });
  assert.ok("void" in (e.evaluate(ns, nbaEvent(3, "period_end", { period: 4 }), state) as object));

  const three = mk("three_window", { period: 2, untilSecs: 600 });
  assert.deepEqual(e.evaluate(three, nbaEvent(2, "shot", { period: 2, team: "LAC", made: true, three: true, secondsRemaining: 2 * 720 + 660 }), state), { outcome: "yes" });
  assert.deepEqual(e.evaluate(three, nbaEvent(2, "shot", { period: 2, team: "LAC", made: true, three: false, secondsRemaining: 2 * 720 + 590 }), state), { outcome: "no" });
  assert.equal(e.evaluate(three, nbaEvent(2, "shot", { period: 2, team: "LAC", made: false, three: true, secondsRemaining: 2 * 720 + 650 }), state), null);

  const q = mk("period_winner", { periods: [4], startHome: 90, startAway: 90 }, [{ id: "home", label: "LAC" }, { id: "tie", label: "Tie" }, { id: "away", label: "OKC" }]);
  assert.deepEqual(e.evaluate(q, nbaEvent(2, "period_end", { period: 4, score: [113, 112] }), state), { outcome: "home" });

  const clutch = mk("match_winner", { leader: "home" }, [{ id: "home", label: "LAC" }, { id: "away", label: "OKC" }]);
  assert.equal(e.evaluate(clutch, nbaEvent(2, "shot", { team: "OKC", made: false }), state), null);
  assert.deepEqual(e.evaluate(clutch, nbaEvent(3, "final", { score: [113, 112] }), state), { outcome: "home" });
});

test("NBA priors are sensible: FT both ~61%, next score with the ball ~68%, win prob tightens late", () => {
  assert.ok(Math.abs(nba.ftAllProb(2) - 0.6084) < 1e-9);
  assert.ok(nba.nextScoreProb() > 0.6 && nba.nextScoreProb() < 0.75);
  const s = nba.defaultNbaStrength();
  assert.ok(nba.nbaWinProb(s, 0, 2880) > 0.5 && nba.nbaWinProb(s, 0, 2880) < 0.6, "home edge at tip-off");
  assert.ok(nba.nbaWinProb(s, 3, 30) > 0.9, "up 3 with 30 s left");
  assert.ok(nba.nbaWinProb(s, -3, 30) < 0.1);
  const p = nba.nbaQuarterProbs(s, 0, 150);
  assert.ok(Math.abs(p.home + p.tie + p.away - 1) < 1e-9 && p.tie > 0.05);
  assert.ok(nba.nbaTotalOverProb(s, 220.5, 221, 100) === 1);
});

test("every real game asks real questions and settles them from the play-by-play", () => {
  for (const id of REAL) {
    const asked = simulate(id, { pregame: true });
    assert.ok(asked.length >= 8, `${id} asks ${asked.length}`);
    const kinds = new Set(asked.map((q) => q.templateId));
    if (id === "replay-okc-lac") assert.ok(kinds.has("nba.ft_trip") && kinds.has("nba.next_score"), [...kinds].join());
    if (id === "replay-avl-mun") assert.ok(kinds.has("soccer.penalty"), [...kinds].join());
    if (id.startsWith("replay-") && getTimeline(id)!.info.sport === "nfl") assert.ok(kinds.has("nfl.conversion"), `${id}: ${[...kinds].join()}`);
    for (const q of asked) assert.ok(q.yesPrior >= 0.05 && q.yesPrior <= 0.95);
  }
});

// ---------------------------------------------------------------- Gemini

test("Gemini history: snapshot at replay time is Gemini's real price then; pregame before the first point", () => {
  const t = getTimeline("replay-sf-dal")!;
  const g = t.gemini!;
  assert.equal(g.event, "NFL-2611152125-SF-DAL");
  const pre = gem.replaySnapshotAt(g, 0, null)!;
  assert.equal(pre.source, "replay");
  assert.equal(pre.live, false);
  assert.equal(pre.asOf, g.snapshot!.asOf);
  const dal0 = gem.refForHint(pre, { kind: "moneyline" }, "DAL")!;
  assert.equal(dal0.prob, 0.37);
  assert.equal(dal0.source, "replay");
  // Late in the game the price is the real one at that play (SF won; Gemini had SF far ahead near the end).
  const lateMs = t.events[t.events.length - 3].atMs;
  const late = gem.replaySnapshotAt(g, lateMs, wallAt(t, lateMs))!;
  const sfLate = gem.refForHint(late, { kind: "moneyline" }, "SF")!.prob;
  assert.ok(sfLate > 0.8, `SF late ${sfLate}`);
  assert.equal(late.asOf, new Date(wallAt(t, lateMs)!).toISOString());
  assert.match(late.note!, /real price at this moment/);
  assert.equal(gem.seriesAt([[10, 0.2], [20, 0.3]], 5), undefined);
  assert.equal(gem.seriesAt([[10, 0.2], [20, 0.3]], 15), 0.2);
  assert.equal(gem.seriesAt([[10, 0.2], [20, 0.3]], 25), 0.3);
  const track = gem.replayMoneylineTrack(g, "DAL", lateMs, 20);
  assert.ok(track.length > 2 && track.length <= 20);
  assert.ok(track.every((p, i) => i === 0 || p.t >= track[i - 1].t));
});

test("Gemini settled fallback: no network call, stored pregame prices with a note", async () => {
  const cfg = getGame("nfl-lac-bal")!.gemini!;
  assert.ok(cfg.settledAt && gem.isSettled(cfg));
  let called = 0;
  const snap = await gem.geminiForGame(cfg, Date.now(), { fetch: async () => { called++; throw new Error("no"); } });
  assert.equal(called, 0);
  assert.equal(snap!.source, "snapshot");
  assert.match(snap!.note!, /settled/);
  assert.ok(gem.refForHint(snap, { kind: "moneyline" }, "BAL")!.prob > 0.6);
  // An unsettled game whose API is down falls back to its stored snapshot and says so.
  const ten = getGame("nfl-replay")!.gemini!;
  const down = await gem.geminiForGame(ten, Date.now() + 1, { fetch: async () => { throw new Error("connection refused"); } });
  assert.equal(down!.live, false);
  assert.equal(down!.source, "snapshot");
  assert.match(down!.note!, /could not be reached|refreshing/);
});

test("Gemini discovery: moneylines only, both sides priced, pages, last good list when down", async () => {
  const ev = (t: string, home: string, away: string, hp: string, ap: string) => ({
    ticker: t, title: `${away} vs ${home}`, startTime: "2026-11-22T18:00:00.000Z", volume: "12.5",
    participants: [{ name: home, abbreviation: home, side: "home" }, { name: away, abbreviation: away, side: "away" }],
    contracts: [{ ticker: home, label: home, prices: { bestBid: hp, bestAsk: hp } }, { ticker: away, label: away, prices: { bestBid: ap, bestAsk: ap } }],
  });
  const pages: Record<string, unknown> = {
    "0": { data: [ev("NFL-2611221800-TEN-DAL-M", "DAL", "TEN", "0.80", "0.20"), { ticker: "NFL-2611221800-TEN-DAL-T", contracts: [] }], pagination: { total: 250 } },
    "200": { data: [ev("NFL-2611231800-MIN-SF-M", "SF", "MIN", "0.55", "0.45")], pagination: { total: 250 } },
  };
  const fetchOk = async (url: string) => {
    const off = new URL(url).searchParams.get("offset") ?? "0";
    return new Response(JSON.stringify(pages[off] ?? { data: [] }), { status: 200 });
  };
  const d = await gem.discoverMarkets({ leagues: ["NFL"], fetch: fetchOk as never, now: 1_000_000 });
  assert.equal(d.live, true);
  assert.deepEqual(d.games.map((g) => g.base), ["NFL-2611221800-TEN-DAL", "NFL-2611231800-MIN-SF"]);
  assert.equal(d.games[0].home!.prob, 0.8);
  assert.equal(d.games[0].away!.code, "TEN");
  const down = await gem.discoverMarkets({ leagues: ["NFL"], fetch: (async () => { throw new Error("down"); }) as never, now: 1_000_000 + 10 * 60_000 });
  assert.equal(down.live, false);
  assert.equal(down.source, "snapshot");
  assert.equal(down.games.length, 2);
});

test("lobby on a real game: Gemini follows the replay, price at open recorded, room vs Gemini trail, view block", async () => {
  const l = await lobby.createLobby("44", "nfl-sf-dal");
  assert.equal(l.gemini?.source, "replay");
  let token = "";
  await lobby.mutate(l.code, (x, now) => {
    const p = lobby.join(x, "Sam", now);
    token = p.token;
    lobby.creditDeposit(x, p.id, 2000, "demo", "d1", now);
  });
  let v = await lobby.mutate(l.code, (x, now) => lobby.openMarket(x, now));
  assert.equal(v.market!.text, "Will the Cowboys beat the 49ers?");
  assert.equal(v.market!.geminiAtOpen, 0.37, "Gemini's real pregame price for DAL");
  await lobby.mutate(l.code, (x, now) => {
    lobby.buy(x, lobby.requirePlayer(x, token), "yes", 500, now);
  });
  advance(21_000); // pregame locks, the clock starts
  v = (await lobby.getLobby(l.code))!;
  for (let i = 0; i < 120; i++) {
    advance(1000);
    v = (await lobby.getLobby(l.code))!;
  }
  const view = lobby.publicView(v, token, "http://x");
  assert.equal(view.game!.real, true);
  assert.equal(view.game!.league, "NFL");
  assert.equal(view.game!.date, "2026-11-15");
  assert.equal(view.gemini!.source, "replay");
  assert.equal(view.gemini!.settled, true);
  assert.ok(view.gemini!.track.length > 1, "Gemini home-win track over the replay");
  assert.ok(view.gemini!.asOf > "2026-11-15T21:25:00", `asOf follows the real game: ${view.gemini!.asOf}`);
  assert.ok(view.gemini!.moneyline!.home.prob !== null);
  assert.ok(view.parked, "the pregame question is parked until the final whistle");
  const parked = v.replay!.parkedMarket!;
  assert.ok((parked.trail ?? []).length >= 3, "open, trade, lock");
  assert.equal(parked.trail![0].gemini, 0.37);
  assert.ok(parked.trail!.some((p) => p.room > 0.37), "the room moved after Sam's buy");
  assert.ok(view.market === null || Array.isArray(view.market.trail));
  for (const g of allGames().filter((g) => g.real)) assert.ok(g.gemini?.event, `${g.id} maps to Gemini`);
});

// ---------------------------------------------------------------- ElevenLabs (mock)

test("ElevenLabs request matches the API reference; MP3 and 22 kHz WAV", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  try {
    const seen: { url: string; init: RequestInit }[] = [];
    const mock = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const r = await tts.synthesize("Touchdown, Cowboys!", "nfl", { fetch: mock });
    assert.equal(r.contentType, "audio/mpeg");
    const u = new URL(seen[0].url);
    assert.equal(u.origin + u.pathname, "https://api.elevenlabs.io/v1/text-to-speech/nPczCjzI2devNBz1zQrb/stream");
    assert.equal(u.searchParams.get("output_format"), "mp3_44100_128");
    const h = seen[0].init.headers as Record<string, string>;
    assert.equal(h["xi-api-key"], "test-key");
    assert.equal(seen[0].init.method, "POST");
    const body = JSON.parse(String(seen[0].init.body));
    assert.equal(body.text, "Touchdown, Cowboys!");
    assert.equal(body.model_id, "eleven_flash_v2_5");
    assert.deepEqual(Object.keys(body.voice_settings).sort(), ["similarity_boost", "speed", "stability", "style", "use_speaker_boost"]);
    const again = await tts.synthesize("Touchdown, Cowboys!", "nfl", { fetch: mock });
    assert.equal(again.cached, true);
    assert.equal(seen.length, 1, "cached by hash");
    const w = await tts.synthesize("Corner to Villa.", "soccer", { fetch: mock, format: "wav" });
    assert.equal(new URL(seen[1].url).searchParams.get("output_format"), "pcm_22050");
    assert.equal(Buffer.from(w.audio.slice(0, 4)).toString(), "RIFF");
    assert.equal(new DataView(w.audio.buffer).getUint32(24, true), 22050);
    const bad = (async () => new Response(JSON.stringify({ detail: "invalid_api_key" }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(tts.synthesize("Another line.", "calm", { fetch: bad }), /ElevenLabs HTTP 401/);
  } finally {
    delete process.env.ELEVENLABS_API_KEY;
  }
});
