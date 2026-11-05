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
// "Has a ref" is itself too weak, because refs/stash, refs/notes/* and refs/original/* are refs
// that a clone never receives. git for-each-ref --contains counts them, so a pointer whose only
// carrier were a stash entry would look healthy here while being unrecoverable for everyone else.
// FETCHABLE below is what a clone can actually obtain. Proven rather than assumed: pointing a
// record at an object whose sole carrier is refs/stash made the first version of this gate call it
// healthy.
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
import { join } from "node:path";

const ref = process.argv[2] ?? "HEAD";
const FIELDS = ["baseSha", "resultSha", "nextBaseSha"];
// Refs a `git clone` transfers. refs/stash, refs/notes/*, refs/original/* and refs/bisect/* exist
// locally only -- counting them would let a stashed or rewrite-leftover object pass as reachable.
const FETCHABLE = (r) => r.startsWith("refs/heads/") || r.startsWith("refs/tags/") || r.startsWith("refs/remotes/");
// -c core.quotePath=false: without it git octal-escapes and quotes any path with a non-ASCII byte
// or a space, so such a record path would fail the regex below and be silently skipped -- an
// under-count that looks like a pass. Proven by adding a quoted path to a test tree.
const run = (...a) => spawnSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const ok = (...a) => run(...a).status === 0;
const out = (...a) => { const r = run(...a); return r.status === 0 ? r.stdout.trim() : null; };
const reach = (s) => /^[0-9a-f]{40}$/.test(String(s)) && ok("merge-base", "--is-ancestor", s, ref);

if (!ok("rev-parse", "--git-dir")) { console.error("not a git repository: run this from inside the repository"); process.exit(2); }
if (!ok("rev-parse", "--verify", ref)) { console.error(`ref not found: ${ref}`); process.exit(2); }
// The manifest lives beside the repository, so resolve it from the repo root rather than the
// caller's directory -- otherwise running the gate from anywhere but the root fails confusingly.
const root = out("rev-parse", "--show-toplevel");
const paths = out("ls-tree", "-r", "--name-only", ref).split("\n").filter((p) => /(^|\/)out[^/]*\/[^/]+\.handoff\.json$/.test(p));

const broken = new Map();                 // "record|field" -> { sha, defect, carriers }
let nulls = 0, healthy = 0, unparseable = 0, localOnly = 0;
for (const f of paths) {
  let j; try { j = JSON.parse(out("show", `${ref}:${f}`)); } catch { unparseable++; continue; }
  for (const field of FIELDS) {
    const sha = j[field];
    if (sha === null || sha === undefined) { nulls++; continue; }
    if (!/^[0-9a-f]{40}$/.test(String(sha))) { broken.set(`${f}|${field}`, { sha: String(sha), defect: "malformed" }); continue; }
    if (!ok("cat-file", "-e", `${sha}^{commit}`)) { broken.set(`${f}|${field}`, { sha, defect: "object_missing" }); continue; }
    const refs = (out("for-each-ref", "--contains", sha, "--format=%(refname)") ?? "").split("\n").filter(Boolean);
    if (refs.filter(FETCHABLE).length === 0) {
      // Distinguish "no ref at all" from "only a ref no clone will ever receive": the second is a
      // local-artifact problem and needs a different fix (push a branch, or re-stamp properly).
      broken.set(`${f}|${field}`, { sha, defect: refs.length ? "non_fetchable_ref_only" : "unreachable_from_any_ref", carriers: refs.map((r) => r.replace("refs/", "")) });
      continue;
    }
    healthy++;
    if (!refs.some((r) => r.startsWith("refs/remotes/"))) localOnly++;
  }
}

const man = JSON.parse(readFileSync(join(root, "docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-superseded.json"), "utf8"));
const failures = [];
const seenKey = new Set();
for (const e of man.entries) {
  const key = `${e.record}|${e.field}`;
  if (!FIELDS.includes(e.field)) { failures.push({ kind: "STALE", key, note: `unknown field ${e.field}` }); continue; }
  if (seenKey.has(key)) failures.push({ kind: "DUPLICATE", key });
  seenKey.add(key);
  const cur = broken.get(key);
  if (!cur) {
    // Three distinct states, deliberately told apart: healed pointer (prune), record removed, and
    // record present but unparseable -- the last is a defect in its own right, not a healed entry.
    const state = ok("cat-file", "-e", `${ref}:${e.record}`) ? (out("show", `${ref}:${e.record}`) ?? "").trim() === "" ? "empty" : "parses" : "absent";
    failures.push({
      kind: "DEFECT_GONE", key, sha: e.brokenSha,
      note: state === "absent" ? "record is not present at " + ref : state === "empty" ? "record is empty at " + ref + " (a real defect -- investigate, do not prune)" : "record is fine and the pointer now resolves; prune this entry",
    });
    continue;
  }
  if (cur.sha !== e.brokenSha) { failures.push({ kind: "STALE", key, manifest: e.brokenSha, actual: cur.sha }); continue; }
  if (cur.defect !== e.defect) failures.push({ kind: "STALE", key, note: `defect ${e.defect} -> ${cur.defect}` });
  if (e.kind === "superseded") {
    if (!e.replacement) failures.push({ kind: "BAD_REPL", key, note: "superseded entry has no replacement" });
    else if (!ok("cat-file", "-e", `${e.replacement}^{commit}`)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement, note: "object missing" });
    else if (!reach(e.replacement)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement.slice(0, 12), note: `not an ancestor of ${ref}` });
    // A replacement is only useful if someone else can obtain it, so it must sit on a clone-visible
    // ref, not merely be an ancestor of a local HEAD.
    else if ((out("for-each-ref", "--contains", e.replacement, "--format=%(refname)") ?? "").split("\n").filter(FETCHABLE).length === 0) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement.slice(0, 12), note: "carried by no fetchable ref (a clone cannot obtain it)" });
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
console.log(`healthy pointers carried only by local heads/tags, not yet on a remote (a clone of origin would not get them): ${localOnly}`);
console.log(`manifest=${man.schema} entries=${man.entries.length} superseded=${man.entries.filter((e) => e.kind === "superseded").length} unresolvable=${man.entries.filter((e) => e.kind === "unresolvable").length}`);
if (failures.length === 0) { console.log("RESULT ok: every commit pointer resolves from a ref, or is declared with a verified annotation"); process.exit(0); }
for (const f of failures) console.log(`  ${f.kind.padEnd(15)} ${f.key} ${f.sha ?? f.manifest ?? f.replacement ?? f.annotatedBy ?? ""} ${(f.note ?? "") + (f.carriers ? ` carriers=${f.carriers.join(",")}` : "")}`.trimEnd());
console.log(`RESULT FAIL (${failures.length})`);
process.exit(1);
