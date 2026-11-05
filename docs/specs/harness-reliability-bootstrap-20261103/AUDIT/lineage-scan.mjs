#!/usr/bin/env node
// Handoff-lineage reachability gate. Read-only.
//
//   node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs [ref]
//
// Every commit pointer in every tracked */out*/*.handoff.json -- baseSha, resultSha,
// nextBaseSha -- must either be null (schema-legal: nothing declared / the chain ends here)
// or name a commit that BOTH exists as an object AND is carried by at least one ref.
//
// Existence alone is the wrong test, and that is how earlier audits proved these pointers:
// an object can sit in the local object store with no ref carrying it, and a fresh clone only
// contains what refs carry. Such a record cannot be checked out, re-verified, or bisected by
// anyone who did not already hold the object -- the pointer is decorative.
//
// Known breaks are declared in lineage-superseded.json, never rewritten away: handoffHash binds
// every field to the logs the record vouches for (02-HANDOFF-PROTOCOL.md:15; canonicalHash at
// src/bootstrap/resultGate.ts:15). Two kinds:
//   superseded    has `replacement`, a reachable commit with a byte-identical subject
//   unresolvable  has `replacement: null` and `annotatedBy`, the reachable commit carrying this
//                 record and its evidence -- NOT a substitute for the lost pointer
// Fails on:
//   UNCOVERED      a broken pointer with no manifest entry
//   STALE          manifest sha/kind/defect no longer matches what the record says
//   DEFECT_GONE    the pointer healed or the record went missing -- prune or re-add the entry
//   BAD_REPL       a superseded replacement that is missing or unreachable from the audited ref
//   BAD_ANNOTATION an annotatedBy that is missing or unreachable, or an unresolvable entry that
//                  quietly carries a replacement
//   DUPLICATE      two entries for one (record, field), or a doubled record path
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ref = process.argv[2] ?? "HEAD";
const FIELDS = ["baseSha", "resultSha", "nextBaseSha"];
const run = (...a) => spawnSync("git", ["-C", process.cwd(), ...a], { encoding: "utf8" });
const ok = (...a) => run(...a).status === 0;
const out = (...a) => { const r = run(...a); return r.status === 0 ? r.stdout.trim() : null; };
const reach = (s) => /^[0-9a-f]{40}$/.test(String(s)) && ok("merge-base", "--is-ancestor", s, ref);

if (!ok("rev-parse", "--verify", ref)) { console.error(`ref not found: ${ref}`); process.exit(2); }
const paths = out("ls-tree", "-r", "--name-only", ref).split("\n").filter((p) => /(^|\/)out[^/]*\/[^/]+\.handoff\.json$/.test(p));

const broken = new Map();                 // "record|field" -> { sha, defect }
let nulls = 0, healthy = 0, unparseable = 0;
for (const f of paths) {
  let j; try { j = JSON.parse(out("show", `${ref}:${f}`)); } catch { unparseable++; continue; }
  for (const field of FIELDS) {
    const sha = j[field];
    if (sha === null || sha === undefined) { nulls++; continue; }
    if (!/^[0-9a-f]{40}$/.test(String(sha))) { broken.set(`${f}|${field}`, { sha: String(sha), defect: "malformed" }); continue; }
    if (!ok("cat-file", "-e", `${sha}^{commit}`)) { broken.set(`${f}|${field}`, { sha, defect: "object_missing" }); continue; }
    const refs = (out("for-each-ref", "--contains", sha, "--format=%(refname:short)") ?? "").split("\n").filter(Boolean);
    if (refs.length === 0) broken.set(`${f}|${field}`, { sha, defect: "unreachable_from_any_ref" });
    else healthy++;
  }
}

const man = JSON.parse(readFileSync("docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-superseded.json", "utf8"));
const failures = [];
const seenKey = new Set();
for (const e of man.entries) {
  const key = `${e.record}|${e.field}`;
  if (!FIELDS.includes(e.field)) { failures.push({ kind: "STALE", key, note: `unknown field ${e.field}` }); continue; }
  if (seenKey.has(key)) failures.push({ kind: "DUPLICATE", key });
  seenKey.add(key);
  const cur = broken.get(key);
  if (!cur) {
    // Either the pointer healed (prune the entry) or the record/field vanished (re-check it).
    let stillThere = true;
    try { JSON.parse(out("show", `${ref}:${e.record}`)); } catch { stillThere = false; }
    failures.push({ kind: "DEFECT_GONE", key, sha: e.brokenSha, note: stillThere ? "pointer now resolves; prune this entry" : "record no longer parses at " + ref });
    continue;
  }
  if (cur.sha !== e.brokenSha) { failures.push({ kind: "STALE", key, manifest: e.brokenSha, actual: cur.sha }); continue; }
  if (cur.defect !== e.defect) failures.push({ kind: "STALE", key, note: `defect ${e.defect} -> ${cur.defect}` });
  if (e.kind === "superseded") {
    if (!e.replacement) failures.push({ kind: "BAD_REPL", key, note: "superseded entry has no replacement" });
    else if (!ok("cat-file", "-e", `${e.replacement}^{commit}`)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement, note: "object missing" });
    else if (!reach(e.replacement)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement.slice(0, 12), note: `not reachable from ${ref}` });
  } else if (e.kind === "unresolvable") {
    if (e.replacement) failures.push({ kind: "BAD_ANNOTATION", key, note: "unresolvable entry must not carry a replacement" });
    if (!e.annotatedBy) failures.push({ kind: "BAD_ANNOTATION", key, note: "no annotatedBy" });
    else if (!reach(e.annotatedBy)) failures.push({ kind: "BAD_ANNOTATION", key, annotatedBy: e.annotatedBy.slice(0, 12), note: `not reachable from ${ref}` });
  } else failures.push({ kind: "STALE", key, note: `unknown kind ${e.kind}` });
}
for (const [key, b] of broken) if (!seenKey.has(key)) failures.push({ kind: "UNCOVERED", key, sha: String(b.sha).slice(0, 12), defect: b.defect });

const dup = new Set(), seenPath = new Set();
for (const f of paths) { if (seenPath.has(f)) dup.add(f); seenPath.add(f); }
for (const f of dup) failures.push({ kind: "DUPLICATE", key: f });

console.log(`ref=${ref} records=${paths.length} fields=${FIELDS.length}`);
console.log(`pointers healthy=${healthy} nullDeclared=${nulls} broken=${broken.size} unparseableRecords=${unparseable}`);
console.log(`manifest=${man.schema} entries=${man.entries.length} superseded=${man.entries.filter((e) => e.kind === "superseded").length} unresolvable=${man.entries.filter((e) => e.kind === "unresolvable").length}`);
if (failures.length === 0) { console.log("RESULT ok: every commit pointer resolves from a ref, or is declared with a verified annotation"); process.exit(0); }
for (const f of failures) console.log(`  ${f.kind.padEnd(15)} ${f.key} ${f.sha ?? f.manifest ?? f.replacement ?? f.annotatedBy ?? ""} ${f.note ?? ""}`.trimEnd());
console.log(`RESULT FAIL (${failures.length})`);
process.exit(1);
