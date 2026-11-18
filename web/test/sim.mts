// Prints the questions each replay game asks when nobody taps: `node --import ./test/register.mjs test/sim.mts [id...]`
import { simulate } from "../lib/replay/run.ts";
import { replayIds } from "../lib/replay/timeline.ts";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : replayIds();
for (const id of ids) {
  const qs = simulate(id, { pregame: true });
  console.log(`${id} (${qs.length} questions)`);
  for (const q of qs) {
    console.log(`  ${(q.atMs / 1000).toFixed(1).padStart(6)}s  ${String(Math.round(q.yesPrior * 100)).padStart(2)}%  ${q.templateId.padEnd(24)} ${q.text}  [${q.short}]`);
  }
}
