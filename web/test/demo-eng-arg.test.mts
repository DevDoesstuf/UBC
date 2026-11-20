// The demo game: England v Argentina, World Cup semi-final. Pregame question at Gemini's real price that settles at
// the end, live questions with a fact card on the box, and tap-the-box to collect after the final whistle.
// Everything runs on the flashed firmware: the cards are message screens.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KIOSK_KEY;
delete process.env.MONEY_MODE;

const lobby = await import("../lib/lobby.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");
const nfc = await import("../app/k/[kiosk]/route.ts");
const cashoutRoute = await import("../app/api/lobby/[code]/cashout/route.ts");

const KIOSK = "demo-ea";
const touch = (id: string) => kioskTouch(KIOSK, id, "http://x");

test("England v Argentina: pool, pregame call settles at the end, fact cards, tap to collect", async () => {
  let s = await touch("game:wc-eng-arg");
  assert.equal(s.title, "How do you want to play?");
  s = await touch("mode:pool");
  assert.equal(s.screen, "lobby");
  const code = (await lobby.getKioskCode(KIOSK))!;
  const ids: string[] = [];
  const toks: string[] = [];
  await lobby.mutate(code, (l, now) => {
    for (const name of ["Ayan", "Dev"]) {
      const p = lobby.join(l, name, now);
      ids.push(p.id);
      toks.push(p.token);
      lobby.creditDeposit(l, p.id, 2000, "demo", `demo-${p.id}`, now);
    }
  });

  // Q1: pregame, at Gemini's real price; trades, locks, then steps aside.
  s = await touch("start");
  let l = (await lobby.getLobby(code))!;
  assert.equal(l.market!.mode, "pool");
  assert.equal(l.market!.gemini?.prob, 0.48);
  await lobby.mutate(code, (x, now) => {
    lobby.buy(x, x.players[ids[0]], "yes", 500, now);
    lobby.buy(x, x.players[ids[1]], "no", 500, now);
  });
  s = await touch("lock");
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "lobby");
  assert.equal(l.parkedClip?.questionId, "final");
  assert.equal(l.qIndex, 1);
  const view = lobby.publicView(l, toks[0], "http://x") as { parked?: { text: string } | null };
  assert.match(view.parked?.text ?? "", /reach the World Cup final/);

  // Q2..Q4: live questions; the box shows the fact card for the first seconds.
  for (const [i, who] of [[1, 1], [2, 0], [3, 0]] as const) {
    s = await touch("start");
    await lobby.mutate(code, (x) => {
      x.market!.openedAt -= 1500;
      x.hw = { ...(x.hw ?? {}), hotseat: null };
    });
    s = await kioskScreen(KIOSK, "http://x");
    if (!s.hotseat) {
      assert.equal(s.screen, "message", `fact card on Q${i + 1}`);
      assert.equal(s.title, "Did you know?");
      assert.ok((s.subtitle ?? "").length > 20);
    }
    await lobby.mutate(code, (x, now) => {
      x.hw = { ...(x.hw ?? {}), hotseat: null };
      lobby.buy(x, x.players[ids[who]], "yes", 200, now);
    });
    s = await touch("lock");
    // The real result is known: no YES/NO buttons, it settles by itself a few seconds after the lock.
    assert.equal(s.legacyOf ?? s.screen, "locked");
    assert.deepEqual(s.buttons, []);
    const lk = (await lobby.getLobby(code))!.market!;
    assert.ok(lk.resolveAt! - lk.lockAt >= 7000 && lk.resolveAt! - lk.lockAt <= 9000, "about 8 s after the lock");
    await lobby.mutate(code, (x) => {
      x.market!.resolveAt = Date.now() - 1;
    });
    s = await kioskScreen(KIOSK, "http://x");
    assert.equal((s.legacyOf ?? s.screen), "result");
    assert.equal((await lobby.getLobby(code))!.market!.outcome, "yes");
  }
  if (l.phase !== "ended") await touch("end");
  l = (await lobby.getLobby(code))!;
  assert.equal(l.phase, "ended");
  assert.equal(l.parkedClip, null);
  // Ayan backed YES on "reach the final" with Dev on NO: the $10 pot goes to Ayan.
  assert.equal(l.results.find((r) => r.text.includes("final"))?.outcome, "yes");
  s = await kioskScreen(KIOSK, "http://x");
  assert.equal(s.screen, "message");
  assert.match(s.title ?? "", /^YES!/);

  // Tap the box: the NFC link goes to ?collect=1, the phone cashes out, the box says who collected.
  const r = await nfc.GET(new Request(`http://x/k/${KIOSK}`), { params: Promise.resolve({ kiosk: KIOSK }) });
  assert.match(r.headers.get("location") ?? "", new RegExp(`/l/${code}\\?collect=1$`));
  const before = l.players[ids[0]].balance;
  const res = await cashoutRoute.POST(
    new Request(`http://x/api/lobby/${code}/cashout`, { method: "POST", headers: { "content-type": "application/json", "x-player-token": toks[0] }, body: JSON.stringify({ address: "" }) }),
    { params: Promise.resolve({ code }) },
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { cents: number }).cents, before);
  await lobby.mutate(code, (x) => {
    if (x.parkedReveal) x.parkedReveal.at -= 10_000;
  });
  s = await kioskScreen(KIOSK, "http://x");
  assert.equal(s.screen, "message");
  assert.match(s.title ?? "", /Ayan collects \$/);
  await touch("new");
});
