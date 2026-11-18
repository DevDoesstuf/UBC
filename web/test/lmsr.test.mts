// Run with `npm test` (Node 22.6+ strips the TypeScript types itself).
// Checks the worked example from the spec (b = 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cost, costToBuy, maxLoss, priceYes, sharesForSpend, toCents } from "../lib/lmsr.ts";

const close = (a: number, b: number, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("market opens at 50/50", () => {
  close(priceYes(0, 0, 10), 0.5);
});

test("Friend A buys 5 YES for $2.81 and the price moves to 62%", () => {
  close(costToBuy("yes", 5, 0, 0, 10), 2.81);
  assert.equal(toCents(priceYes(5, 0, 10)), 62);
});

test("Friend B then buys 4 NO for $1.70 and the price drops to 52%", () => {
  close(costToBuy("no", 4, 5, 0, 10), 1.70);
  assert.equal(toCents(priceYes(5, 4, 10)), 52);
});

test("sharesForSpend is the inverse of costToBuy", () => {
  for (const [qy, qn] of [[0, 0], [5, 0], [5, 4], [40, 3], [0, 60]]) {
    for (const side of ["yes", "no"] as const) {
      for (const dollars of [0.5, 1, 2, 5, 20]) {
        const s = sharesForSpend(side, dollars, qy, qn, 10);
        close(costToBuy(side, s, qy, qn, 10), dollars, 1e-9);
      }
    }
  }
});

test("max loss is b ln 2 (about $6.93 at b = 10)", () => {
  close(maxLoss(10), 6.93);
  close(maxLoss(10, 0.05), 29.96); // a question that opens at a 5% model prior
  close(cost(0, 0, 10), 6.93);
});

test("large share counts do not overflow", () => {
  assert.ok(Number.isFinite(cost(5000, 0, 10)));
  assert.ok(Number.isFinite(sharesForSpend("no", 50, 5000, 0, 10)));
});
