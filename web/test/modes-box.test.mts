// The box asks "How do you want to play?" after a game is picked (works on the flashed firmware: a message
// screen with four buttons), pool betting pays from the pot only, and Gemini-odds mode trades at a fixed price.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KIOSK_KEY;
delete process.env.MONEY_MODE;

const lobby = await import("../lib/lobby.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");

let n = 0;
async function room(mode: "pool" | "mirror" | "market", names: string[]) {
  const l = await lobby.createLobby(`md${++n}`, "football", mode);
  const ids: string[] = [];
  await lobby.mutate(l.code, (x, now) => {
    for (const name of names) {
      const p = lobby.join(x, name, now);
      ids.push(p.id);
      lobby.creditDeposit(x, p.id, 1000, "demo", `demo-${p.id}`, now);
    }
  });
  return { code: l.code, ids };
}

test("the box asks how to play right after a game is picked, then shows the lobby", async () => {
  const kiosk = "md-box";
  let s = await kioskTouch(kiosk, "game:football", "http://x");
  assert.equal(s.screen, "message");
  assert.equal(s.title, "How do you want to play?");
  assert.deepEqual(s.buttons.map((b) => b.id), ["mode:pool", "mode:market", "mode:mirror", "mode:h2h"]);
  assert.ok(s.buttons.every((b) => b.label.length <= 16));
  s = await kioskTouch(kiosk, "mode:pool", "http://x");
  assert.equal(s.screen, "lobby");
  const calls = (s as unknown as { calls?: { id: string; label: string }[] }).calls ?? [];
  assert.equal(calls[0]?.id, "mode:pick");
  assert.equal(calls[0]?.label, "Mode: Pool");
  // The Mode button brings the question back; picking again changes it.
  s = await kioskTouch(kiosk, "mode:pick", "http://x");
  assert.equal(s.title, "How do you want to play?");
  s = await kioskTouch(kiosk, "mode:mirror", "http://x");
  assert.equal(s.screen, "lobby");
  s = await kioskTouch(kiosk, "start", "http://x");
  assert.equal(s.legacyOf ?? s.screen, "market");
  assert.match(s.title ?? "", /Gemini odds/);
  await kioskTouch(kiosk, "lock", "http://x").catch(() => undefined);
});

test("pool: two friends on the same side just get their own money back; the house adds nothing", async () => {
  const { code, ids } = await room("pool", ["Sam", "Alex"]);
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await lobby.mutate(code, (l, now) => {
    lobby.buy(l, l.players[ids[0]], "yes", 300, now);
    lobby.buy(l, l.players[ids[1]], "yes", 100, now);
  });
  await lobby.mutate(code, (l) => lobby.lockMarket(l));
  const l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "yes", now));
  assert.equal(l.players[ids[0]].balance, 1000);
  assert.equal(l.players[ids[1]].balance, 1000);
  assert.equal(l.housePnl, 0);
});

test("pool: the winners split the losers' money in proportion to their stakes", async () => {
  const { code, ids } = await room("pool", ["Sam", "Alex", "Kai"]);
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await lobby.mutate(code, (l, now) => {
    lobby.buy(l, l.players[ids[0]], "yes", 300, now);
    lobby.buy(l, l.players[ids[1]], "yes", 100, now);
    lobby.buy(l, l.players[ids[2]], "no", 400, now);
  });
  await lobby.mutate(code, (l) => lobby.lockMarket(l));
  const l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "yes", now));
  assert.equal(l.players[ids[0]].balance, 700 + 600); // $3 of the $4 winning side gets 3/4 of the $8 pot
  assert.equal(l.players[ids[1]].balance, 900 + 200);
  assert.equal(l.players[ids[2]].balance, 600);
  assert.equal(l.housePnl, 0);
});

test("Gemini odds: fixed price at the moment you buy, trades don't move it, a winning share pays $1", async () => {
  const { code, ids } = await room("mirror", ["Sam"]);
  let l = await lobby.mutate(code, (x, now) => lobby.openMarket(x, now));
  const p0 = lobby.yesPrice(l.market!);
  l = await lobby.mutate(code, (x, now) => {
    lobby.buy(x, x.players[ids[0]], "yes", 500, now);
  });
  const m = l.market!;
  assert.equal(m.mode, "mirror");
  assert.ok(Math.abs(lobby.yesPrice(m) - p0) < 1e-9, "a trade does not move a Gemini-odds price");
  const shares = m.positions[ids[0]].yes;
  assert.ok(Math.abs(shares - 5 / Math.max(0.03, p0)) < 1e-9);
  await lobby.mutate(code, (x) => lobby.lockMarket(x));
  l = await lobby.mutate(code, (x, now) => lobby.resolveMarket(x, "yes", now));
  assert.equal(l.players[ids[0]].balance, 500 + Math.floor(shares * 100 + 1e-6));
  const screen = await kioskScreen(l.kioskId, "http://x");
  assert.ok(screen);
});

test("sounds: each sport has its own start, lock, alert and cheer; the Portugal game has its own voice", async () => {
  const { soundFile } = await import("../lib/speaker.ts");
  const { existsSync } = await import("node:fs");
  assert.equal(soundFile("start", "soccer"), "start-soccer.wav");
  assert.equal(soundFile("start", "nfl"), "start-nfl.wav");
  assert.equal(soundFile("win", "soccer"), "win.wav");
  assert.equal(soundFile("start", null), "start.wav");
  for (const s of ["start", "lock", "siren", "cheer"] as const)
    for (const sport of ["soccer", "nfl", "nba"]) assert.ok(existsSync(new URL(`../public/sounds/${soundFile(s, sport)}`, import.meta.url)), `${s} ${sport}`);
  const por = await lobby.createLobby("md-por", "soccer-replay");
  assert.match(lobby.voiceOf(por) ?? "", /^[A-Za-z0-9]{20}$/);
  const epl = await lobby.createLobby("md-epl", "epl-mun-avl");
  assert.equal(lobby.voiceOf(epl), null);
});
