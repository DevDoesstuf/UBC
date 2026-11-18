// The kiosk screen JSON: the v1 fields the old firmware reads stay exactly as they were, and the optional v2
// fields the new box renderer (firmware/kiosk_screen/ui.cpp) and /kiosk use are filled on every screen.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const lobby = await import("../lib/lobby.ts");
const { allGames } = await import("../lib/games.ts");
const { kioskScreen, kioskTouch, KIOSK_PALETTE } = await import("../lib/kiosk.ts");

const LATIN1 = /^[\x20-\x7E\xA0-\xFF]*$/;

test("kiosk v2: picker cards for every game, the old 4 tiles unchanged", async () => {
  const s = await kioskScreen("901", "http://x");
  assert.equal(s.screen, "select");
  assert.equal(s.v, 2);
  assert.deepEqual(s.palette, { ...KIOSK_PALETTE });
  assert.equal(s.tiles!.length, Math.min(4, allGames().length), "old firmware still gets at most 4 tiles");
  for (const t of s.tiles!) assert.deepEqual(Object.keys(t).sort(), ["enabled", "id", "label", "sub"]);
  assert.equal(s.cards!.length, allGames().length, "every configured game is a card");
  const replay = s.cards!.find((c) => c.id === "game:nfl-replay")!;
  assert.equal(replay.league, "NFL");
  assert.equal(replay.kind, "replay");
  assert.equal(replay.gemini, true);
  assert.ok(replay.home?.name && replay.away?.name && /^#[0-9A-F]{6}$/i.test(replay.home.color ?? ""));
  assert.match(replay.date ?? "", /Nov 22/);
  for (const c of s.cards!) assert.ok(LATIN1.test(c.title + c.sub + (c.league ?? "") + (c.date ?? "")), c.title);
});

test("kiosk v2: lobby roster, pot, calls; market timing, trades, model; result winners/losers; ended board", async () => {
  const kiosk = "902";
  await kioskTouch(kiosk, "game:football", "http://x");
  const code = (await lobby.getKioskCode(kiosk))!;
  const tokens: string[] = [];
  for (const name of ["Sam", "Priya", "Leo"]) {
    await lobby.mutate(code, (x, now) => {
      const p = lobby.join(x, name, now);
      tokens.push(p.token);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    });
  }
  let s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.screen, "lobby");
  assert.equal(s.players!.length, 3, "v1 player strings stay");
  assert.equal(typeof s.players![0], "string");
  assert.deepEqual(s.roster!.map((p) => [p.name, p.cents, p.deposited]), [["Sam", 1000, 1000], ["Priya", 1000, 1000], ["Leo", 1000, 1000]]);
  assert.equal(s.pot, 3000);
  assert.ok(s.calls!.length >= 2 && s.calls!.every((c) => c.id.startsWith("moment:") && c.enabled));
  assert.ok(s.buttons.filter((b) => b.id.startsWith("moment:")).length <= 2, "old firmware keeps its 2-moment budget");

  s = await kioskTouch(kiosk, "start", "http://x");
  assert.equal(s.screen, "market");
  assert.ok(s.lockTotal! > 0 && s.lockInMs! > 0 && s.lockInMs! <= s.lockTotal! * 1000);
  assert.equal(typeof s.lockIn, "number");
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[0]), "yes", 300, now));
  await lobby.mutate(code, (x, now) => lobby.buy(x, lobby.requirePlayer(x, tokens[1]), "no", 200, now));
  s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.volume, 500);
  assert.deepEqual(s.trades!.map((t) => [t.name, t.side, t.cents]), [["Priya", "no", 200], ["Sam", "yes", 300]]);
  assert.ok(s.trades!.every((t) => t.price >= 1 && t.price <= 99));

  await kioskTouch(kiosk, "lock", "http://x");
  s = await kioskTouch(kiosk, "resolve:yes", "http://x");
  assert.equal(s.screen, "result");
  assert.equal(s.result, "YES");
  assert.deepEqual(s.winners!.map((w) => w.name), ["Sam"]);
  assert.ok(s.winners![0].profit > 0 && s.winners![0].cents > 300);
  assert.deepEqual(s.losers!.map((w) => [w.name, w.cents]), [["Priya", 200]]);
  assert.ok(typeof s.lockYes === "number" && s.lockYes > 0);
  assert.ok(s.lines!.length >= 1, "v1 lines stay");

  s = await kioskTouch(kiosk, "end", "http://x");
  assert.equal(s.screen, "ended");
  assert.equal(s.leaderboard![0].name, "Sam");
  assert.equal(s.leaderboard!.reduce((a, p) => a + p.pnl, 0), s.leaderboard!.reduce((a, p) => a + p.cents, 0) - 3000);
  assert.ok(s.scorecard && typeof s.scorecard.verdict === "string");
  assert.ok(s.lines!.length === 3, "v1 lines stay");
});
