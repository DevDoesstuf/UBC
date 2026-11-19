// Per-lobby money: on a server that offers Solana (MONEY_MODE=solana + SETTLEMENT=vault, no real chain), every new
// game plays demo money until the host picks Solana (box touch money:toggle, POST /money) before anyone pays in.
// Deposits, Pay on the box, the faucet, the vault and the QuickNode webhook all follow the lobby's choice.
// (A server without Solana: see kiosk.test.mts, no money button.)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KIOSK_KEY;
const { Keypair } = await import("@solana/web3.js");
const TREASURY_KP = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();
const TOKEN = "q".repeat(40);
process.env.MONEY_MODE = "solana";
process.env.SETTLEMENT = "vault";
process.env.SOLANA_TREASURY_SECRET_KEY = JSON.stringify(Array.from(TREASURY_KP.secretKey));
process.env.USDC_MINT = MINT;
process.env.SOLANA_RPC_URL = "http://127.0.0.1:9";
process.env.QUICKNODE_STREAM_TOKEN = TOKEN;

const money = await import("../lib/money.ts");
const lobby = await import("../lib/lobby.ts");
const vault = await import("../lib/vault.ts");
const solLobby = await import("../lib/solana-lobby.ts");
const qn = await import("../lib/quicknode.ts");
const { kioskScreen, kioskTouch } = await import("../lib/kiosk.ts");
const depositRoute = await import("../app/api/lobby/[code]/deposit/route.ts");
const boxRoute = await import("../app/api/lobby/[code]/deposit/box/route.ts");
const moneyRoute = await import("../app/api/lobby/[code]/money/route.ts");
const lobbyRoute = await import("../app/api/lobby/[code]/route.ts");

const post = (url: string, body: unknown, token?: string) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-player-token": token } : {}) }, body: JSON.stringify(body) });
const params = (code: string) => ({ params: Promise.resolve({ code }) });
let n = 0;
async function lobbyWith(names: string[]) {
  const kiosk = `mc${++n}`;
  const l = await lobby.createLobby(kiosk, "football");
  const toks: string[] = [];
  await lobby.mutate(l.code, (x, now) => {
    for (const name of names) toks.push(lobby.join(x, name, now).token);
  });
  return { kiosk, code: l.code, toks };
}
const deposit = (code: string, tok: string, cents = 500) => depositRoute.POST(post(`http://x/api/lobby/${code}/deposit`, { cents }, tok), params(code));

test("server offers both; a new lobby plays demo money", async () => {
  assert.equal(money.MONEY_MODE, "solana");
  assert.deepEqual(money.moneyInfo().offered, ["demo", "solana"]);
  const { code } = await lobbyWith([]);
  const l = (await lobby.getLobby(code))!;
  assert.equal(l.money, "demo");
  assert.equal(money.lobbyMoneyMode(l), "demo");
  assert.equal(money.lobbyMoneyMode({}), "demo", "a lobby from before the switch existed is demo");
  const view = (await (await lobbyRoute.GET(new Request(`http://x/api/lobby/${code}`), params(code))).json()) as { money: ReturnType<typeof money.moneyInfo> };
  assert.equal(view.money.mode, "demo");
  assert.equal(view.money.solanaPay, false);
  assert.equal(view.money.boxPay, false);
  assert.equal(view.money.settlement, null);
  assert.deepEqual(view.money.offered, ["demo", "solana"]);
  assert.equal(view.money.locked, false);
});

test("a demo lobby credits at once while a Solana lobby on the same server gets a Solana Pay URL", async () => {
  const demo = await lobbyWith(["Ann"]);
  const r = await deposit(demo.code, demo.toks[0]);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, credited: 500 });
  assert.equal((await boxRoute.POST(post(`http://x/api/lobby/${demo.code}/deposit/box`, { cents: 500 }, demo.toks[0]), params(demo.code))).status, 400, "no Pay on the box for demo");

  const sol = await lobbyWith(["Bo"]);
  const t = await moneyRoute.POST(post(`http://x/api/lobby/${sol.code}/money`, { mode: "solana" }), params(sol.code));
  assert.equal(t.status, 200);
  const tj = (await t.json()) as { money: ReturnType<typeof money.moneyInfo> };
  assert.equal(tj.money.mode, "solana");
  assert.equal(tj.money.settlement, "vault");
  const s = await deposit(sol.code, sol.toks[0]);
  assert.equal(s.status, 200);
  const sj = (await s.json()) as { url: string; solanaPay: boolean; vault: boolean; credited?: number };
  assert.match(sj.url, /^solana:/);
  assert.equal(sj.solanaPay, true);
  assert.equal(sj.vault, true);
  assert.equal(sj.credited, undefined, "nothing credited until it is paid");
  assert.equal(lobby.requirePlayer((await lobby.getLobby(sol.code))!, sol.toks[0]).balance, 0);
});

