#!/usr/bin/env node
// Manifest-binding gate: does each record's declared authority come from its manifest, and does each
// manifest's declared parent come from a record? Read-only.
//
//   node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/manifest-binding-scan.mjs [ref]
//
// The four existing gates walk the chain by COMMIT pointer (integrity-scan, lineage-scan) and by
// BYTES (record-reproducibility), and the citation gate walks prose. None of them reads the two hash
// edges that connect a task to its manifest and a task to its parent task:
//
//   record.taskAuthorityHash   -- the canonical hash of the task's manifest (FIX-4A: the PARSED
//                                 manifest, src/bootstrap/taskManifest.ts:104; the protocol is stated
//                                 at src/bootstrap/resultGate.ts:47-51)
//   manifest.parentHandoffHash -- the handoffHash of the record this task was handed off from
//
// Those are the only places the trail says WHICH manifest a record was stamped from and WHICH record
// a manifest descended from. Nothing checked them, and that absence is what let two defects sit in a
// green pipeline: a record whose authority was the RAW manifest where the protocol requires the
// PARSED one, and a manifest whose parent hash names no record that exists. Both are declared in
// AUDIT/manifest-binding-declared.json now, and both were invisible before this file existed.
//
// Existence is not the test on either edge. A parent hash that resolves to a record is only half an
// edge: integrity-scan certifies the chain in the COMMIT direction (parent.nextTaskId@nextBaseSha ->
// child taskId@baseSha), so a parent that accepts a handoff by hash while declaring nextBaseSha null
// leaves a link only one participant believes in -- and this scan found one. Symmetrically, a record
// whose authority matches a manifest is only sound if that manifest is the manifest the parser would
// have accepted for that task, so the manifest and the record must agree about task id and base
// commit, and the manifest must parse: a manifest only this file can read is not a manifest.
//
// The parsed manifest is what the protocol hashes, and the parser is TypeScript. This gate runs in CI
// before `npm install` (`.woodpecker/ci.yaml`: trail-scans precedes install, so a red install cannot
// hide a red trail), so it cannot import parseTaskManifest -- it reimplements the normalization
// below. That reimplementation is not trusted:
// test/unit/manifest-binding-parser-agreement.test.ts asserts, under tsx after install, that
// normalizeManifest() and parseTaskManifest() agree on every tracked manifest. Both halves run on
// every pipeline.
//
// Fails on:
//   AUTHORITY-MISMATCH  record.taskAuthorityHash is not canonicalHash(parsed manifest) at the audited
//                       ref, and no declaration explains it
//   NO-MANIFEST         a record carrying taskAuthorityHash whose unit tracks no manifest
//   UNPARSEABLE         a tracked manifest the parser would reject, so its parsed hash is not an
//                       authority
//   UNIT-DISAGREE       manifest.taskId/baseSha does not match the record whose manifest it is
//   PARENT-UNRESOLVED   manifest.parentHandoffHash names no tracked record's handoffHash
//   PARENT-AMBIGUOUS    it resolves to records in more than one unit (a unit-directory record and its
//                       generation share bytes and so share a hash: that is one unit, and fine)
//   EDGE-ABSENT         a child manifest names this record parent while the record declares
//                       nextBaseSha null: the hash edge exists, the commit edge does not
//   EDGE-WRONG          the parent declares a forward edge, but to another task or another base
// Declarations are re-verified every run, never trusted, exactly as AUDIT/lineage-scan.mjs treats its
// own, so a declaration cannot rot into a permanent exemption:
//   STALE               the entry's kind or observed value no longer matches the record
//   DECL-GONE           the deviation healed, or the record went missing -- prune the entry
//   BAD-DECLARATION     a required field missing, two entries for one (record|manifest, kind),
//                       annotatedBy unreachable from the audited ref, or an entry for a record that
//                       shows no deviation at all
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- canonicalHash and the parsed manifest ---------------------------------------------
// canonicalHash per 02-HANDOFF-PROTOCOL.md:15 and src/bootstrap/resultGate.ts:30: sorted keys at
// every level, compact JSON, UTF-8, handoffHash excluded. Object.fromEntries, not `o[k] = v`, so a
// `__proto__` key stays an ordinary key (record-reproducibility.mjs:14 records what the assignment
// form did to the audit hash and the producer hash).
const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
export const canon = (r) => { const c = { ...r }; delete c.handoffHash; return `sha256:${createHash("sha256").update(JSON.stringify(sort(c)), "utf8").digest("hex")}`; };

