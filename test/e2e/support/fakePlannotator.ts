/**
 * FAKE - test shim. A stand-in for `herdr-plannotator` (the real one needs a browser UI and a human), written as a
 * shell script so Pi's REAL HerdrPlannotatorTransport spawns it exactly as it would the real bridge:
 *   fake plan --plan-file <file> --mission-id <id> --title <t>
 * It prints the bridge's JSON result. Behaviour is chosen by the first line of the `mode` file next to the script:
 *   approve | approve-wrong-digest | annotate | deny | dismiss | crash | garbage
 * Every invocation appends the plan-file sha256 to `calls.log`, so tests can prove what was reviewed.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakePlannotator {
  dir: string;
  command: string;
  setMode(mode: string): void;
  calls(): string[];
}

export function makeFakePlannotator(): FakePlannotator {
  const dir = mkdtempSync(join(tmpdir(), "t16-fake-plannotator-"));
  const command = join(dir, "fake-plannotator");
  const script = `#!/bin/sh
# FAKE - test shim (see fakePlannotator.ts)
here="$(dirname "$0")"
[ "$1" = plan ] || exit 64
file=""
while [ $# -gt 0 ]; do [ "$1" = --plan-file ] && file="$2"; shift; done
digest="$(sha256sum "$file" | cut -d' ' -f1)"
echo "$digest" >> "$here/calls.log"
mode="$(head -n1 "$here/mode")"
case "$mode" in
  approve) printf '{"decision":"approved","plan_digest":"%s","review_id":"fake-review-1"}\\n' "$digest" ;;
  approve-wrong-digest) printf '{"decision":"approved","plan_digest":"%s","review_id":"fake-review-2"}\\n' "0000000000000000000000000000000000000000000000000000000000000000" ;;
  annotate) printf '{"decision":"annotated","plan_digest":"%s","feedback":"split the auth change","review_id":"fake-review-3"}\\n' "$digest" ;;
  deny) printf '{"decision":"denied","plan_digest":"%s","feedback":"no","review_id":"fake-review-4"}\\n' "$digest" ;;
  dismiss) printf '{"decision":"dismissed","plan_digest":"%s"}\\n' "$digest" ;;
  crash) exit 3 ;;
  *) echo "not json" ;;
esac
`;
  writeFileSync(command, script);
  chmodSync(command, 0o700);
  writeFileSync(join(dir, "mode"), "approve\n");
  return {
    dir,
    command,
    setMode: (m) => writeFileSync(join(dir, "mode"), `${m}\n`),
    calls: () => {
      try {
        return readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
