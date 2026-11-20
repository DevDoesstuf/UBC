// The box "pages" (odds graph, odds board, standings under the market / locked / result view) and the Solana
// Pay card: new optional fields only, every v1 field unchanged, integers 0-100, Latin-1, small JSON.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const lobby = await import("../lib/lobby.ts");
const { kioskScreen, kioskTouch, chartOf, oddsOf, downsample, payOf, CHART_POINTS, ODDS_POINTS, MAX_ODDS, PAY_PAID_MS, PAY_QR_MAX } = await import("../lib/kiosk.ts");
const QRCode = (await import("qrcode")).default;

const LATIN1 = /^[\x20-\x7E\xA0-\xFF]*$/;
const pct = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;
const V1_MARKET = ["buttons", "color", "footer", "history", "kiosk", "lockIn", "move", "no", "question", "screen", "subtitle", "title", "traded", "yes"];

// A Solana Pay transfer request as lib/solana.ts writes it (about 230 characters).
const PAY_URL =
  "solana:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin?amount=5&spl-token=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" +
  "&reference=7ZXq9h5yH2r4cQm2aNHbF1rjuXyDGaBm7qkQ2iTqZ8yS&label=Huddle&message=Huddle%20lobby%20ABCD&memo=huddle-ABCD";

function checkChart(c: NonNullable<Awaited<ReturnType<typeof kioskScreen>>["chart"]>) {
  assert.ok(c.room.length >= 2 && c.room.length <= CHART_POINTS, `room points ${c.room.length}`);
  assert.ok(c.room.every(pct), "room 0-100 integers");
  if (c.gemini) {
    assert.equal(c.gemini.length, c.room.length);
    assert.ok(c.gemini.every((g) => g === null || pct(g)));
  }
  assert.ok(pct(c.span));
  assert.ok(c.lock === null || pct(c.lock));
  assert.ok(c.model === null || pct(c.model));
  assert.ok(LATIN1.test(c.x0 + c.x1));
}

test("pages: market, locked and result carry the odds graph, the odds board and standings; v1 fields stay", async () => {
  const kiosk = "931";
  await kioskTouch(kiosk, "game:nfl-sf-dal", "http://x");
  await kioskTouch(kiosk, "mode:market", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  const tokens: string[] = [];
  for (const name of ["Sam", "Priya", "Zoë"]) {
    await lobby.mutate(code, (x, now) => {
      const p = lobby.join(x, name, now);
      tokens.push(p.token);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    });
  }
  let s = await kioskTouch(kiosk, "start", "http://x");
  assert.equal(s.screen, "market");
  for (const key of V1_MARKET) assert.ok(key in s, `v1 field ${key}`);
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 300, now));
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "no", 200, now + 1500));
  s = await kioskScreen(kiosk, "http://x");
  checkChart(s.chart!);
  assert.equal(s.chart!.lock, 100, "open: the lock is the end of the axis");
  assert.equal(s.chart!.x1, "Lock");
  assert.equal(s.chart!.outcome, null);
  assert.equal(s.chart!.room[s.chart!.room.length - 1], s.yes, "the line ends on the live price");
  // Pregame question on a real game: Gemini's moneyline is the comparable market.
  assert.ok(s.chart!.gemini?.some((g) => g !== null), "Gemini's line is in the chart");
  // Odds board: the room's question first, then Gemini's markets in our names.
  assert.equal(s.odds![0].source, "room");
  assert.equal(s.odds![0].p, s.yes);
  assert.ok(s.odds!.length <= MAX_ODDS);
  const gem = s.odds!.filter((o) => o.source === "gemini");
  assert.ok(gem.some((o) => o.label === "49ers to win") && gem.some((o) => o.label === "Cowboys to win"), gem.map((o) => o.label).join(" | "));
  assert.ok(gem.some((o) => /^Over \d+(\.\d)? points/.test(o.label)), "the total line");
  for (const o of s.odds!) {
    assert.ok(pct(o.p) && LATIN1.test(o.label) && o.label.length <= 80, o.label);
    if (o.hist) assert.ok(o.hist.length <= ODDS_POINTS && o.hist.every(pct));
  }
  assert.ok(LATIN1.test(s.oddsNote ?? ""));
  assert.deepEqual(s.standings!.map((p) => p.name).sort(), ["Priya", "Sam", "Zoë"].sort());
  assert.ok(s.standings!.every((p) => Number.isInteger(p.cents) && p.rank >= 1));
  // The whole screen stays small for the ESP32 (it parses this every second).
  assert.ok(JSON.stringify(s).length < 12_000, `market JSON ${JSON.stringify(s).length} bytes`);
});

test("pages: locked and result (a clip game the host settles)", async () => {
  const kiosk = "935";
  await kioskTouch(kiosk, "game:football", "http://x");
  await kioskTouch(kiosk, "mode:market", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  const tokens: string[] = [];
  for (const name of ["Sam", "Priya"]) {
    await lobby.mutate(code, (x, now) => {
      const p = lobby.join(x, name, now);
      tokens.push(p.token);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    });
  }
  let s = await kioskTouch(kiosk, "start", "http://x");
  assert.equal(s.screen, "market");
  checkChart(s.chart!);
  assert.equal(s.chart!.gemini, undefined, "no Gemini line without a Gemini market");
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 300, now));
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "no", 200, now + 1500));

  s = await kioskTouch(kiosk, "lock", "http://x");
  assert.equal(s.screen, "locked");
  checkChart(s.chart!);
  assert.ok(typeof s.chart!.lock === "number");
  assert.equal(s.chart!.x1, "Now");
  assert.equal(s.odds![0].source, "room");

  s = await kioskTouch(kiosk, "resolve:yes", "http://x");
  assert.equal(s.screen, "result");
  checkChart(s.chart!);
  assert.equal(s.chart!.outcome, "YES");
  assert.equal(s.chart!.x1, "Result");
  assert.ok(s.odds!.every((o) => o.source === "gemini"), "no open question on the result");
  assert.ok(LATIN1.test(s.oddsNote ?? ""));
  assert.deepEqual(s.trades!.map((t) => [t.name, t.side, t.cents]), [["Priya", "no", 200], ["Sam", "yes", 300]]);
  assert.equal(s.standings![0].name, "Sam");
  assert.ok(s.lines!.length >= 1 && s.result === "YES", "v1 result fields stay");

  // Lobby and ended screens get no page fields.
  s = await kioskTouch(kiosk, "end", "http://x");
  assert.equal(s.chart, undefined);
  assert.equal(s.odds, undefined);
});

