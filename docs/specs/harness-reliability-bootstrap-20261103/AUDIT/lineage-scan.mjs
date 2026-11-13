#!/usr/bin/env node
// Handoff-lineage reachability gate. Read-only.
//
//   node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs [ref]
//
// Every commit pointer in every tracked record -- baseSha, resultSha, nextBaseSha -- must either be
// null (schema-legal: nothing declared / the chain ends here) or name a commit that BOTH exists as an
// object AND is carried by at least one ref a clone of this repository would receive.
//
// A record is `<unit>/out*/<ID>.handoff.json` (a generation) or `<unit>/<ID>.handoff.json` (a
// unit-directory record: the D-series and the corrected T-series). The header used to name only the
// first shape and the code agreed with it, which left 41 records whose pointers no gate resolved.
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
// src/bootstrap/resultGate.ts:15). Three kinds:
//   superseded    has `replacement`, a reachable commit with a byte-identical subject
//   unresolvable  has `replacement: null` and `annotatedBy`, the reachable commit carrying this
//                 record and its evidence -- NOT a substitute for the lost pointer
//   abbreviated   the pointer was stamped as a git abbreviation ("9f064450") instead of the full
//                 40-hex name: the commit is live and unchanged, the record just did not spell it
//                 out. `replacement` must be that commit in full and the gate PROVES the pairing --
//                 the abbreviation has to denote exactly one commit here -- so the entry cannot
//                 vouch for a guess. `annotatedBy` must be a LATER commit than the one whose pointer
//                 is abbreviated, never that commit itself. Added by X11 after it caught X08/out
//                 resultSha; the writer never checked the shape (templates/handoff.schema.json says
//                 only {"type": "string"} for the three commit pointers), so this kind declares a
//                 defect class the writer is still able to produce, not a permanent exemption.
// Fails on:
//   UNCOVERED      a broken pointer with no manifest entry
//   STALE          manifest sha/kind/defect no longer matches what the record says
//                  (a lost object's two spellings -- unreachable_from_any_ref where the object is
//                   still present, object_missing in a clone of the remote -- are one class:
//                   see DEFECT_ALIASES, so the gate does not depend on where it is run)
//   DEFECT_GONE    the pointer healed or the record went missing -- prune or re-add the entry
//   BAD_REPL       a superseded replacement that is missing or unreachable from the audited ref
//   BAD_ANNOTATION an annotatedBy that is missing or unreachable, an unresolvable entry that quietly
//                  carries a replacement, or an abbreviated entry that self-certifies -- annotatedBy
//                  is the same commit as, or earlier than, the pointer it declares
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
// One git call per sha, not per mention. The trail names the same commits over and over -- a chain
// unit's nextBaseSha is its child's baseSha, and a unit-directory record repeats its generation's
// pointers -- and both `merge-base --is-ancestor` and `for-each-ref --contains` walk history on every
// call. Measured -- medians of three warm runs on one machine -- widening to 160 records took 7.26 s
// to 9.51 s, and with these two caches it is 5.70 s: faster than the narrower scan ran without them.
const reachCache = new Map();
const reach = (s) => {
  if (!/^[0-9a-f]{40}$/.test(String(s))) return false;
  if (!reachCache.has(s)) reachCache.set(s, ok("merge-base", "--is-ancestor", s, ref));
  return reachCache.get(s);
};
const carriersCache = new Map();
const carriers = (sha) => {
  if (!carriersCache.has(sha)) {
    const refs = ((out("for-each-ref", "--contains", sha, "--format=%(refname)") ?? "").split("\n").filter(Boolean));
    carriersCache.set(sha, { all: refs, fetchable: refs.filter(FETCHABLE).length });
  }
  return carriersCache.get(sha);
};

