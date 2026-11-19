// Box hardware extras (lib/hw.ts): tap-to-confirm, betsIn, join flash, big win/loss, hot seat, inside info,
// standings breaks, and their kiosk JSON fields / speaker sounds.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const lobby = await import("../lib/lobby.ts");
const hw = await import("../lib/hw.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");
const { speakerQueue } = await import("../lib/speaker.ts");

let kioskN = 700;
async function setup(game: string, names = ["Dev", "Ben"], cents = 5000) {
  const kiosk = String(kioskN++);
  const l = await lobby.createLobby(kiosk, game);
  const tokens: string[] = [];
  for (const name of names) {
    await lobby.mutate(l.code, (x, now) => {
      const p = lobby.join(x, name, now);
      tokens.push(p.token);
      lobby.creditDeposit(x, p.id, cents, "demo", `demo-${p.id}`, now);
    });
  }
  return { code: l.code, kiosk, tokens };
}
const money = (l: Awaited<ReturnType<typeof lobby.createLobby>>) => Object.values(l.players).reduce((a, p) => a + p.balance + p.withdrawn, 0) + l.housePnl;

test("join: fun deterministic voice line, join sound, box flash for ~3 s", async () => {
  assert.equal(hw.joinLine("Dev"), hw.joinLine("Dev"));
  const lines = new Set(["Dev", "Ben", "Sam", "Alex", "Priya", "Jo", "Kai", "Lee"].map(hw.joinLine));
  assert.ok(lines.size >= 4, "varied across names");
  const { code, kiosk } = await setup("football", ["Dev"]);
  const s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.flash?.kind, "join");
  assert.equal(s.flash?.name, "Dev");
  assert.ok(s.flash!.leftMs > 0 && s.flash!.leftMs <= 3000);
  const l = (await lobby.getLobby(code))!;
  const cap = l.captions!.filter((c) => c.kind === "join").pop()!;
  assert.equal(cap.say, hw.joinLine("Dev").replace(/\.\.\./g, "..."));
  assert.ok(speakerQueue(l, "http://x", false).some((i) => i.sound === "join"));
  clock += 3100;
  assert.equal((await kioskScreen(kiosk, "http://x")).flash, undefined);
});

test("tap-to-confirm: pending bet on the box, /confirm places it, expires after ~20 s", async () => {
  const { code, kiosk, tokens } = await setup("football");
  await kioskTouch(kiosk, "start", "http://x");
  await lobby.mutate(code, (l, now) => lobby.pendingBuy(l, lobby.requirePlayer(l, tokens[0]), "yes", 200, now));
  let s = await kioskScreen(kiosk, "http://x");
  assert.deepEqual({ ...s.confirm, leftMs: 0 }, { name: "Dev", side: "YES", cents: 200, leftMs: 0 });
  assert.ok(s.confirm!.leftMs > 0 && s.confirm!.leftMs <= hw.CONFIRM_MS);
  assert.deepEqual(s.betsIn, { n: 0, of: 2 });
  let l = (await lobby.getLobby(code))!;
  assert.equal(lobby.publicView(l, tokens[0], "http://x").tapConfirm?.cents, 200);
  assert.equal(lobby.publicView(l, tokens[1], "http://x").tapConfirm, null);
  assert.ok(hw.anyPending(l, clock));
  await lobby.mutate(code, (x, now) => lobby.confirmPending(x, lobby.requirePlayer(x, tokens[0]), now));
  l = (await lobby.getLobby(code))!;
  assert.equal(l.market!.positions[l.order[0]].spent, 200);
  s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.confirm, undefined);
  assert.deepEqual(s.betsIn, { n: 1, of: 2 });
  await assert.rejects(lobby.mutate(code, (x, now) => lobby.confirmPending(x, lobby.requirePlayer(x, tokens[0]), now)), /Nothing to confirm/);
  // Expiry.
  await lobby.mutate(code, (l2, now) => lobby.pendingBuy(l2, lobby.requirePlayer(l2, tokens[1]), "no", 100, now));
  clock += hw.CONFIRM_MS + 10;
  l = (await lobby.getLobby(code))!;
  assert.equal(hw.pendingFor(l, l.order[1], clock), null);
});

test("inside info is on the box only, not in the phone/TV view", async () => {
  const { code, kiosk } = await setup("nfl-lac-bal");
  await kioskTouch(kiosk, "start", "http://x");
  const s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.screen, "market");
  assert.equal(s.tip?.label, "Inside info");
  assert.ok(s.tip!.text.length > 5);
  const pv = JSON.stringify(lobby.publicView((await lobby.getLobby(code))!, null, "http://x"));
  assert.ok(!pv.includes("Inside info"));
  assert.ok(!("tip" in lobby.publicView((await lobby.getLobby(code))!, null, "http://x")));
});

test("big win: cheer + praise + bigwin flash; big loss: taunt + bigloss flash", async () => {
  const { code, kiosk, tokens } = await setup("football");
  await kioskTouch(kiosk, "start", "http://x");
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 1000, now));
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[1]), "no", 800, now));
  await kioskTouch(kiosk, "resolve:yes", "http://x");
  const s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.flash?.kind, "bigwin");
  assert.equal(s.flash?.name, "Dev");
  assert.ok(s.flash!.cents! >= 500);
  const l = (await lobby.getLobby(code))!;
  assert.ok(l.events.some((e) => e.kind === "bigwin" && e.sound === "cheer"));
  assert.ok(l.captions!.some((c) => c.kind === "bigwin" && /Dev/.test(c.say ?? "")));
  // A loss-only round (the winner made little): taunt.
  const m = l.market!;
  const fake = structuredClone(l);
  fake.hw = {};
  fake.results = [];
  fake.market = { ...m, payouts: { [l.order[0]]: 1100 }, positions: { [l.order[0]]: { yes: 11, no: 0, spent: 1000 }, [l.order[1]]: { yes: 0, no: 9, spent: 800 } } };
  hw.onResult(fake, fake.market!, "yes", clock);
  assert.equal(fake.hw!.flash?.kind, "bigloss");
  assert.equal(fake.hw!.flash?.name, "Ben");
  assert.ok(fake.events.some((e) => e.kind === "bigloss" && e.sound === "lose"));
});

