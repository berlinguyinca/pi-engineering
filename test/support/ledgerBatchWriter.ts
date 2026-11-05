// Child process for ledger-hardening.test.ts: creates N candidates (a two-event write each) against one ledger file.
import { Ledger } from "../../src/ledger/Ledger.ts";

const [file = "", tag = "", countArg = "0"] = process.argv.slice(2);
const ledger = await Ledger.create(file);
const actor = { type: "system" as const };
for (let i = 0; i < Number(countArg); i++) {
  await ledger.createCandidate(
    `WI-${tag}`,
    "base",
    `br-${tag}-${i}`,
    null,
    "implementer",
    `run-${tag}-${i}`,
    null,
    actor,
  );
}
process.stdout.write("done\n");