// normalizeManifest mirrors parseTaskManifest's SUCCESS path (src/bootstrap/taskManifest.ts:53-106):
// keep only the known fields, apply the three defaults, and reduce each command to {argv, cwd} --
// the parser rebuilds command objects, so extra keys inside a command never reach the authority hash
// while extra keys at the top level make the manifest invalid instead. It returns {errors} for a
// manifest the parser would reject; the caller must not treat such a manifest's hash as an authority.
const FIELDS = ["taskId", "baseSha", "repoId", "objective", "allowPaths", "denyPaths", "commands", "limits", "parentHandoffHash", "expectedOutputs", "mode"];
const OPTIONAL = ["limits", "denyPaths", "expectedOutputs"];
const LIMIT_FIELDS = ["maxProductionFiles", "maxTestFiles", "maxChangedLines"];
const DEFAULTS = { limits: { maxProductionFiles: 1, maxTestFiles: 1, maxChangedLines: 100 }, denyPaths: [], expectedOutputs: [] };
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const pathsOk = (v) => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string" && p.trim() !== "");
const countOk = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const MODES = ["read-only", "isolated-change", "herdr-ui"];
const CEIL = { maxProductionFiles: 2, maxTestFiles: 2, maxChangedLines: 100 };
const MODE_CEIL = { "read-only": 100, "isolated-change": 100, "herdr-ui": 120 };
export function normalizeManifest(input) {
  const errors = [];
  if (!isObj(input)) return { errors: ["manifest: expected a JSON object"] };
  for (const k of Object.keys(input).filter((k) => !FIELDS.includes(k)).sort()) errors.push(`unknown field: ${k}`);
  for (const f of FIELDS) if (!OPTIONAL.includes(f) && input[f] === undefined) errors.push(`${f}: missing`);
  for (const f of ["taskId", "baseSha", "repoId", "objective"]) {
    const v = text(input[f]);
    if (v === undefined) errors.push(`${f}: expected a non-empty string`);
    else if (f === "baseSha" && !/^[0-9a-f]{7,64}$/.test(v)) errors.push(`${f}: expected 7-64 hex characters`);
  }
  if (!pathsOk(input.allowPaths)) errors.push("allowPaths: expected a non-empty array of paths");
  if (input.denyPaths !== undefined && !(Array.isArray(input.denyPaths) && input.denyPaths.every((p) => typeof p === "string" && p.trim() !== ""))) errors.push("denyPaths: expected an array of paths");
  if (!Array.isArray(input.commands) || input.commands.length === 0) errors.push("commands: expected a non-empty array");
  else input.commands.forEach((c, i) => {
    if (!isObj(c)) errors.push(`commands[${i}]: expected an object`);
    else {
      if (!pathsOk(c.argv)) errors.push(`commands[${i}].argv: expected a non-empty argv array`);
      if (text(c.cwd) === undefined) errors.push(`commands[${i}].cwd: expected a non-empty string`);
    }
  });
  const mode = text(input.mode);
  const knownMode = mode !== undefined && MODES.includes(mode) ? mode : undefined;
  if (knownMode === undefined) errors.push(`mode: expected one of ${MODES.join(", ")}`);
  const lineCeiling = knownMode === undefined ? CEIL.maxChangedLines : MODE_CEIL[knownMode];
  const limits = input.limits ?? DEFAULTS.limits;
  if (!isObj(limits)) errors.push("limits: expected an object");
  else {
    for (const k of LIMIT_FIELDS) {
      const ceiling = k === "maxChangedLines" ? lineCeiling : CEIL[k];
      if (!countOk(limits[k])) errors.push(`limits.${k}: expected a non-negative integer`);
      else if (limits[k] > ceiling) errors.push(`limits.${k}: ${limits[k]} exceeds ceiling ${ceiling}`);
    }
    for (const k of Object.keys(limits).filter((k) => !LIMIT_FIELDS.includes(k)).sort()) errors.push(`unknown field: limits.${k}`);
  }
  const parent = input.parentHandoffHash;
  if (!(parent === null || (typeof parent === "string" && /^sha256:[0-9a-f]{64}$/.test(parent)))) errors.push("parentHandoffHash: expected null or sha256:<64 hex>");
  if (input.expectedOutputs !== undefined && !(Array.isArray(input.expectedOutputs) && input.expectedOutputs.every((p) => typeof p === "string" && p.trim() !== ""))) errors.push("expectedOutputs: expected an array of paths");
  if (errors.length > 0) return { errors: [...new Set(errors)].sort() };
  const m = {};
  for (const f of FIELDS) m[f] = input[f] !== undefined ? input[f] : f in DEFAULTS ? DEFAULTS[f] : undefined;
  m.commands = m.commands.map((c) => ({ argv: c.argv, cwd: c.cwd }));
  const l = {}; for (const k of LIMIT_FIELDS) l[k] = m.limits[k]; m.limits = l;
  return { manifest: m };
}


