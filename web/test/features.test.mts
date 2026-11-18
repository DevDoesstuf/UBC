// Tests for the Huddle features merged into Live Lines: captions, prior-start LMSR, Gemini mid rule,
// replay questions on a fake clock, pool and head-to-head settlement.
// Run with `npm test` (test/register.mjs resolves the app's "@/..." and extensionless imports).
import { test } from "node:test";
import assert from "node:assert/strict";

// Gemini is unreachable in tests (connection refused right away), so games fall back to their bundled snapshot.
process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;
const advance = (ms: number) => {
  clock += ms;
};

const { captionLine, money } = await import("../lib/announcer.ts");
const { quoteFromPrices, refForHint, toEvent } = await import("../lib/gemini.ts");
const { settlePool, fillOffer, settlePairs, takerStakeFor } = await import("../lib/modes.ts");
const { buildScorecard } = await import("../lib/scorecard.ts");
const lmsr = await import("../lib/lmsr.ts");
const lobby = await import("../lib/lobby.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");

type L = Awaited<ReturnType<typeof lobby.createLobby>>;
let kioskN = 100;

async function setup(game: string, mode?: "market" | "pool" | "h2h") {
  const kiosk = String(kioskN++);
  const l = await lobby.createLobby(kiosk, game, mode);
  const tokens: string[] = [];
  for (const name of ["Sam", "Alex"]) {
    let t = "";
    await lobby.mutate(l.code, (x, now) => {
      const p = lobby.join(x, name, now);
      t = p.token;
      lobby.creditDeposit(x, p.id, 5000, "demo", `demo-${p.id}`, now);
    });
    tokens.push(t);
  }
  return { code: l.code, kiosk, tokens };
}

const totalMoney = (l: L) => Object.values(l.players).reduce((a, p) => a + p.balance + p.withdrawn, 0) + l.housePnl;
const deposited = (l: L) => Object.values(l.players).reduce((a, p) => a + p.deposited, 0);

// ---------------------------------------------------------------- captions

test("captions: one line per event, numbers only from the event, deterministic", () => {
  const a = captionLine({ type: "result", outcome: "yes", winners: [{ name: "Sam", cents: 320 }] }, "nfl", "x");
  const b = captionLine({ type: "result", outcome: "yes", winners: [{ name: "Sam", cents: 320 }] }, "nfl", "x");
  assert.equal(a, b);
  assert.match(a!, /Sam/);
  assert.match(a!, /\$3\.20/);
  assert.equal(money(500), "$5");
  const start = captionLine({ type: "start", text: "Do the Cowboys convert on 3rd & 3?", yesPct: 53, modelPct: 53, gemini: { label: "Dallas", pct: 79.5 }, lockIn: 15 }, "nfl", "s")!;
  for (const n of start.match(/\d+(\.\d+)?/g) ?? []) assert.ok(["3", "3", "53", "80", "15"].includes(n), `invented number ${n} in "${start}"`);
  const upset = captionLine({ type: "result", outcome: "no", winners: [{ name: "Alex", cents: 900 }], atLockPct: 18 }, "soccer", "u")!;
  assert.match(upset, /18%/);
  // Never nudges anyone to chase losses.
  for (const p of ["nfl", "soccer", "calm"] as const) {
    for (const seed of ["a", "b", "c", "d"]) {
      const lines = [
        captionLine({ type: "result", outcome: "no", winners: [] }, p, seed),
        captionLine({ type: "lock", yesPct: 40 }, p, seed),
        captionLine({ type: "end", leader: { name: "Sam", cents: 250 }, verdict: "The room beat the model by 0.04 tonight" }, p, seed),
      ];
      for (const s of lines) assert.doesNotMatch(s ?? "", /win it back|chase|double down|bet more|cooked/i);
    }
  }
});

test("captions land in the lobby: join, start, lock, result, end", async () => {
  const { code, tokens } = await setup("football");
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 600, now));
  await lobby.mutate(code, (l) => lobby.lockMarket(l));
  await lobby.mutate(code, (l, now) => lobby.resolveMarket(l, "yes", now));
  await lobby.mutate(code, (l) => lobby.endSession(l));
  const l = (await lobby.getLobby(code))!;
  const v = lobby.publicView(l, null, "http://x");
  const kinds = (l.captions ?? []).map((c) => c.kind);
  for (const k of ["join", "start", "trade", "lock", "result", "end"]) assert.ok(kinds.includes(k), `no ${k} caption in ${kinds}`);
  assert.ok(v.captions.length <= 10);
  assert.ok(v.captions.every((c, i, a) => i === 0 || c.id > a[i - 1].id), "caption ids increase");
  assert.match(v.captions.find((c) => /takes|collects|cashes|pockets/.test(c.text))!.text, /Sam/);
});

