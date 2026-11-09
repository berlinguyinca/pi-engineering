// Re-derive handoffHash after editing a record's fields -- the same canonicalHash the gate uses
// (src/bootstrap/resultGate.ts:36), so a probe's bytes are internally consistent and the only thing
// the scan can object to is what the probe intended to change.
//
//   npx tsx docs/specs/harness-reliability-bootstrap-20261103/X16/fixtures/rehash.mts <file> k=v [k=v ...]
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalHash } from "../../../../../src/bootstrap/resultGate.ts";

const [file, ...pairs] = process.argv.slice(2);
const rec: Record<string, unknown> = JSON.parse(readFileSync(file, "utf8"));
for (const pair of pairs) {
  const i = pair.indexOf("=");
  const key = pair.slice(0, i);
  const value = pair.slice(i + 1);
  rec[key] = value === "null" ? null : value;
}
delete rec.handoffHash;
rec.handoffHash = canonicalHash(rec);
writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
console.log(`${file} -> ${rec.handoffHash}`);