test("hot seat: called once, accept on the box doubles a winning payout (house-funded), money stays consistent", async () => {
  // Find a lobby whose first question gets a hot seat (deterministic per code + question).
  for (let tries = 0; tries < 30; tries++) {
    const { code, kiosk, tokens } = await setup("football");
    await kioskTouch(kiosk, "start", "http://x");
    await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 200, now));
    let l = (await lobby.getLobby(code))!;
    const m = l.market!;
    if (m.lockAt - m.openedAt < hw.HOTSEAT_MIN_LEFT_MS + hw.HOTSEAT_MS + 2000) assert.fail("window too short for a test");
    const start = clock;
    let s = await kioskScreen(kiosk, "http://x");
    while (!s.hotseat && clock < m.lockAt - hw.HOTSEAT_MIN_LEFT_MS - hw.HOTSEAT_MS) {
      clock += 500;
      s = await kioskScreen(kiosk, "http://x");
    }
    if (!s.hotseat) {
      clock = Math.max(clock, start);
      continue;
    }
    assert.equal(s.hotseat.name, "Dev");
    assert.equal(s.hotseat.mult, 2);
    assert.ok(s.hotseat.leftMs <= 5000);
    l = (await lobby.getLobby(code))!;
    assert.ok(l.events.some((e) => e.kind === "hotseat" && e.sound === "siren"));
    assert.ok(l.captions!.some((c) => /tap the box in the next five seconds/.test(c.say ?? "")));
    const before = money(l);
    await kioskTouch(kiosk, "hotseat:accept", "http://x");
    await assert.rejects(kioskTouch(kiosk, "hotseat:accept", "http://x"), /No hot seat/);
    await kioskTouch(kiosk, "resolve:yes", "http://x");
    l = (await lobby.getLobby(code))!;
    const pid = l.order[0];
    const pos = l.market!.positions[pid];
    const base = Math.floor(pos.yes * 100 + 1e-6);
    assert.equal(l.market!.payouts[pid], base * 2);
    assert.equal(l.results.at(-1)!.payouts[pid], base * 2);
    assert.equal(money(l), before + 200, "bonus comes out of housePnl (the 200 stake was in the market)");
    assert.ok(l.hw!.hotseat!.done);
    return;
  }
  assert.fail("no hot seat in 30 lobbies");
});

test("hot seat expires with an announcement; void pays no bonus", async () => {
  const { code, tokens } = await setup("football");
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await lobby.mutate(code, (l, now) => lobby.buy(l, lobby.requirePlayer(l, tokens[0]), "yes", 200, now));
  await lobby.mutate(code, (l, now) => {
    l.hw = { hotseat: { playerId: l.order[0], name: "Dev", questionId: l.market!.questionId, mult: 2, until: now + 5000 } };
  });
  clock += 5100;
  let l = (await lobby.getLobby(code))!;
  assert.ok(l.hw!.hotseat!.done);
  assert.ok(l.captions!.some((c) => /Too slow, Dev/.test(c.text)));
  await lobby.mutate(code, (x, now) => {
    x.hw!.hotseat = { playerId: x.order[0], name: "Dev", questionId: x.market!.questionId, mult: 2, until: now + 5000, accepted: true };
    lobby.voidMarket(x, "test", now);
  });
  l = (await lobby.getLobby(code))!;
  assert.equal(l.market!.payouts[l.order[0]], 200, "refund only");
  assert.ok(l.hw!.hotseat!.done);
});

test("standings break after every 3rd result: interlude on the box, top 3 read out, replay waits", async () => {
  const { code, kiosk } = await setup("football", ["Dev", "Ben", "Sam", "Alex"]);
  const l = (await lobby.getLobby(code))!;
  l.results = [{ qIndex: 0, text: "a", outcome: "yes", volume: 0, payouts: {} }, { qIndex: 1, text: "b", outcome: "no", volume: 0, payouts: {} }];
  const m = { questionId: "q3", positions: {}, payouts: {}, mode: "market" } as never;
  hw.onResult(l, m, "yes", clock);
  assert.ok(l.hw!.interludeUntil! > clock);
  const cap = l.captions!.at(-1)!;
  assert.equal(cap.kind, "standings");
  assert.match(cap.say!, /leads with fifty dollars/);
  assert.equal((cap.text.match(/\$/g) ?? []).length, 3, "top 3 only");
  assert.equal(hw.interludeHold(l), l.hw!.interludeUntil);
  // On the box (result screen) via a real flow: 3 resolved questions.
  const x = await setup("nfl-lac-bal");
  for (let i = 0; i < 3; i++) {
    try {
      await kioskTouch(x.kiosk, "next", "http://x");
    } catch {
      clock += 20_000;
      await kioskTouch(x.kiosk, "next", "http://x").catch(() => {});
    }
    const cur = (await lobby.getLobby(x.code))!;
    if (cur.phase === "open" || cur.phase === "locked") await kioskTouch(x.kiosk, "resolve:yes", "http://x");
  }
  const after = (await lobby.getLobby(x.code))!;
  if (after.results.length === 3) {
    const s = await kioskScreen(x.kiosk, "http://x");
    assert.equal(s.interlude?.kind, "standings");
    assert.ok(s.interlude!.leftMs <= 6000);
  }
  void kiosk;
});