// ---------------------------------------------------------------- prior-start LMSR

test("LMSR opens at the model prior and stays consistent", async () => {
  const b = 10;
  for (const p of [0.05, 0.22, 0.5, 0.83, 0.95]) {
    const qy = b * Math.log(p);
    const qn = b * Math.log(1 - p);
    assert.ok(Math.abs(lmsr.priceYes(qy, qn, b) - p) < 1e-12);
    assert.ok(Math.abs(lmsr.cost(qy, qn, b)) < 1e-9, "opening cost is zero");
    const s = lmsr.sharesForSpend("yes", 2, qy, qn, b);
    assert.ok(Math.abs(lmsr.costToBuy("yes", s, qy, qn, b) - 2) < 1e-9);
  }
  const { code } = await setup("football");
  const l = await lobby.mutate(code, (x, now) => lobby.openMarket(x, now));
  const v = lobby.publicView(l, null, "http://x");
  assert.equal(v.market!.yesCents, 5); // question 1 prior 0.05
  assert.equal(v.market!.model, 0.05);
  assert.equal(v.market!.mode, "market");
  assert.equal(v.game!.kind, "clip");
});

// ---------------------------------------------------------------- Gemini

test("Gemini mid rule: mid inside 10 cents, else last trade, else nothing", () => {
  assert.deepEqual(quoteFromPrices({ bestBid: "0.79", bestAsk: "0.80", lastTradePrice: "0.80" }), { prob: 0.795, source: "mid" });
  assert.deepEqual(quoteFromPrices({ bestBid: "0.40", bestAsk: "0.60", lastTradePrice: "0.55" }), { prob: 0.55, source: "last" });
  assert.deepEqual(quoteFromPrices({ bestBid: "0.46", bestAsk: "0.54" }), { prob: 0.5, source: "mid" });
  assert.deepEqual(quoteFromPrices({ bestBid: "0.40", bestAsk: "0.60" }), { prob: null, source: "unavailable" });
  assert.deepEqual(quoteFromPrices({ bestAsk: "0.3" }), { prob: null, source: "unavailable" });
  assert.deepEqual(quoteFromPrices({ bestBid: "1.5", bestAsk: "0.6", lastTradePrice: "0.2" }), { prob: 0.2, source: "last" });
  const ev = toEvent({ ticker: "NFL-2611221800-TEN-DAL-M", title: "Tennessee vs Dallas", contracts: [{ ticker: "DAL", label: "Dallas", prices: { bestBid: "0.79", bestAsk: "0.80" } }] });
  assert.equal(ev.kind, "moneyline");
  const total = toEvent({ ticker: "NFL-2611221800-TEN-DAL-T", contracts: [{ ticker: "O53", label: "More than 53.5 points scored", prices: { bestBid: "0.5", bestAsk: "0.6" } }] });
  const snap = { at: 1, asOf: "t", live: true, ok: true, events: [ev, total] };
  assert.equal(refForHint(snap, { kind: "moneyline" }, "DAL")!.prob, 0.795);
  assert.equal(refForHint(snap, { kind: "moneyline" }, "TEN"), null);
  assert.equal(refForHint(snap, { kind: "total", line: 53.5 })!.prob, 0.55);
  assert.equal(refForHint(snap, { kind: "total", line: 44.5 }), null);
});

test("scorecard: Brier for room, model and Gemini", () => {
  const sc = buildScorecard([
    { room: 0.8, model: 0.6, gemini: 0.7, outcome: 1 },
    { room: 0.3, model: 0.5, gemini: null, outcome: 0 },
  ]);
  assert.equal(sc.n, 2);
  assert.equal(sc.room, Math.round(((0.04 + 0.09) / 2) * 1000) / 1000);
  assert.equal(sc.model, Math.round(((0.16 + 0.25) / 2) * 1000) / 1000);
  assert.equal(sc.gemini, 0.09);
  assert.match(sc.verdict, /room beat the model/);
});