// One defect, two spellings, and the environment picks which one you see: an object that is gone from
// the refs reads `unreachable_from_any_ref` in the checkout that still holds it as a dangling object,
// and `object_missing` in a clone of the remote, where it never arrived. Measured at one commit with
// the manifest unchanged: the working checkout reported 8 STALE defects and a fresh clone of the same
// commit reported `RESULT ok` -- the gate was failing on where it was run, not on the repository. So a
// declared defect accepts its alias. Everything else about the entry is still checked exactly: the SHA,
// the record's state, the kind, and the annotation/replacement chain.
//
// What the alias does NOT claim: that the two spellings carry the same *recovery* prospect. While the
// object still exists locally it can be pushed back onto a ref; once it is pruned it cannot. That is
// why an alias that fires is printed (below, as `alias applied`) instead of passing unnoticed.
const DEFECT_ALIASES = {
  unreachable_from_any_ref: ["object_missing"],
  object_missing: ["unreachable_from_any_ref"],
  // `non_fetchable_ref_only` is deliberately NOT an alias. It says the object EXISTS and has a ref --
  // just one a clone never receives (refs/stash, refs/notes/*, refs/original/*) -- and its fix is "push
  // a branch", not "the commit is gone". Folding it in would let a declared lost-commit entry pass
  // because somebody stashed on top of it. Measured at this commit: 0 pointers carry that defect, so
  // excluding it costs nothing today and keeps the two fixes distinguishable tomorrow.
};
const defectMatches = (declared, actual) => declared === actual || (DEFECT_ALIASES[declared] ?? []).includes(actual);

if (!ok("rev-parse", "--git-dir")) { console.error("not a git repository: run this from inside the repository"); process.exit(2); }
if (!ok("rev-parse", "--verify", ref)) { console.error(`ref not found: ${ref}`); process.exit(2); }
// The manifest lives beside the repository, so resolve it from the repo root rather than the
// caller's directory -- otherwise running the gate from anywhere but the root fails confusingly.
const root = out("rev-parse", "--show-toplevel");

// Reachability is a question about history, and a shallow clone does not hold the history. Measured
// at this commit with the manifest unchanged: a full clone reports broken=30 and a 50-commit clone of
// the same commit reports broken=219, because a pointer whose ancestors were never fetched cannot be
// shown reachable and is filed as a defect. A truncated checkout is then read as damage to the chain,
// which is the inverse of the error this scanner was written for. Say the environment is unfit (exit
// 2) instead of letting it speak. Today the gate is hand-run -- `.woodpecker/ci.yaml` runs no trail
// scan -- so this protects manual runs; if the scans join the pipeline (PR #661's draft step) the
// `checkout` step there fetches full history with all branches and tags, so a CI run would not land
// here either. `?? ""` because `out` returns null when git errors, and `rev-parse
// --is-shallow-repository` does error on git older than 2.15: without the guard the probe threw a
// TypeError and exited 1 with a stack trace, which reads as a scan failure rather than an old git.
// A hand-run in a shallow clone should re-clone, not chase 189 phantoms.
if ((out("rev-parse", "--is-shallow-repository") ?? "").trim() === "true") {
  console.log("manifest=harness-reliability-lineage-superseded/v2 (not consulted -- history is shallow)");
  console.log("RESULT not-evaluated: this is a shallow clone, so ancestry cannot be judged from it");
  console.log("  re-run against a full clone: git clone (no --depth) or git fetch --unshallow");
  process.exit(2);
}
// Which files are records. Generation directories (`<unit>/out*/<ID>.handoff.json`) were the whole
// story until today; the trail also holds unit-directory records (`<unit>/<ID>.handoff.json` -- the
// D-series and the corrected T-series, 41 files), and those records declare baseSha / resultSha /
// nextBaseSha exactly as the generations do. Walking only generations left 41 records whose pointers
// no gate ever resolved, which is the same shape of gap #660 closed for hashes: the pointer check
// printed `RESULT ok` over 119 of the 160 records. Widening costs one record's worth of new defects
// (H07/H07.handoff.json, three pointers, declared in the manifest alongside its out-corrected twin).
// Cost, medians of three warm runs on one machine (the first cold run of the widened scan read 27.5 s,
// which is why these are medians and not one run each):
//   119 records, no carrier cache   7.26 s
//   160 records, no carrier cache   9.51 s
//   160 records, with carrier cache 5.70 s
// so the wider scan is faster than the narrower one was before the cache existed.
//
// `fixtures/` is deliberately NOT a record shape here even though `record-reproducibility.mjs` names
// it: a payload fixture is a byte-copy of another record of the same unit, so its pointers are that
// record's pointers, and re-declaring them per fixture path would put the same lost commit under
// several manifest keys that can drift apart. (Moot in practice -- no fixture carries the
// `.handoff.json` suffix today.)
const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
const shapeOf = (p) => {
  if (!p.endsWith(".handoff.json")) return "not-a-record";
  const parts = p.split("/");
  const file = parts.pop();
  const dir = parts.pop() ?? "";
  const stem = file.replace(/\.handoff\.json$/, "");
  if (/^out[^/]*$/.test(dir)) return "generation";
  if (dir === stem) return "unit-directory";
  if (dir === "fixtures") return "fixture-copy";   // a byte-copy of another record; see the note above
  return "unclassified";
};
// Fail open never. A record whose name matches no known shape used to be skipped silently -- the same
// under-count the `core.quotePath` comment above was written about, one level up: `T05/T05-v2.handoff.json`
// or `H07/H07.corrected.handoff.json` is a record by any reading, and the old filter walked past it
// while `records=` kept looking plausible.
const allHandoffs = out("ls-tree", "-r", "--name-only", ref).split("\n").filter((p) => p.endsWith(".handoff.json"));
const shapeCount = (want) => allHandoffs.filter((p) => shapeOf(p) === want).length;
const unclassified = allHandoffs.filter((p) => p.startsWith(SPEC + "/") && shapeOf(p) === "unclassified");
const outsideTrail = allHandoffs.filter((p) => !p.startsWith(SPEC + "/"));
const paths = allHandoffs.filter((p) => ["generation", "unit-directory"].includes(shapeOf(p)));

