// "Other amount" deposits: the server accepts the presets and any whole-cent amount from $1 to $100, the phone's
// parser turns typed dollars into exactly those cents, and the Solana Pay URL asks the wallet for the same amount.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_BASE = "http://127.0.0.1:9";

const money = await import("../lib/money.ts");
const solana = await import("../lib/solana.ts");
const fmt = await import("../components/huddle/format.ts");

test("deposit limits: presets and whole cents from $1 to $100 pass, anything else is refused", () => {
  assert.equal(money.DEPOSIT_MIN_CENTS, 100);
  assert.equal(money.DEPOSIT_MAX_CENTS, 10_000);
  for (const c of [...money.DEPOSIT_OPTIONS, 100, 101, 1234, 9999, 10_000, "750"]) assert.equal(money.depositProblem(c), null, `${c}`);
  for (const c of [0, 99, -500, 10_001, 1_000_000, 12.5, Number.NaN, Infinity, "", "abc", null, undefined, {}]) {
    assert.ok(money.depositProblem(c), `${String(c)} must be refused`);
  }
  const info = money.moneyInfo();
  assert.equal(info.depositMin, 100);
  assert.equal(info.depositMax, 10_000);
});

test("parseDollars: typed dollars to exact cents", () => {
  const ok: [string, number][] = [["12.50", 1250], ["$7", 700], ["7.", 700], [".5", 50], ["0.99", 99], ["1,000", 100_000], [" 3.05 ", 305]];
  for (const [t, c] of ok) assert.equal(fmt.parseDollars(t), c, t);
  for (const t of ["", "$", "1.234", "abc", "1.2.3", "-5", "12e2"]) assert.equal(fmt.parseDollars(t), null, t);
});

test("a custom amount's Solana Pay URL carries exactly that amount", () => {
  for (const [cents, amount] of [[1234, "12.34"], [100, "1"], [10_000, "100"], [705, "7.05"]] as const) {
    const url = solana.transferRequestUrl({ recipient: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", cents, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", reference: "ref" });
    assert.equal(new URL(url).searchParams.get("amount"), amount);
  }
});