// ---------------------------------------------------------------- replay on a fake clock

test("replay: pregame Gemini question, engine questions on the game clock, settles exactly", async () => {
  const { code, kiosk, tokens } = await setup("nfl-replay");
  let l = (await lobby.getLobby(code))!;
  let v = lobby.publicView(l, tokens[0], "http://x");
  assert.equal(v.game!.kind, "replay");
  assert.equal(v.game!.score!.started, false);
  const total = v.questionCount;
  assert.ok(total >= 5, `expected a full script, got ${total}`);

  // Kiosk "Start": the pregame moneyline opens, priced from the model calibrated to Gemini, with Gemini's quote.
  await kioskTouch(kiosk, "start", "http://x");
  l = (await lobby.getLobby(code))!;
  v = lobby.publicView(l, tokens[0], "http://x");
  assert.equal(v.phase, "open");
  assert.match(v.market!.text, /Cowboys beat the Titans/);
  assert.ok(v.market!.gemini && Math.abs(v.market!.gemini.prob - 0.795) < 1e-9, "Gemini moneyline attached");
  assert.ok(Math.abs(v.market!.model! - 0.795) < 0.02, `model calibrated to Gemini, got ${v.market!.model}`);
  assert.equal(v.market!.yesCents, Math.round(v.market!.model! * 100));
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 500, now));
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "no", 300, now));

  // 20 s later it locks, is parked until the final whistle, and the clock starts on the first live question.
  advance(20_500);
  l = (await lobby.getLobby(code))!;
  v = lobby.publicView(l, tokens[0], "http://x");
  assert.equal(v.phase, "open");
  assert.ok(v.parked, "pregame question parked");
  assert.match(v.market!.text, /convert on 3rd & 3/);
  assert.equal(v.game!.score!.started, true);
  const screen = await kioskScreen(kiosk, "http://x");
  assert.equal(screen.screen, "market");
  assert.match(screen.title, new RegExp(`Question 2 of ${total}`));

  // Play the whole game, one poll per second, both players buying every question.
  const asked = new Set<string>([v.market!.text]);
  let lastKey = "";
  for (let s = 0; s < 330; s++) {
    advance(1000);
    l = (await lobby.getLobby(code))!;
    if (l.phase === "open" && l.market && l.market.questionId !== lastKey) {
      lastKey = l.market.questionId;
      asked.add(l.market.text);
      await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 200, now));
      await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "no", 200, now));
    }
    const sc = await kioskScreen(kiosk, "http://x");
    assert.ok(["lobby", "market", "locked", "result", "ended"].includes(sc.screen), sc.screen);
  }
  l = (await lobby.getLobby(code))!;
  v = lobby.publicView(l, tokens[0], "http://x");
  assert.equal(v.game!.score!.status, "final");
  assert.equal(`${v.game!.score!.homeScore}-${v.game!.score!.awayScore}`, "14-9");
  assert.equal(v.parked, null, "pregame settled at the final whistle");
  assert.ok(v.results.some((r) => /Cowboys beat the Titans/.test(r.text) && r.outcome === "yes"), "Cowboys won 14-9");
  assert.ok(asked.size >= 6, `asked ${asked.size}: ${[...asked].join(" | ")}`);
  assert.ok(l.results.length >= 6);
  assert.ok(v.scorecard.n >= 6 && v.scorecard.room !== null && v.scorecard.model !== null && v.scorecard.gemini !== null);
  assert.equal(totalMoney(l), deposited(l), "no cent created or lost");
  assert.ok(l.qIndex <= total);
});

test("replay: host taps still work (lock now, resolve by hand)", async () => {
  const { code, kiosk } = await setup("soccer-replay");
  await kioskTouch(kiosk, "start", "http://x");
  let l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "open");
  assert.match(l.market!.text, /Ronaldo/);
  await kioskTouch(kiosk, "lock", "http://x");
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "locked");
  await kioskTouch(kiosk, "resolve:no", "http://x");
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "result");
  assert.equal(l.market!.outcome, "no");
  // The engine does not resolve it a second time when the penalty result arrives.
  advance(60_000);
  l = (await lobby.getLobby(code))!;
  assert.equal(l.results.filter((r) => /Ronaldo/.test(r.text)).length, 1);
  assert.equal(totalMoney(l), deposited(l));
});

// ---------------------------------------------------------------- pool and head-to-head