const broken = new Map();                 // "record|field" -> { sha, defect, carriers }
const aliasApplied = [];               // entries whose observed defect is the alias of the declared one
let nulls = 0, healthy = 0, unparseable = 0, localOnly = 0, nonOriginOnly = 0;
for (const f of paths) {
  let j; try { j = JSON.parse(out("show", `${ref}:${f}`)); } catch { unparseable++; continue; }
  for (const field of FIELDS) {
    const sha = j[field];
    if (sha === null || sha === undefined) { nulls++; continue; }
    if (!/^[0-9a-f]{40}$/.test(String(sha))) { broken.set(`${f}|${field}`, { sha: String(sha), defect: "malformed" }); continue; }
    if (!ok("cat-file", "-e", `${sha}^{commit}`)) { broken.set(`${f}|${field}`, { sha, defect: "object_missing" }); continue; }
    const refs = carriers(sha).all;
    if (carriers(sha).fetchable === 0) {
      // Distinguish "no ref at all" from "only a ref no clone will ever receive": the second is a
      // local-artifact problem and needs a different fix (push a branch, or re-stamp properly).
      broken.set(`${f}|${field}`, { sha, defect: refs.length ? "non_fetchable_ref_only" : "unreachable_from_any_ref", carriers: refs.map((r) => r.replace("refs/", "")) });
      continue;
    }
    healthy++;
    if (!refs.some((r) => r.startsWith("refs/remotes/"))) localOnly++;
    // FETCHABLE counts any `refs/remotes/*`, but a clone of THIS repository receives only what its
    // origin carries. A pointer held solely by a second remote (an `upstream` someone added, as the
    // H-series records' own repository might be added one day) is healthy here and `object_missing`
    // for everyone else. Measured at this commit: 0 of 425 healthy pointers are in that class, so this
    // is a tripwire rather than a fix -- deciding what origin really carries means asking origin, and
    // a gate that needs the network to answer is a gate that goes red on a plane.
    else if (!refs.some((r) => r.startsWith("refs/remotes/origin/"))) nonOriginOnly++;
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
  if (!defectMatches(e.defect, cur.defect)) failures.push({ kind: "STALE", key, note: `defect ${e.defect} -> ${cur.defect}` });
  // Accepted, but said out loud: `unreachable_from_any_ref -> object_missing` means the object was
  // recoverable when the entry was written and is not now. Failing the run would be wrong (the entry
  // is still true), and silence would drop the only signal that the window to push it closed.
  else if (e.defect !== cur.defect) aliasApplied.push(`${key} ${e.defect} -> ${cur.defect}`);
  if (e.kind === "superseded") {
    if (!e.replacement) failures.push({ kind: "BAD_REPL", key, note: "superseded entry has no replacement" });
    else if (!ok("cat-file", "-e", `${e.replacement}^{commit}`)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement, note: "object missing" });
    else if (!reach(e.replacement)) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement.slice(0, 12), note: `not an ancestor of ${ref}` });
    // A replacement is only useful if someone else can obtain it, so it must sit on a clone-visible
    // ref, not merely be an ancestor of a local HEAD.
    else if (carriers(e.replacement).fetchable === 0) failures.push({ kind: "BAD_REPL", key, replacement: e.replacement.slice(0, 12), note: "carried by no fetchable ref (a clone cannot obtain it)" });
  } else if (e.kind === "unresolvable") {
    if (e.replacement) failures.push({ kind: "BAD_ANNOTATION", key, note: "unresolvable entry must not carry a replacement" });
    if (!e.annotatedBy) failures.push({ kind: "BAD_ANNOTATION", key, note: "no annotatedBy" });
    else if (!reach(e.annotatedBy)) failures.push({ kind: "BAD_ANNOTATION", key, annotatedBy: e.annotatedBy.slice(0, 12), note: `not reachable from ${ref}` });
  } else if (e.kind === "abbreviated") {
    // Proof, not trust: the abbreviation must name exactly one commit in this repository, the entry's
    // replacement must be that commit spelled in full, and it must pass the same three reachability
    // tests a `superseded` replacement passes. Nothing here is weaker than a full sha -- a correct
    // `abbreviated` entry asserts strictly more than "some commit starting with these bytes exists".
    const abbr = String(e.brokenSha);
    const repl = String(e.replacement ?? "");
    const carrierCount = (r) => carriers(r).fetchable;
    if (!/^[0-9a-f]{7,39}$/.test(abbr)) failures.push({ kind: "BAD_ANNOTATION", key, note: `brokenSha is not a git abbreviation: ${abbr}` });
    else if (!/^[0-9a-f]{40}$/.test(repl)) failures.push({ kind: "BAD_ANNOTATION", key, note: "abbreviated entry must carry the replacement in full 40-hex form" });
    else {
      // Which commits could the abbreviation mean? `git rev-parse --disambiguate=<prefix>` looks like
      // the purpose-built answer and is not one: on this repository prefix "9" returned ONE object
      // while 161 reachable commits begin with "9" (prefix "9f" returned 97 objects, 17 of them
      // commits). Enumerating the reachable commits and filtering is both authoritative and cheap here
      // -- 2388 commits, 0.03 s -- and "reachable" is the right universe anyway, because a pointer is
      // only worth following to a commit someone else can fetch.
      const named = (out("rev-list", "--all") ?? "").split("\n").filter((c) => c.startsWith(abbr));
      if (named.length !== 1) failures.push({ kind: "BAD_ANNOTATION", key, note: `abbreviation ${abbr} denotes ${named.length} reachable commits, not one` });
      else if (named[0] !== repl) failures.push({ kind: "BAD_ANNOTATION", key, replacement: repl.slice(0, 12), note: `${abbr} names ${named[0].slice(0, 12)}, not this replacement` });
      else if (!ok("cat-file", "-e", `${repl}^{commit}`)) failures.push({ kind: "BAD_REPL", key, replacement: repl.slice(0, 12), note: "object missing" });
      else if (!reach(repl)) failures.push({ kind: "BAD_REPL", key, replacement: repl.slice(0, 12), note: `not an ancestor of ${ref}` });
      else if (carrierCount(repl) === 0) failures.push({ kind: "BAD_REPL", key, replacement: repl.slice(0, 12), note: "carried by no fetchable ref (a clone cannot obtain it)" });
      else if (!e.annotatedBy) failures.push({ kind: "BAD_ANNOTATION", key, note: "no annotatedBy naming the commit that carries the record" });
      else if (!reach(e.annotatedBy)) failures.push({ kind: "BAD_ANNOTATION", key, annotatedBy: String(e.annotatedBy).slice(0, 12), note: `not reachable from ${ref}` });
      // Anti-self-certification. A pointer is stamped wrong by the commit that carries the record, so
      // that commit cannot also be the one declaring it: at the moment it is written nobody has looked
      // at the shape yet, and the record would be vouching for itself. The declaration has to come
      // from a later commit, which is what makes it evidence somebody actually read the pointer.
      else if (e.annotatedBy === repl) failures.push({ kind: "BAD_ANNOTATION", key, annotatedBy: String(e.annotatedBy).slice(0, 12), note: "the commit whose pointer is abbreviated cannot declare its own defect" });
      else if (Number(out("show", "--no-patch", "--format=%ct", e.annotatedBy)) < Number(out("show", "--no-patch", "--format=%ct", repl))) failures.push({ kind: "BAD_ANNOTATION", key, annotatedBy: String(e.annotatedBy).slice(0, 12), note: `precedes the defect commit ${repl.slice(0, 12)} it declares (committer date)` });
    }
  } else failures.push({ kind: "STALE", key, note: `unknown kind ${e.kind}` });
}
for (const [key, b] of broken) if (!seenKey.has(key)) failures.push({ kind: "UNCOVERED", key, sha: String(b.sha).slice(0, 12), defect: b.defect });

