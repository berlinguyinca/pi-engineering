// Child process for ledger-plan-revision-race.test.ts: records plans against one shared ledger file.
// argv: file, work item id, go-file, then `mode:tag` rounds. `distinct:tag` records a plan unique to this child;
// `same` records the plan every child shares (an idempotent re-record). Prints one JSON line of plan ids.
import { existsSync } from "node:fs";
import { Ledger } from "../../src/ledger/Ledger.ts";

const [file = "", workItemId = "", goFile = "", ...rounds] = process.argv.slice(2);
const ledger = await Ledger.create(file);
process.stdout.write("ready\n");
while (!existsSync(goFile)) await new Promise((r) => setTimeout(r, 1));
const ids: (string | null)[] = [];
for (const round of rounds) {
  const [mode = "", tag = ""] = round.split(":");
  const title = mode === "same" ? "shared" : `plan ${tag}`;
  const plan = await ledger.recordPlan(
    workItemId,
    { steps: [{ task_id: `T-${mode === "same" ? "shared" : tag}`, title }] },
    { type: "system" },
  );
  ids.push(plan?.id ?? null);
}
process.stdout.write(`${JSON.stringify(ids)}\n`);
