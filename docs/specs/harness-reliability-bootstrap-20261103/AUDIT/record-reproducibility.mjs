#!/usr/bin/env node
// E2 reproducibility check, re-run at the current tip. Read-only.
//
//   node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/record-reproducibility.mjs [ref]
//
// FINAL_AUDIT.md:71 recorded E2 as not met because 43/52 canonical records and 524/696 evidence
// files were untracked -- "cannot be reproduced from git". That was a statement about the tracked
// set at that scan, and the tracked set has since grown to 95 records. This script answers the
// question again, for whatever is tracked now, in the only two senses that git can answer:
//   1. does each record's handoffHash recompute from the committed bytes?
//      canonicalHash per 02-HANDOFF-PROTOCOL.md:15 and src/bootstrap/resultGate.ts:15:
//      sorted keys at every level, compact JSON, UTF-8, handoffHash excluded.
//   2. is every file each record vouches for present in the same tree?
// It does NOT claim the generation set is complete (that is a scope question: FINAL_AUDIT.md:70
// records plan tasks with no record at all) nor that anything ran (G5, S2).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const ref = process.argv[2] ?? "HEAD";
const out = (...a) => { const r = spawnSync("git", ["-C", process.cwd(), ...a], { encoding: "utf8", maxBuffer: 1 << 26 }); return r.status === 0 ? r.stdout : null; };
const sort = (v) => { if (Array.isArray(v)) return v.map(sort); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = sort(v[k]); return o; } return v; };
const canon = (r) => { const c = { ...r }; delete c.handoffHash; return `sha256:${createHash("sha256").update(JSON.stringify(sort(c)), "utf8").digest("hex")}`; };

if (out("rev-parse", "--git-dir") === null) { console.error("not a git repository: run this from inside the repository"); process.exit(2); }
if (out("rev-parse", "--verify", ref) === null) { console.error(`ref not found: ${ref}`); process.exit(2); }
const tree = new Set((out("-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref) ?? "").split("\n"));
const files = [...tree].filter((p) => /(^|\/)out[^/]*\/[^/]+\.handoff\.json$/.test(p));

let hashOk = 0, unparseable = 0, noHash = 0, evTotal = 0;
const failures = [];
for (const f of files) {
  const src = out("show", `${ref}:${f}`);
  let j; try { j = JSON.parse(src); } catch { failures.push({ kind: "UNPARSEABLE", record: f }); unparseable++; continue; }
  if (j.handoffHash === undefined) { failures.push({ kind: "NO_HASH", record: f }); noHash++; }
  else if (canon(j) === j.handoffHash) hashOk++;
  else failures.push({ kind: "HASH_MISMATCH", record: f, detail: `declared ${String(j.handoffHash).slice(0, 20)} recomputed ${canon(j).slice(0, 20)}` });
  for (const e of Array.isArray(j.evidence) ? j.evidence : []) { evTotal++; if (!tree.has(e)) failures.push({ kind: "EVIDENCE_UNTRACKED", record: f, detail: e }); }
}

console.log(`ref=${ref} records=${files.length}`);
console.log(`hashes recomputed ok=${hashOk} mismatch=${files.length - hashOk - unparseable - noHash} noHashField=${noHash} unparseable=${unparseable}`);
console.log(`declared evidence paths=${evTotal} absent from ${ref} tree=${failures.filter((f) => f.kind === "EVIDENCE_UNTRACKED").length}`);
if (failures.length === 0) { console.log("RESULT ok: every tracked record verifies from its committed bytes, and every file it vouches for is in the same tree"); process.exit(0); }
for (const f of failures) console.log(`  ${f.kind.padEnd(19)} ${f.record.replace("docs/specs/harness-reliability-bootstrap-20261103/", "")} ${f.detail ?? ""}`.trimEnd());
console.log(`RESULT FAIL (${failures.length})`);
process.exit(1);
