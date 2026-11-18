// Prints the questions each replay game asks when nobody taps: `node --import ./test/register.mjs test/sim.mts`
import { simulate } from "../lib/replay/run.ts";

for (const id of ["replay-ten-dal", "replay-por-esp"]) {
  console.log(id);
  for (const q of simulate(id, { pregame: true })) {
    console.log(`  ${(q.atMs / 1000).toFixed(1).padStart(6)}s  ${String(Math.round(q.yesPrior * 100)).padStart(2)}%  ${q.templateId.padEnd(24)} ${q.text}  [${q.short}]`);
  }
}