// The scan runs when this file is EXECUTED, not when it is imported. test/unit/
// manifest-binding-parser-agreement.test.ts imports normalizeManifest and canon to pin them against the real
// parseTaskManifest; without this guard that import would run the whole scan and could process.exit(2) the
// test runner from a helper module.
const isMain = await import("url").then((u) => u.pathToFileURL(process.argv[1] ?? "").href === import.meta.url);
if (isMain) {
await (async () => {
const ref = process.argv[2] ?? "HEAD";
const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
const DECLARED_FILE = `${SPEC}/AUDIT/manifest-binding-declared.json`;

// ---- git ------------------------------------------------------------------------------
// -c core.quotePath=false for the same reason lineage-scan needs it: without it git octal-escapes
// any path with a space or a non-ASCII byte, such a path fails the regexes below, and the scan
// under-counts while reading as a pass.
const run = (...a) => spawnSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8", maxBuffer: 1 << 26 });
const out = (...a) => { const r = run(...a); return r.status === 0 ? r.stdout.trim() : null; };
if (out("rev-parse", "--git-dir") === null) { console.error("not a git repository: run this from inside the repository"); process.exit(2); }
if (out("rev-parse", "--verify", ref) === null) { console.error(`ref not found: ${ref}`); process.exit(2); }

// ---- the tracked set -------------------------------------------------------------------
// The audited TREE, not the working directory: like record-reproducibility.mjs, this reads
// `ls-tree <ref>` so a stale worktree, an untracked scratch manifest, or an out-negctl run left on
// disk cannot change what is certified.
const tree = (out("-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", ref) ?? "").split("\n").filter(Boolean);
const at = (p) => { const r = run("show", `${ref}:./${p}`); return r.status === 0 ? r.stdout : null; };
const jsonAt = (p) => { const s = at(p); if (s === null) return null; try { return JSON.parse(s); } catch { return null; } };

const inSpec = (p) => p.startsWith(`${SPEC}/`);
const rel = (p) => p.slice(SPEC.length + 1);
// Records: the same two shapes the other gates settled on -- `<unit>/out*/<ID>.handoff.json` (a
// generation) and `<unit>/<ID>.handoff.json` (a unit-directory record). `*.SUPERSEDED-*.json` is
// excluded: those are the pre-correction copies integrity-scan hash-checks and nothing else, and
// neither was ever stamped from a manifest that is still tracked.
const isRecord = (p) => { const r = rel(p); return (/^[^/]+\/out[^/]*\/[^/]+\.handoff\.json$/.test(r) || /^[^/]+\/[^/]+\.handoff\.json$/.test(r)) && !r.includes("SUPERSEDED"); };
const isManifest = (p) => /^[^/]+\/fixtures\/manifest[^/]*\.json$/.test(rel(p));
const records = tree.filter((p) => inSpec(p) && isRecord(p)).map((p) => ({ file: rel(p), unit: rel(p).split("/")[0], json: jsonAt(p) })).filter((r) => r.json);
const manifests = tree.filter((p) => inSpec(p) && isManifest(p)).map((p) => ({ file: rel(p), unit: rel(p).split("/")[0], json: jsonAt(p) })).filter((m) => m.json);
// A scan that found nothing is not a pass. Every path below is relative to the repository root, so
// running this from a subdirectory makes `ls-tree` return nothing for SPEC and would otherwise print
// RESULT ok over zero records -- the under-count-that-reads-as-a-pass this trail keeps meeting.
if (records.length === 0 || manifests.length === 0) {
  console.error(`RESULT FAIL: found ${records.length} records and ${manifests.length} manifests under ${SPEC} at ${ref} -- run this from the repository root`);
  process.exit(2);
}

// handoffHash -> the units it names. A unit-directory record and its generation are byte-identical,
// so they share a hash: 38 hashes here name two files. That is ONE unit, and treating it as
// ambiguous would be a false offence. Two UNITS sharing a hash would be a collision.
const byHash = new Map();
for (const r of records) { const h = r.json.handoffHash; if (typeof h !== "string") continue; if (!byHash.has(h)) byHash.set(h, new Map()); const u = byHash.get(h); u.set(r.unit, (u.get(r.unit) ?? []).concat(r.file)); }

// Canonical generation per unit, ranked as integrity-scan.mjs:29-33 ranks them, because the question
// "did a later generation correct this record?" is the same question that gate answers.
const NEGATIVE_GEN = /^(out-negctl|out-noparent|out-tampered)/;
const isControl = (g) => NEGATIVE_GEN.test(g) || g.includes("negctl") || g.includes("tampered");
const rank = (g) => ({ "out-erratum": 6, "out-chain": 5, "out-final": 4, "out-corrected": 3, out: 1 })[g] ?? (isControl(g) ? 0.5 : g.startsWith("out") ? 2 : -1);
const genOf = (r) => { const parts = r.file.split("/"); return parts.length === 3 ? parts[1] : null; };
const canonical = new Map();
for (const r of records) {
  const g = genOf(r); if (g === null || isControl(g)) continue;
  const best = canonical.get(r.unit);
  if (!best || rank(g) > rank(genOf(best))) canonical.set(r.unit, r);
}
const unitManifests = new Map();
for (const m of manifests) { if (!unitManifests.has(m.unit)) unitManifests.set(m.unit, []); unitManifests.get(m.unit).push(m); }

// Historical manifest versions, computed only for the records that need them: a record whose
// authority matches nothing at the audited ref may have been correct WHEN IT WAS WRITTEN, and the
// difference between "wrong" and "right, then the manifest moved" is a fact worth naming.
// Walks `ref`, not --all: the explanation must be derivable in any clone that holds the audited ref,
// and `--all` would make it depend on which local refs happen to exist here -- the same class of
// mistake AUDIT/lineage-scan.mjs:16-22 documents for FETCHABLE refs.
const historyCache = new Map();
function historicalMatch(unit, want) {
  for (const m of unitManifests.get(unit) ?? []) {
    const commits = (out("log", "--format=%H", ref, "--", `${SPEC}/${m.file}`) ?? "").split("\n").filter(Boolean);
    for (const c of commits) {
      const key = `${m.file}@${c}`;
      let hashes = historyCache.get(key);
      if (hashes === undefined) {
        hashes = null;
        const r = run("show", `${c}:./${SPEC}/${m.file}`);
        if (r.status === 0) { try { const j = JSON.parse(r.stdout); const n = normalizeManifest(j); hashes = { raw: canon(j), parsed: n.errors ? null : canon(n.manifest) }; } catch { hashes = null; } }
        historyCache.set(key, hashes);
      }
      if (hashes && (hashes.raw === want || hashes.parsed === want)) return { manifest: m.file, commit: c.slice(0, 12), form: hashes.parsed === want ? "parsed" : "raw" };
    }
  }
  return null;
}

// ---- declarations ----------------------------------------------------------------------
// Read from the working tree, not from `ref`, exactly as AUDIT/lineage-scan.mjs:204 reads its own:
// the declaration file is this gate's INPUT, not a member of the audited set. What it declares about
// is read from the tree at `ref`; the file that declares it is the file the operator is editing.
let decl;
try { decl = JSON.parse(readFileSync(join(process.cwd(), DECLARED_FILE), "utf8")); }
catch (e) { console.error(`cannot read/parse ${DECLARED_FILE}: ${e.message}`); process.exit(2); }
const entries = decl.entries ?? [];
const declKey = (o, kind) => `${o}|${kind}`;
const declared = new Map();
const badDecl = [];
for (const e of entries) {
  const subject = e.record ?? e.manifest;
  if (!subject || !e.kind || !e.annotatedBy || !e.why) { badDecl.push(`incomplete entry: ${JSON.stringify(e).slice(0, 110)}`); continue; }
  const k = declKey(subject, e.kind);
  if (declared.has(k)) badDecl.push(`duplicate declaration for ${k}`);
  declared.set(k, e);
}
const reachable = (sha) => /^[0-9a-f]{40}$/.test(String(sha)) && run("merge-base", "--is-ancestor", sha, ref).status === 0;
// An annotatedBy must be reachable AND carry the file it annotates, so a declaration is anchored to a
// commit a reader can actually go and read rather than to any commit in the graph.
const carries = (sha, subject) => run("cat-file", "-e", `${sha}:./${SPEC}/${subject}`).status === 0;

const offences = [];
const flag = (code, line) => offences.push(`${code}: ${line}`);
const usedDeclarations = new Set();
// A declaration excuses an offence only if it still says what the tree says: the entry's `observed`
// must equal the value now computed, and its annotatedBy must be reachable. An entry whose subject
// no longer deviates is DECL-GONE, so a healed defect cannot leave a permanent exemption behind.
function excuse(subject, kind, observed) {
  const e = declared.get(declKey(subject, kind));
  if (!e) return null;
  usedDeclarations.add(declKey(subject, kind));
  if (e.observed !== undefined && e.observed !== observed) flag("STALE", `${subject} ${kind}: declared ${String(e.observed).slice(0, 22)} observed ${String(observed).slice(0, 22)}`);
  if (!reachable(e.annotatedBy)) flag("BAD-DECLARATION", `${subject} ${kind}: annotatedBy ${e.annotatedBy} unreachable from ${ref}`);
  else if (!carries(e.annotatedBy, subject)) flag("BAD-DECLARATION", `${subject} ${kind}: annotatedBy ${e.annotatedBy.slice(0, 12)} does not carry ${subject}`);
  return e;
}

// ---- check 1: the record's authority is its parsed manifest ------------------------------
let authorityOk = 0;
const authorityDeclared = [];
for (const r of records) {
  const auth = r.json.taskAuthorityHash;
  if (auth === undefined) continue; // the field is optional in templates/handoff.schema.json
  const ms = unitManifests.get(r.unit) ?? [];
  if (ms.length === 0) {
    // `observed` is the authority value itself, not a description of the absence: a declaration that
    // pinned only the words "no manifest" would still excuse the record if its authority changed.
    if (!excuse(r.file, "no_manifest", auth)) flag("NO-MANIFEST", `${r.file} carries taskAuthorityHash and its unit tracks no manifest`);
    else authorityDeclared.push(`${r.file} no manifest (declared)`);
    continue;
  }
  const parsedHashes = ms.map((m) => { const n = normalizeManifest(m.json); return n.errors ? null : { file: m.file, hash: canon(n.manifest) }; }).filter(Boolean);
  if (parsedHashes.some((p) => p.hash === auth)) { authorityOk++; continue; }
  // Not conformant at this ref. Three explanations are checkable, in the order a reader would want.
  const rawHit = ms.find((m) => canon(m.json) === auth);
  if (rawHit) {
    if (excuse(r.file, "authority_raw", auth)) authorityDeclared.push(`${r.file} authority is canonicalHash(RAW ${rawHit.file}), protocol wants parsed`);
    else flag("AUTHORITY-MISMATCH", `${r.file} authority is canonicalHash(RAW ${rawHit.file}); FIX-4A requires the parsed manifest`);
    continue;
  }
  // A later generation of the same unit that DOES conform: the record was superseded, and records
  // are hash-bound so the superseded one keeps its bytes. Proven, not assumed: the corrected
  // generation's own authority must reproduce from the tracked manifest.
  const corrected = (records.filter((x) => x.unit === r.unit && x !== r).find((x) => { const g = genOf(x); return g !== null && rank(g) > 1 && !isControl(g) && (unitManifests.get(x.unit) ?? []).some((m) => { const n = normalizeManifest(m.json); return !n.errors && canon(n.manifest) === x.json.taskAuthorityHash; }); }));
  if (corrected) {
    if (excuse(r.file, "authority_superseded", auth)) authorityDeclared.push(`${r.file} superseded by ${corrected.file}, which conforms`);
    else flag("AUTHORITY-MISMATCH", `${r.file} authority matches no tracked manifest; ${corrected.file} conforms (declare it if the correction is deliberate)`);
    continue;
  }
  const hist = historicalMatch(r.unit, auth);
  if (hist) {
    if (excuse(r.file, "authority_historic", auth)) authorityDeclared.push(`${r.file} authority is canonicalHash(${hist.form} ${hist.manifest}) at ${hist.commit}; the manifest moved since`);
    else flag("AUTHORITY-MISMATCH", `${r.file} authority matches ${hist.manifest} at ${hist.commit} (${hist.form}) only -- the manifest changed after the record was stamped`);
    continue;
  }
  if (excuse(r.file, "authority_unresolvable", auth)) authorityDeclared.push(`${r.file} authority matches no tracked manifest version`);
  else flag("AUTHORITY-MISMATCH", `${r.file} authority ${String(auth).slice(0, 22)} matches no tracked manifest (parsed or raw, this ref or any commit)`);
}

// ---- check 2: a manifest parses, and describes the record it belongs to ------------------
let manifestsOk = 0;
for (const m of manifests) {
  const n = normalizeManifest(m.json);
  if (n.errors) { flag("UNPARSEABLE", `${m.file}: ${n.errors.slice(0, 3).join("; ")}`); continue; }
  const rec = canonical.get(m.unit);
  if (rec) {
    const bad = [];
    if (m.json.taskId !== rec.json.taskId) bad.push(`taskId ${m.json.taskId} != ${rec.json.taskId}`);
    if (m.json.baseSha !== rec.json.baseSha) bad.push(`baseSha ${String(m.json.baseSha).slice(0, 12)} != ${String(rec.json.baseSha).slice(0, 12)}`);
    if (bad.length > 0) { if (!excuse(m.file, "unit_disagree", bad.join("; "))) flag("UNIT-DISAGREE", `${m.file} vs ${rec.file}: ${bad.join("; ")}`); continue; }
  }
  manifestsOk++;
}

// ---- check 3: each manifest's parent hash resolves, and the commit edge agrees -----------
let parentOk = 0;
const parentDeclared = [];
for (const m of manifests) {
  const parent = m.json.parentHandoffHash;
  if (parent === null || parent === undefined) continue; // schema-legal: the chain starts here
  const units = byHash.get(parent);
  if (!units) {
    if (excuse(m.file, "parent_unresolvable", parent)) parentDeclared.push(`${m.file} parent hash names no tracked record`);
    else flag("PARENT-UNRESOLVED", `${m.file} parentHandoffHash ${String(parent).slice(0, 22)} is no tracked record's handoffHash`);
    continue;
  }
  if (units.size > 1) { flag("PARENT-AMBIGUOUS", `${m.file} parent hash is the handoffHash of ${[...units.keys()].join(", ")}`); continue; }
  const [pUnit] = [...units.keys()];
  const pRec = records.find((r) => r.unit === pUnit && r.json.handoffHash === parent && (genOf(r) === null || rank(genOf(r)) >= 1)) ?? records.find((r) => r.unit === pUnit && r.json.handoffHash === parent);
  const childTask = m.json.taskId, childBase = m.json.baseSha;
  // The forward commit edge may be carried by ANY generation of the parent unit, and for eight units
  // of the X-series it is not the one the hash names. X08 descends from the X07 record that existed
  // when it was handed off (X07/out, handoffHash 66af2c2b...), while the chain link is carried by the
  // generation written later to continue a unit that had been emitted terminal (X07/out-chain:
  // nextTaskId=X08, nextBaseSha=45d42acb... == X08.baseSha). PLAN-COMPLETION.json's
  // post_plan_extension.chain_note has said so since the X-series -- "a PASS record is never
  // rewritten" -- and demanding the edge from the hash-named record specifically is what made the
  // first version of this gate report a false EDGE-ABSENT on X08. The question the chain actually
  // asks, and the one integrity-scan asks, is whether the parent unit declares the link at all.
  const declares = records.filter((r) => r.unit === pUnit && r.json.nextTaskId === childTask && r.json.nextBaseSha === childBase);
  if (declares.length > 0) { parentOk++; continue; }
  const nt = pRec?.json?.nextTaskId, nb = pRec?.json?.nextBaseSha;
  const anyEdge = records.find((r) => r.unit === pUnit && r.json.nextTaskId != null);
  if (nt === undefined || nt === null || nb === undefined || nb === null) {
    if (excuse(m.file, "edge_absent", `nextBaseSha=${nb}`)) parentDeclared.push(`${m.file} parent ${pUnit} declares no forward commit edge (hash edge only)`);
    else flag("EDGE-ABSENT", `${m.file} names ${pUnit} parent by hash; no generation of ${pUnit} declares ${childTask}@${String(childBase).slice(0, 12)}, so integrity-scan sees no ${pUnit} -> ${childTask} link`);
    continue;
  }
  if (nt !== childTask || nb !== childBase) {
    if (excuse(m.file, "edge_wrong", `${nt}@${String(nb).slice(0, 12)}`)) parentDeclared.push(`${m.file} parent ${pUnit} points at ${nt}@${String(nb).slice(0, 12)}`);
    else flag("EDGE-WRONG", `${m.file} names ${pUnit} parent; no generation of ${pUnit} declares ${childTask}@${String(childBase).slice(0, 12)}${anyEdge ? ` (its ${genOf(anyEdge) ?? "unit-dir"} generation points at ${anyEdge.json.nextTaskId}@${String(anyEdge.json.nextBaseSha).slice(0, 12)})` : ""}`);
    continue;
  }
  parentOk++;
}

// ---- declarations that stopped being needed ----------------------------------------------
for (const k of declared.keys()) if (!usedDeclarations.has(k)) flag("DECL-GONE", `${k} -- no offence matches it now: prune it or the deviation is gone`);

// ---- report ------------------------------------------------------------------------------
console.log(`ref=${ref} records=${records.length} manifests=${manifests.length} hashes=${byHash.size} declarations=${declared.size}`);
console.log(`authority conforms=${authorityOk} declared=${authorityDeclared.length} | manifests parse+agree=${manifestsOk} | parent edges resolved=${parentOk} declared=${parentDeclared.length}`);
for (const l of authorityDeclared) console.log(`  authority declared: ${l}`);
for (const l of parentDeclared) console.log(`  parent declared: ${l}`);
for (const l of badDecl) console.log(`  BAD-DECLARATION: ${l}`);
const badDeclCount = badDecl.length;
for (const o of offences) console.log(`  ${o}`);
const total = offences.length + badDeclCount;
console.log(
  `RESULT ${total === 0 ? "ok" : `offences=${total}`}: every record's taskAuthorityHash reproduces from its manifest (or is declared), every manifest parses and describes its record, and every manifest's parent hash resolves to a record whose commit edge agrees (or is declared)`,
);
process.exit(total === 0 ? 0 : 1);


})()
}