test("pool settlement sums exactly (dust to house, refund when nobody won)", () => {
  const stakes = [
    { player: "a", side: "yes" as const, cents: 333 },
    { player: "b", side: "yes" as const, cents: 500 },
    { player: "c", side: "no" as const, cents: 701 },
  ];
  const s = settlePool(stakes, "yes");
  const paid = Object.values(s.payouts).reduce((a, b) => a + b, 0);
  assert.equal(paid + s.dust, 1534);
  assert.ok(s.dust >= 0 && s.dust < 2);
  assert.equal(s.payouts.a, Math.floor((333 * 1534) / 833));
  const r = settlePool(stakes.filter((x) => x.side === "yes"), "no");
  assert.equal(r.refunded, true);
  assert.deepEqual(r.payouts, { a: 333, b: 500 });
});

test("h2h fills: partial takes, exact pair settlement", () => {
  const offer = { cents: 1000, filled: 0, odds: 1.3 };
  assert.equal(takerStakeFor(1000, 1.3), 300);
  const f1 = fillOffer(offer, 100);
  assert.deepEqual(f1, { takerCents: 100, makerCents: 333, newFilled: 333, complete: false });
  const f2 = fillOffer({ ...offer, filled: f1.newFilled }, 5000);
  assert.equal(f2.makerCents, 667);
  assert.equal(f2.takerCents, takerStakeFor(667, 1.3));
  assert.equal(f2.complete, true);
  const pairs = [
    { offerId: "o", maker: "m", taker: "t1", side: "yes" as const, makerCents: 333, takerCents: 100 },
    { offerId: "o", maker: "m", taker: "t2", side: "yes" as const, makerCents: 667, takerCents: f2.takerCents },
  ];
  const yes = settlePairs(pairs, "yes");
  const no = settlePairs(pairs, "no");
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.equal(sum(yes), 1000 + 100 + f2.takerCents);
  assert.equal(sum(no), sum(yes));
  assert.equal(yes.m, sum(yes));
});

test("pool lobby: stakes via /buy, winners split the pot, money conserved", async () => {
  const { code, tokens } = await setup("football", "pool");
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 300, now));
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[1]), "no", 700, now));
  let l = (await lobby.getLobby(code))!;
  let v = lobby.publicView(l, tokens[0], "http://x");
  assert.equal(v.market!.mode, "pool");
  assert.deepEqual(v.market!.pool, { yesCents: 300, noCents: 700 });
  assert.equal(v.market!.yesCents, 30);
  assert.deepEqual(v.me!.stake, { yes: 300, no: 0 });
  l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "yes", now));
  v = lobby.publicView(l, tokens[0], "http://x");
  assert.deepEqual(v.market!.winners, [{ name: "Sam", cents: 1000 }]);
  assert.equal(totalMoney(l), deposited(l));
});

test("h2h lobby: offer, partial take, unmatched released at lock, winner takes both stakes", async () => {
  const { code, tokens } = await setup("football", "h2h");
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await assert.rejects(lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 300, now)), /head-to-head/);
  let offerId = "";
  await lobby.mutate(code, (l, now) => {
    offerId = lobby.makeOffer(l, lobby.requirePlayer(l, tokens[0]), "yes", 1000, 2.5, now).id;
  });
  await assert.rejects(lobby.mutate(code, (l, now) => lobby.takeOffer(l, lobby.requirePlayer(l, tokens[0]), offerId, 100, now)), /own offer/);
  await lobby.mutate(code, (l, now) => lobby.takeOffer(l, lobby.requirePlayer(l, tokens[1]), offerId, 600, now));
  let l = (await lobby.getLobby(code))!;
  let v = lobby.publicView(l, null, "http://x");
  const o = v.market!.offers![0];
  assert.equal(o.filled, 400);
  assert.equal(o.remaining, 600);
  assert.equal(o.takeCents, 900);
  assert.equal(v.market!.yesCents, 40); // backing YES at 2.50 implies 40%
  l = await lobby.mutate(code, (x) => lobby.lockMarket(x));
  assert.equal(l.players[l.order[0]].balance, 5000 - 400, "unmatched 600 released to the maker");
  l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "no", now));
  v = lobby.publicView(l, null, "http://x");
  assert.deepEqual(v.market!.winners, [{ name: "Alex", cents: 1000 }]);
  assert.equal(l.players[l.order[1]].balance, 5000 + 400);
  assert.equal(totalMoney(l), deposited(l));
});

