// Boards everywhere (phone, TV, box) rank by worth = balance + withdrawn + open positions at value
// (lib/standings.ts): a buy never drops a player down the board, a tie names no leader.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const { openValue, openValues, standings, worthOf, losersOf } = await import("../lib/standings.ts");
const lmsr = await import("../lib/lmsr.ts");
const lobby = await import("../lib/lobby.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");

const market = (over: Record<string, unknown> = {}) => ({
  yes: 0, no: 0, b: 10, positions: {} as Record<string, { yes: number; no: number; spent: number }>,
  outcome: null as "yes" | "no" | null, resolvedAt: null as number | null, payouts: {} as Record<string, number>, ...over,
});

test("openValue: market shares at the current price, pool and h2h stakes at cost, nothing once settled", () => {
  const m = market({ yes: 6, no: 2 });
  m.positions.a = { yes: 4, no: 1, spent: 300 };
  const p = lmsr.priceYes(6, 2, 10);
  assert.equal(openValue(m, "a"), Math.round((4 * p + 1 * (1 - p)) * 100));
  assert.equal(openValue(m, "nobody"), 0);

  const pool = market({ mode: "pool", yes: 50, no: -50 });
  pool.positions.a = { yes: 2.5, no: 0, spent: 250 };
  assert.equal(openValue(pool, "a"), 250, "pool: the stake at cost, whatever the display price");

  const h2h = market({
    mode: "h2h",
    offers: [
      { id: "o1", by: "a", name: "A", side: "yes", cents: 1000, filled: 400, odds: 2, open: true, at: 0 },
      { id: "o2", by: "a", name: "A", side: "no", cents: 500, filled: 0, odds: 2, open: false, at: 0 },
    ],
  });
  h2h.positions.a = { yes: 4, no: 0, spent: 400 };
  assert.equal(openValue(h2h, "a"), 400 + 600, "h2h: matched stake plus what is still on offer (it left the balance)");

  assert.equal(openValue({ ...m, outcome: "yes" }, "a"), 0, "settled: the payout is in the balance already");
  assert.equal(openValue({ ...m, resolvedAt: 1 }, "a"), 0, "voided: refunded into the balance");
  assert.equal(openValue(null, "a"), 0);
});

test("standings: best first, shared rank on a tie, a leader only when one player is strictly ahead", () => {
  const rows = standings([
    { id: "a", balance: 500, withdrawn: 0, open: 0 },
    { id: "b", balance: 200, withdrawn: 300, open: 0 },
    { id: "c", balance: 100, open: 250 },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.worth, r.rank, r.lead]), [["a", 500, 1, false], ["b", 500, 1, false], ["c", 350, 3, false]]);

  const solo = standings([{ id: "a", balance: 100 }, { id: "b", balance: 400 }, { id: "c", balance: 100 }]);
  assert.deepEqual(solo.map((r) => [r.id, r.rank, r.lead]), [["b", 1, true], ["a", 2, false], ["c", 2, false]]);
  assert.equal(standings([{ id: "a", balance: 0 }])[0].lead, false, "nobody leads on $0");
  assert.equal(worthOf({ balance: 1, withdrawn: 2, open: 3 }), 6);
});

test("losersOf: backed it and got nothing back, biggest first; nobody before it settles or when voided", () => {
  const m = market({ outcome: "yes", payouts: { a: 500 } });
  m.positions = { a: { yes: 5, no: 0, spent: 300 }, b: { yes: 0, no: 2, spent: 200 }, c: { yes: 0, no: 5, spent: 450 }, d: { yes: 0, no: 0, spent: 0 } };
  assert.deepEqual(losersOf(m), [{ id: "c", cents: 450 }, { id: "b", cents: 200 }]);
  assert.deepEqual(losersOf({ ...m, outcome: null }), []);
  assert.deepEqual(losersOf({ ...m, voided: true }), []);
});

test("a live question: the buyer is not ranked below a player who sat out, everywhere", async () => {
  const kiosk = "951";
  await kioskTouch(kiosk, "game:football", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  const tokens: string[] = [];
  for (const name of ["Sam", "Leo"]) {
    await lobby.mutate(code, (x, now) => {
      const p = lobby.join(x, name, now);
      tokens.push(p.token);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    });
  }
  await kioskTouch(kiosk, "start", "http://x");
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 500, now));
  const l = (await lobby.getLobby(code))!;
  const sam = l.order.find((id) => l.players[id].name === "Sam")!;
  const open = openValues(l);
  assert.ok(open[sam] > 0, "Sam's shares are worth something while the question is open");
  // What every client reads: the lobby view carries `open` per player, the same number.
  const v = lobby.publicView(l, null, "http://x");
  assert.equal(v.players.find((p) => p.name === "Sam")!.open, open[sam]);
  assert.equal(v.players.find((p) => p.name === "Leo")!.open, 0);
  const board = standings(v.players);
  assert.equal(board[0].name, "Sam", "cash alone (500) would rank Sam below Leo (1000)");
  assert.equal(board[0].worth, 500 + open[sam]);

  // The question settles: open values are gone, worth is cash again, and Leo vs Sam is decided by the result.
  await kioskTouch(kiosk, "lock", "http://x");
  const s = await kioskTouch(kiosk, "resolve:no", "http://x");
  assert.deepEqual(s.losers!.map((x) => [x.name, x.cents]), [["Sam", 500]]);
  const after = (await lobby.getLobby(code))!;
  assert.deepEqual(Object.values(openValues(after)), [0, 0]);
  const ended = await kioskTouch(kiosk, "end", "http://x");
  assert.deepEqual(ended.leaderboard!.map((p) => [p.name, p.cents, p.rank, p.lead]), [["Leo", 1000, 1, true], ["Sam", 500, 2, false]]);
});

test("ended board on the box: a tie at the top shares rank 1 and has no leader", async () => {
  const kiosk = "952";
  await kioskTouch(kiosk, "game:football", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  for (const name of ["Ana", "Ben"]) {
    await lobby.mutate(code, (x, now) => {
      const p = lobby.join(x, name, now);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    });
  }
  const s = await kioskTouch(kiosk, "end", "http://x");
  assert.deepEqual(s.leaderboard!.map((p) => [p.rank, p.lead]), [[1, false], [1, false]]);
  assert.deepEqual(s.lines, ["1.  Ana  $10.00", "1.  Ben  $10.00"]);
});