test("pages: Gemini rows carry the real price history once the replay clock runs", async () => {
  const kiosk = "932";
  await kioskTouch(kiosk, "game:nfl-sf-dal", "http://x");
  await kioskTouch(kiosk, "mode:market", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  await kioskTouch(kiosk, "start", "http://x");
  const l = structuredClone((await lobby.getLobby(code))!);
  const now = Date.now();
  l.replay!.startedAt = now - 4 * 60_000; // four minutes into the replay
  const { odds } = oddsOf(l, chartOf(l, now), now);
  const withHist = odds.filter((o) => o.source === "gemini" && o.hist);
  assert.ok(withHist.length >= 2, odds.map((o) => `${o.label}:${o.hist?.length ?? 0}`).join(" | "));
  for (const o of withHist) assert.ok(o.hist!.length >= 2 && o.hist!.length <= ODDS_POINTS && o.hist!.every(pct));
  // Before the clock starts there is no history to draw.
  l.replay!.startedAt = null;
  assert.ok(oddsOf(l, undefined, now).odds.every((o) => !o.hist || o.source === "room"));
});

test("pages: chart sampling is capped, older markets without a trail still draw", async () => {
  assert.deepEqual(downsample([1, 2, 3], 60), [1, 2, 3]);
  const d = downsample(Array.from({ length: 200 }, (_, i) => i), 60);
  assert.equal(d.length, 60);
  assert.equal(d[0], 0);
  assert.equal(d[59], 199);
  const kiosk = "933";
  await kioskTouch(kiosk, "game:football", "http://x");
  await kioskTouch(kiosk, "mode:market", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  await kioskTouch(kiosk, "start", "http://x");
  const l = structuredClone((await lobby.getLobby(code))!);
  delete l.market!.trail;
  l.market!.history = Array.from({ length: 150 }, (_, i) => 0.3 + (i % 10) / 50);
  const c = chartOf(l)!;
  assert.equal(c.room.length, CHART_POINTS);
  assert.ok(c.room.every(pct) && c.gemini === undefined);
  // A long open question: never more than CHART_POINTS samples.
  const l2 = structuredClone((await lobby.getLobby(code))!);
  l2.market!.openedAt -= 20 * 60_000;
  assert.ok(chartOf(l2)!.room.length <= CHART_POINTS);
});

test("pay: the Solana Pay card while lobby.boxPay is live, ECC L QR, paid state, pay:close clears it", async () => {
  const kiosk = "934";
  await kioskTouch(kiosk, "game:football", "http://x");
  await kioskTouch(kiosk, "mode:market", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  let s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.pay, undefined, "no card without a request");
  const now = Date.now();
  await lobby.mutate(code, (l) => {
    l.boxPay = { playerId: "p1", name: "Zoë “Z” Łuk", cents: 500, url: PAY_URL, reference: "ref1", at: now, until: now + 5 * 60_000, paidAt: null };
  });
  s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.screen, "lobby", "the card sits on top of whatever screen is up");
  const pay = s.pay!;
  assert.equal(pay.cents, 500);
  assert.equal(pay.paid, false);
  assert.ok(LATIN1.test(pay.name), pay.name);
  assert.ok(pay.leftMs > 4 * 60_000 && pay.leftMs <= 5 * 60_000);
  assert.equal(pay.until, now + 5 * 60_000);
  const want = QRCode.create(PAY_URL, { errorCorrectionLevel: "L" });
  assert.equal(pay.qr!.size, want.modules.size, "ECC L");
  assert.ok(pay.qr!.size <= PAY_QR_MAX && pay.qr!.size <= 64, `version fits the box (size ${pay.qr!.size})`);
  assert.equal(pay.qr!.rows.length, pay.qr!.size);
  assert.ok(pay.qr!.rows.every((r) => r.length === pay.qr!.size && /^[01]+$/.test(r)));
  // the lobby's join QR is unchanged (ECC M)
  assert.ok(s.qr && s.qr.size > 0);

  // Paid: the card says so for a while, then goes.
  const l = structuredClone((await lobby.getLobby(code))!);
  l.boxPay!.paidAt = now;
  assert.equal(payOf(l, now + 1000)!.paid, true);
  assert.equal(payOf(l, now + PAY_PAID_MS + 1), undefined);
  // Expired and unpaid: gone. Garbage: gone.
  l.boxPay!.paidAt = null;
  assert.equal(payOf(l, now + 5 * 60_000 + 1), undefined);
  l.boxPay!.url = 42 as unknown as string;
  assert.equal(payOf(l, now), undefined);

  s = await kioskTouch(kiosk, "pay:close", "http://x");
  assert.equal(s.pay, undefined);
  assert.equal((await lobby.getLobby(code))!.boxPay, null);
  await assert.rejects(kioskTouch(kiosk, "pay:open", "http://x"), /Unknown button/);
});