// ---------------------------------------------------------------- "Call it" moments

test("moments: table per sport, short Latin-1 labels, momentsFor ids", async () => {
  for (const sport of ["nfl", "soccer"] as const) {
    const kinds = lobby.MOMENT_KINDS[sport];
    assert.ok(kinds.length >= 3 && kinds.length <= 4);
    for (const k of kinds) {
      assert.ok(k.label.length <= 12 && /^[\x20-\x7E\xA0-\xFF]+$/.test(k.label), k.label);
      const w = k.write({ state: null });
      assert.ok(w.prior > 0 && w.prior < 1, `${k.kind} prior ${w.prior}`);
    }
  }
  const { code } = await setup("soccer-replay");
  const l = (await lobby.getLobby(code))!;
  assert.deepEqual(lobby.momentsFor(l).map((m) => m.id), ["moment:penalty", "moment:corner", "moment:free_kick", "moment:next_goal"]);
});

test("moments: clip game opens at the model prior, host resolves, scripted question count unchanged", async () => {
  const { code, tokens } = await setup("football");
  let l = await lobby.mutate(code, (x, now) => lobby.openMoment(x, "moment:red_zone", now));
  let v = lobby.publicView(l, null, "http://x");
  assert.equal(v.phase, "open");
  assert.match(v.market!.text, /red-zone/);
  assert.ok(v.market!.model! > 0.4 && v.market!.model! < 0.75);
  assert.equal(v.market!.yesCents, Math.round(v.market!.model! * 100));
  assert.ok(v.market!.lockIn <= 25 && v.market!.lockIn >= 24);
  assert.equal(v.market!.moment, "red_zone");
  assert.match(l.captions!.at(-1)!.text, /^Red zone! /);
  await assert.rejects(lobby.mutate(code, (x, now) => lobby.openMoment(x, "big_play", now)), /current question/);
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 300, now));
  advance(26_000);
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "locked");
  l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "yes", now));
  assert.equal(l.qIndex, 0, "a called moment does not use up a scripted question");
  await assert.rejects(lobby.mutate(code, (x, now) => lobby.openMoment(x, "penalty", now)), /does not offer/);
  const screen = await kioskScreen(l.kioskId, "http://x");
  assert.equal(screen.screen, "result");
  assert.ok(screen.buttons.some((b) => b.id === "next"));
  assert.equal(totalMoney(l), deposited(l));
});

test("moments: replay game uses the engine's matching candidate, resolved by the play-by-play", async () => {
  const { code, kiosk, tokens } = await setup("soccer-replay");
  await kioskTouch(kiosk, "start", "http://x"); // Ronaldo penalty question opens (engine)
  await kioskTouch(kiosk, "lock", "http://x");
  await kioskTouch(kiosk, "resolve:yes", "http://x");
  // Wait for the corner at 100 s (replay time); the host calls it before the engine's own auto-open.
  let l = (await lobby.getLobby(code))!;
  const run = l.replay!;
  const cornerAt = run.startedAt! + 100_000;
  clock = cornerAt - 1000;
  l = (await lobby.getLobby(code))!;
  if (l.phase === "open") await kioskTouch(kiosk, "lock", "http://x");
  l = (await lobby.getLobby(code))!;
  if (l.phase === "locked") await kioskTouch(kiosk, "resolve:no", "http://x");
  // A template moment (no engine match) in a replay game: host-resolved; it also restarts the result hold.
  l = await lobby.mutate(code, (x, now) => lobby.openMoment(x, "free_kick", now));
  assert.equal(l.market!.source!.kind, "moment");
  await kioskTouch(kiosk, "resolve:no", "http://x");
  // The corner is awarded 1 s later, inside the 5 s result hold, so the host's call is what opens it.
  clock = cornerAt + 200;
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "result");
  l = await lobby.mutate(code, (x, now) => lobby.openMoment(x, "corner", now));
  assert.equal(l.market!.source!.kind, "replay");
  assert.match(l.market!.text, /corner/);
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "yes", 300, now));
  advance(30_000); // the corner outcome (shot on target) arrives at 124 s
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "result");
  assert.equal(l.market!.outcome, "yes");
  assert.equal(totalMoney(l), deposited(l));
});

test.after(() => {
  Date.now = realNow;
});