test("toggle works before anyone pays in and is refused after", async () => {
  const { kiosk, code, toks } = await lobbyWith(["Cy"]);
  let s = await kioskTouch(kiosk, "money:toggle", "http://x");
  assert.equal(s.money?.mode, "solana");
  assert.ok(s.buttons.some((b) => b.id === "money:toggle" && b.label === "Money: Solana"));
  s = await kioskTouch(kiosk, "money:toggle", "http://x");
  assert.equal(s.money?.mode, "demo");
  s = await kioskTouch(kiosk, "money:solana", "http://x");
  assert.equal(s.money?.mode, "solana");
  s = await kioskTouch(kiosk, "money:demo", "http://x");
  assert.equal(s.money?.mode, "demo");
  await deposit(code, toks[0]);
  await assert.rejects(kioskTouch(kiosk, "money:toggle", "http://x"), /Money is already in: start a new game to switch/);
  const r = await moneyRoute.POST(post(`http://x/api/lobby/${code}/money`, { mode: "solana" }), params(code));
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /Money is already in/);
  const l = (await lobby.getLobby(code))!;
  assert.equal(l.money, "demo");
  s = await kioskScreen(kiosk, "http://x");
  assert.equal(s.money?.locked, true);
  assert.ok(!s.buttons.some((b) => b.id.startsWith("money:")), "no switch once money is in");
  // Picking what it already is stays fine.
  assert.equal((await moneyRoute.POST(post(`http://x/api/lobby/${code}/money`, { mode: "demo" }), params(code))).status, 200);
  assert.equal((await moneyRoute.POST(post(`http://x/api/lobby/${code}/money`, { mode: "gold" }), params(code))).status, 400);
});

test("money can only be picked in the lobby phase", async () => {
  const { code } = await lobbyWith(["Di"]);
  await lobby.mutate(code, (l, now) => lobby.openMarket(l, now));
  await assert.rejects(lobby.mutate(code, (l) => lobby.setMoney(l, "solana")), /before the game starts/);
});

test("vault settlement is per lobby", async () => {
  const demo = await lobbyWith([]);
  const sol = await lobbyWith([]);
  await lobby.mutate(sol.code, (l) => lobby.setMoney(l, "solana"));
  assert.equal(vault.isVault((await lobby.getLobby(demo.code))!), false);
  assert.equal(vault.isVault((await lobby.getLobby(sol.code))!), true);
  const r = await vault.advanceVault(demo.code);
  assert.equal(r.vault, null, "a demo game never touches the chain");
});

test("the QuickNode webhook ignores a lobby that plays demo money", async () => {
  const { code, toks } = await lobbyWith(["Ed"]);
  await lobby.mutate(code, (l) => lobby.setMoney(l, "solana"));
  const d = await solLobby.newSolanaDeposit(code, toks[0], 500);
  // The host switches back to demo before anyone paid: a late payment to the old request is not credited here.
  await lobby.mutate(code, (l) => lobby.setMoney(l, "demo"));
  let calls = 0;
  const rpc = { getParsedTransaction: async () => (calls++, null), getSignaturesForAddress: async () => [] } as never;
  const res = await qn.handleStream([{ signature: "x".repeat(88), accounts: [d.reference], huddle: [] }], { rpc, treasury: TREASURY_KP.publicKey.toBase58(), mint: MINT });
  assert.equal(res.credited, 0);
  assert.equal(calls, 0, "not even looked up on chain");
  await assert.rejects(solLobby.newSolanaDeposit(code, toks[0], 500), /demo money/);
});

test("box lobby screen: the money button fits the 4-button budget, Latin-1, at most 16 characters", async () => {
  const { kiosk } = await lobbyWith([]);
  let s = await kioskScreen(kiosk, "http://x");
  const b = s.buttons.find((x) => x.id === "money:toggle")!;
  assert.equal(b.label, "Money: Demo");
  assert.deepEqual(s.money, { mode: "demo", offered: ["demo", "solana"], locked: false });
  assert.deepEqual(s.buttons.map((x) => x.id), ["start", "money:toggle", "cancel"]);
  // With players in, "Call it!" moments share the row: never more than 4 buttons.
  const code = (await lobby.getKioskCode(kiosk))!;
  await lobby.mutate(code, (x, now) => void lobby.join(x, "Flo", now));
  s = await kioskScreen(kiosk, "http://x");
  assert.ok(s.buttons.length <= 4, JSON.stringify(s.buttons));
  assert.equal(s.buttons[0].id, "start");
  assert.equal(s.buttons.at(-1)!.id, "cancel");
  assert.ok(s.buttons.some((x) => x.id === "money:toggle"));
  for (const x of s.buttons) assert.ok(x.label.length <= 16 && /^[\x20-\xff]*$/.test(x.label), x.label);
});
