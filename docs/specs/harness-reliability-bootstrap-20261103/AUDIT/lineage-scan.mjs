#!/usr/bin/env node
// Handoff-lineage reachability gate. Read-only.
//
//   node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs [ref]
//
// For every tracked */out*/*.handoff.json, nextBaseSha must either be null (the chain
// legitimately ends there -- the schema allows string|null) or name a commit that BOTH
// exists as an object AND is carried by at least one ref. Existence alone is not enough:
// a fresh clone only contains what refs carry, so a pointer to a dangling object cannot
// be checked out, re-verified, or bisected -- and `git cat-file -e`, which earlier audits
// used, passes for those pointers.
//
// Known breaks are not rewritten away (each record's handoffHash binds its nextBaseSha,
// so editing the record breaks the binding to its recorded logs). They are declared in
// lineage-superseded.json with a live replacement. This script fails on ANY of:
//   UNCOVERED  a broken record with no manifest entry
//   STALE      a manifest entry whose record no longer has the declared broken pointer
//   DEFECT_GONE a manifest entry whose defect no longer reproduces (fix landed; prune it)
//   BAD_REPL   a manifest replacement that is itself unreachable from the audited ref
//   DUPLICATE  a manifest entry pointing at a missing object, or a doubled record path
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ref = process.argv[2] ?? "HEAD";
const run = (...a) => spawnSync("git", ["-C", process.cwd(), ...a], { encoding: "utf8" });
const ok = (...a) => run(...a).status === 0;
const out = (...a) => { const r = run(...a); return r.status === 0 ? r.stdout.trim() : null; };

if (!ok("rev-parse", "--verify", ref)) { console.error(`ref not found: ${ref}`); process.exit(2); }
const listing = out("ls-tree", "-r", "--name-only", ref);
const records = listing.split("\n").filter((p) => /(^|\/)out[^/]*\/[^/]+\.handoff\.json$/.test(p));

const broken = new Map();          // record path -> { sha, defect, taskId }
let nulls = 0, healthy = 0, unparseable = 0;
for (const f of records) {
  let j; try { j = JSON.parse(out("show", `${ref}:${f}`)); } catch { unparseable++; continue; }
  const sha = j.nextBaseSha;
  if (sha === null || sha === undefined) { nulls++; continue; }
  if (!/^[0-9a-f]{40}$/.test(String(sha))) { broken.set(f, { sha: String(sha), defect: "malformed", taskId: j.taskId }); continue; }
  if (!ok("cat-file", "-e", `${sha}^{commit}`)) { broken.set(f, { sha, defect: "object_missing", taskId: j.taskId }); continue; }
  const refs = (out("for-each-ref", "--contains", sha, "--format=%(refname:short)") ?? "").split("\n").filter(Boolean);
  if (refs.length === 0) broken.set(f, { sha, defect: "unreachable_from_any_ref", taskId: j.taskId });
  else healthy++;
}

const manifestPath = "docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-superseded.json";
const man = JSON.parse(readFileSync(manifestPath, "utf8"));
const byRecord = new Map();
const failures = [];
for (const e of man.entries) {
  if (byRecord.has(e.record)) failures.push({ kind: "DUPLICATE", record: e.record });
  byRecord.set(e.record, e);
  if (!broken.has(e.record)) { failures.push({ kind: "DEFECT_GONE", record: e.record, sha: e.brokenNextBaseSha }); continue; }
  const cur = broken.get(e.record);
  if (cur.sha !== e.brokenNextBaseSha) { failures.push({ kind: "STALE", record: e.record, manifest: e.brokenNextBaseSha, actual: cur.sha }); continue; }
  if (cur.defect !== e.defect) failures.push({ kind: "STALE", record: e.record, note: `defect ${e.defect} -> ${cur.defect}` });
  if (!ok("cat-file", "-e", `${e.replacement}^{commit}`)) { failures.push({ kind: "BAD_REPL", record: e.record, replacement: e.replacement, note: "object missing" }); continue; }
  if (!ok("merge-base", "--is-ancestor", e.replacement, ref)) failures.push({ kind: "BAD_REPL", record: e.record, replacement: e.replacement, note: "not reachable from " + ref });
}
for (const [f, b] of broken) if (!byRecord.has(f)) failures.push({ kind: "UNCOVERED", record: f, sha: b.sha, defect: b.defect });

const dup = new Set(); const seen = new Set();
for (const f of records) { if (seen.has(f)) dup.add(f); seen.add(f); }
for (const f of dup) failures.push({ kind: "DUPLICATE", record: f });

console.log(`ref=${ref} records=${records.length} healthy=${healthy} nullTerminated=${nulls} broken=${broken.size} unparseable=${unparseable}`);
console.log(`manifest=${man.schema} entries=${man.entries.length}`);
if (failures.length === 0) { console.log("RESULT ok: every non-null nextBaseSha is reachable, or declared with a reachable replacement"); process.exit(0); }
for (const f of failures) console.log(`  ${f.kind.padEnd(12)} ${f.record} ${f.sha ?? f.replacement ?? ""} ${f.note ?? ""}`.trimEnd());
console.log(`RESULT FAIL (${failures.length})`);
process.exit(1);
