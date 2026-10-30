// Child process for ledger-lock-fencing.test.ts: appends N events to one ledger file.
import { Ledger } from "../../src/ledger/Ledger.ts";

const [file = "", tag = "", countArg = "0"] = process.argv.slice(2);
const ledger = await Ledger.create(file);
for (let i = 0; i < Number(countArg); i++) {
  await ledger.emitEvent("work_item.updated", `WI-${tag}`, { type: "system" }, { tag, i, pad: "x".repeat(2000) });
}
process.stdout.write("done\n");