const dup = new Set(), seenPath = new Set();
for (const f of paths) { if (seenPath.has(f)) dup.add(f); seenPath.add(f); }
for (const f of dup) failures.push({ kind: "DUPLICATE", key: f });

for (const u of unclassified) failures.push({ kind: "UNCLASSIFIED_RECORD", key: u, note: "a *.handoff.json in the trail matching no known record shape -- add the shape, do not skip it" });
console.log(`ref=${ref} records=${paths.length} (generation=${shapeCount("generation")}, unit-directory=${shapeCount("unit-directory")}) fields=${FIELDS.length} fixture-copies-skipped=${shapeCount("fixture-copy")} outside-trail=${outsideTrail.length}`);
for (const a of aliasApplied) console.log(`  alias applied     ${a}`);
if (aliasApplied.length) console.log(`  (${aliasApplied.length} entry/entries matched through the alias; the object is no longer present locally, so re-pointing it onto a ref is no longer possible)`);
console.log(`pointers healthy=${healthy} nullDeclared=${nulls} broken=${broken.size} unparseableRecords=${unparseable}`);
console.log(`healthy pointers carried only by local heads/tags, not yet on a remote (a clone of origin would not get them): ${localOnly}`);
console.log(`healthy pointers carried only by a NON-origin remote (a clone of this repository would not get them): ${nonOriginOnly}`);
const kindCount = (k) => man.entries.filter((e) => e.kind === k).length;
console.log(`manifest=${man.schema} entries=${man.entries.length} superseded=${kindCount("superseded")} unresolvable=${kindCount("unresolvable")} abbreviated=${kindCount("abbreviated")}`);
if (failures.length === 0) { console.log("RESULT ok: every commit pointer resolves from a ref, or is declared with a verified annotation"); process.exit(0); }
for (const f of failures) console.log(`  ${f.kind.padEnd(15)} ${f.key} ${f.sha ?? f.manifest ?? f.replacement ?? f.annotatedBy ?? ""} ${(f.note ?? "") + (f.carriers ? ` carriers=${f.carriers.join(",")}` : "")}`.trimEnd());
console.log(`RESULT FAIL (${failures.length})`);
process.exit(1);
