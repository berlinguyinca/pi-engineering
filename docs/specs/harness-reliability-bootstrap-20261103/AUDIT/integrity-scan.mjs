// Post-series integrity scan for the harness-reliability bootstrap evidence chain. Read-only.
// Checks every emitted handoff record for schema conformance and canonical-hash agreement, walks
// the forward chain (parent.nextTaskId + parent.nextBaseSha must name a child record with that
// taskId and baseSha), and reports whether each named evidence artifact exists AND is tracked in
// git - a chain parent a fresh clone cannot read is unverifiable, so that is an offender.
// usage: node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/integrity-scan.mjs
//
// Exit status is part of the contract (X15 gave it one, X16 made what it certifies exact):
// every finding below feeds it, and AUDIT/chain-declaration.json is the only place a finding may be
// waived. Read this file as the definition of what "the trail verifies" means -- several of the
// rules below exist because a probe got past an earlier, weaker version of them.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash } from "../../../../src/bootstrap/resultGate.ts";

// Every git call is pinned to the repo root: run from inside SPEC, `git ls-files SPEC` resolves
// relative to the caller and reported untracked=889 with 73 bogus "not tracked" offenders (X16).
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const git = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
// out-erratum > out-chain > out-final > out-corrected > later correction generations (out2, out3) >
// out. out-erratum ranks above every chain generation because it exists to correct what an earlier
// generation's note DISCLOSED -- it never restates a historical fact, and it carries the pointer the
// generation it copies already proved (X17).
// Generations holding negative controls -- *negctl*, out-noparent, out-tampered -- are scanned,
// never canonical. The two named out-noparent/out-tampered were ranked 2 (above real `out`) until
// X14, because the only negative-control test was a substring match on "negctl".
const NEGATIVE_GEN = /^(out-negctl|out-noparent|out-tampered)/;
const isControl = (g) => NEGATIVE_GEN.test(g) || g.includes("negctl") || g.includes("tampered");
const rank = (g) =>
  ({ "out-erratum": 6, "out-chain": 5, "out-final": 4, "out-corrected": 3, out: 1 })[g] ??
  (isControl(g) ? 0.5 : g.startsWith("out") ? 2 : -1);
const schema = JSON.parse(readFileSync(join(ROOT, SPEC, "templates/handoff.schema.json"), "utf8"));
const required = schema.required ?? [];
const props = schema.properties ?? {};
// A generation is an out*-named subdirectory that actually holds a .json. Requiring the file, not
// just the directory, is what makes the unit count the same in every checkout: negative-control runs
// leave empty out* directories behind, git does not track empty directories, and this scan reads a
// directory listing -- 12 such directories sat in the X15 worktree, so the same committed tree gave
// units=73 there and units=72 in a fresh archive of the same commit (X14 fixed this for canonical
// selection, X16 for unit selection).
const gens = (unit) => {
  const dir = join(ROOT, SPEC, unit);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && rank(d.name) >= 0 && readdirSync(join(dir, d.name)).some((n) => n.endsWith(".json")))
    .map((d) => d.name)
    .sort((a, b) => rank(b) - rank(a));
};
// A unit is any directory under SPEC holding at least one generation directory. The rule is
// structural, not name-shaped: the previous pattern ^[A-Z]{1,4}-?\d{1,2}$ demanded the id END in
// digits, so it silently skipped the five units whose ids end with a letter -- FIX-3B, FIX-3B2,
// FIX-3C, FIX-4A, FIX-4B. Their records were never hashed or field-checked, and the unresolved link
// FIX-3B2/out -> FIX-3C@0ddf2771 was invisible (FIX-3C's record sat in the unit directory, never in
// a generation directory): the scan reported offenders=3 where the trail held 4 (X15).
const NON_UNIT = new Set(["AUDIT", "examples", "manifests", "templates"]);
const unitDirs = readdirSync(join(ROOT, SPEC), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !NON_UNIT.has(d.name) && gens(d.name).length > 0)
  .map((d) => d.name)
  .sort();

const tracked = new Set(git(["ls-files", SPEC]).trim().split("\n"));
const unread = [];
const unreadFiles = new Set();
const records = [];
for (const unit of unitDirs)
  for (const gen of gens(unit))
    for (const f of readdirSync(join(ROOT, SPEC, unit, gen)).filter((n) => n.endsWith(".json"))) {
      const file = join(SPEC, unit, gen, f);
      try {
        records.push({ unit, gen, file, kind: "generation", rec: JSON.parse(readFileSync(join(ROOT, file), "utf8")) });
      } catch {
        unreadFiles.add(file);
        unread.push(`${file} (a record in a generation directory that does not parse)`);
      }
    }

// Records that are not in a generation directory. 41 tracked handoff records sit directly in unit
// directories -- they are the emissions that predate the generation scheme, including the corrected
// T09 and FIX-3C records that X15's chain generations copy -- and a scan that read only generations
// printed RESULT ok, exit 0 after a probe had flipped `status` to FAIL in T09/T09.handoff.json. They
// are now hashed, field-checked and evidence-checked like any other record. They are NOT canonical
// candidates and they do not parent or child a canonical link: a canonical link names a generation.
// A record-shaped file anywhere else is read for the same three checks and reported separately -- 67
// payload fixtures, the tampered control under FIX-2/fixtures, and X08's hashed fixture copy. Shaped =
// carries every field the schema requires; a file whose name contains "handoff" is treated as a record
// whatever it carries, so dropping a field to dodge the shape test cannot hide it.
const handoffName = /handoff[^/]*\.json$/;
const generationFiles = new Set(records.map((r) => r.file));
const loose = [];
const elsewhere = [];
for (const file of tracked) {
  if (!file.endsWith(".json") || generationFiles.has(file)) continue;
  const p = file.slice(SPEC.length + 1).split("/");
  if (NON_UNIT.has(p[0]) || p.length < 2) continue;
  const candidate = handoffName.test(file);
  let rec = null;
  try {
    rec = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  } catch {
    // A generation record that failed to parse was already reported by the loop that reads
    // generations (it never reached `records`, so the guard above could not see it); reporting it twice
    // would count one unreadable file as two offences.
    if (candidate && !unreadFiles.has(file)) unread.push(`${file} (named like a handoff record but does not parse)`);
    continue;
  }
  const shaped = rec !== null && typeof rec === "object" && required.every((k) => k in rec);
  if (!candidate && !shaped) continue;
  (p.length === 2 ? loose : elsewhere).push({
    unit: p[0],
    gen: p.length >= 3 ? p[1] : "(unit directory)",
    file,
    kind: p.length === 2 ? "unit directory" : p[1],
    rec,
  });
}
const checked = [...records, ...loose, ...elsewhere];

const fieldErrors = (r) => [
  ...required.filter((k) => !(k in r)).map((k) => `missing ${k}`),
  ...Object.keys(r).filter((k) => k !== "handoffHash" && !(k in props)).map((k) => `extra ${k}`),
];
// Waivers live in the repo, next to the scanner, and are reported on every run. A declared waiver
// that no longer applies is an offence, so a fix cannot leave an excuse behind.
const declared = JSON.parse(readFileSync(join(ROOT, SPEC, "AUDIT/chain-declaration.json"), "utf8"));
const hashWaiver = new Map((declared.hash_mismatch_expected ?? []).map((e) => [e.file, e.why]));
const hashBad = checked.filter(
  (r) => r.rec.handoffHash !== undefined && canonicalHash(r.rec) !== r.rec.handoffHash && !hashWaiver.has(r.file),
);
const hashWaived = checked.filter((r) => hashWaiver.has(r.file) && canonicalHash(r.rec) !== r.rec.handoffHash);
const waiverStale = [...hashWaiver].filter(
  ([file]) => !checked.some((r) => r.file === file && r.rec.handoffHash !== undefined && canonicalHash(r.rec) !== r.rec.handoffHash),
);
// Payload fixtures: the trail's own emitter wrote each unit's record payload to
// <unit>/fixtures/handoff-record.json BEFORE it hashed anything, so most of them carry every field
// except handoffHash. They are declared structurally -- a suffix and the one field expected absent --
// and the declaration is CHECKED, not trusted: a payload fixture must equal some other record of its
// own unit (a generation record, or the unit-directory record for the two units that have one) apart
// from that field, or it is a payload that vouches for nothing (PAYLOAD-OFFENCE). That is what makes
// tampering with a fixture fail the scan, which it did not before X16.
const payloadRules = declared.payload_fixtures ?? [];
const isPayloadFixture = (r) => payloadRules.some((p) => r.file.endsWith(p.suffix) && !(p.field_absent in r.rec));
const payloadWaived = new Map(
  checked.filter(isPayloadFixture).map((r) => [r.file, payloadRules.find((p) => r.file.endsWith(p.suffix)).field_absent]),
);
const stripHash = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "handoffHash")));
const payloadOffence = checked
  .filter(isPayloadFixture)
  .filter((r) => {
    const peers = checked.filter((o) => o.unit === r.unit && !payloadRules.some((p) => o.file.endsWith(p.suffix)));
    return !peers.some((o) => stripHash(o.rec) === stripHash(r.rec));
  })
  .map((r) => `${r.file} matches no other record of ${r.unit} apart from the absent field`);
const payloadStale = payloadRules.filter((p) => !checked.some((r) => r.file.endsWith(p.suffix) && !(p.field_absent in r.rec)));
const rawFieldErrors = (r) =>
  fieldErrors(r.rec).filter((e) => !(payloadWaived.get(r.file) && e === `missing ${payloadWaived.get(r.file)}`));
const fieldBad = checked.filter((r) => rawFieldErrors(r).length);
const brief = (s) => (String(s).length > 110 ? String(s).slice(0, 110) + " …(full text in AUDIT/chain-declaration.json)" : String(s));
for (const r of hashBad) console.log(`HASH-OFFENDER ${r.file}`);
for (const r of hashWaived) console.log(`HASH-WAIVED ${r.file} -- ${brief(hashWaiver.get(r.file))}`);
for (const [file] of waiverStale) console.log(`STALE-WAIVER ${file} is declared as mismatching but no longer does`);
for (const r of fieldBad) console.log(`FIELD-OFFENDER ${r.file}: ${rawFieldErrors(r).join(",")}`);
for (const p of payloadOffence) console.log(`  PAYLOAD-OFFENCE ${p}`);
for (const p of payloadStale) console.log(`STALE-DECLARATION payload fixture rule "${p.suffix}" matches nothing`);

const dangling = [];
const untracked = [];
for (const { file, rec } of checked) {
  for (const ev of Array.isArray(rec.evidence) ? rec.evidence : [])
    if (!existsSync(join(ROOT, ev))) dangling.push(`${file} -> ${ev}`);
    else if (!tracked.has(ev)) untracked.push(`${file} -> ${ev}`);
  if (!tracked.has(file)) untracked.push(`${file} (record itself)`);
}

// Canonical generation per unit = the highest-ranked generation that actually holds a record;
// lower ones are immutable history. A generation directory that exists but is empty must not be
// allowed to shadow the one carrying the record (X14), and a generation holding a named negative
// control can never be canonical -- it is a control, its bytes are made up to fail.
const canonical = new Map();
for (const unit of unitDirs) {
  const chosen = gens(unit).filter((g) => !isControl(g)).find((g) => records.some((r) => r.unit === unit && r.gen === g));
  if (chosen) canonical.set(unit, records.find((r) => r.unit === unit && r.gen === chosen));
}
// What a forward link may land on: real records in generations or unit directories. A named
// negative control may not satisfy a link -- a probe that added X08/out-negctl-probe with a zero base
// and rehashed a parent pointing at it printed resolved=73 offenders=0 RESULT ok while the real
// X08/out-chain went unnamed (X16). The same class covers FIX-2/fixtures/parent-tampered.json, which
// carries FIX-1's taskId and baseSha precisely so that a sloppy scan would accept it.
const linkTargets = new Map();
for (const r of [...records, ...loose])
  if (!isControl(r.gen)) linkTargets.set(`${r.rec.taskId}@${r.rec.baseSha}`, r);
const isCanonical = (r) => canonical.get(r.unit)?.file === r.file;
const chainBad = [];
const chainHistory = [];
const chainOk = [];
for (const p of records.filter((r) => r.rec.nextTaskId)) {
  const child = linkTargets.get(`${p.rec.nextTaskId}@${p.rec.nextBaseSha}`);
  const line = `${p.unit}/${p.gen} -> ${p.rec.nextTaskId}@${String(p.rec.nextBaseSha).slice(0, 12)}`;
  if (!child) (isCanonical(p) ? chainBad : chainHistory).push(`${line} (no such record)`);
  else if (isCanonical(p)) chainOk.push(`${line} (${child.kind})`);
  else chainHistory.push(`${line} (superseded generation, resolves to ${child.kind})`);
  if (isCanonical(p) && !tracked.has(p.file)) chainBad.push(`${p.file} names a child but is not tracked in git`);
}
// A canonical record no canonical parent names is an offence unless it is declared, with a reason,
// in AUDIT/chain-declaration.json. Orphans used to be printed and ignored, which is how a broken
// chain still exited 0; a declared orphan is a fact about the trail (a head, or a generation whose
// parent's immutable bytes name an older one), and a declaration that stops applying is stale.
const named = new Set(records.filter(isCanonical).map((p) => `${p.rec.nextTaskId}@${p.rec.nextBaseSha}`));
const key = (r) => `${r.rec.taskId}@${r.rec.baseSha}`;
const orphans = [...canonical.values()].filter((r) => r && !named.has(key(r)));
const mayBeUnnamed = new Map((declared.may_be_unnamed ?? []).map((d) => [`${d.taskId}@${d.baseSha}`, d.why]));
const orphanBad = orphans.filter((o) => !mayBeUnnamed.has(key(o)));
const orphanDeclared = orphans.filter((o) => mayBeUnnamed.has(key(o)));
const orphanStale = [...mayBeUnnamed].filter(([k]) => !orphans.some((o) => key(o) === k));
for (const o of orphanBad) console.log(`ORPHAN-OFFENCE ${o.file} is canonical, names no parent, and is not declared`);
for (const o of orphanDeclared) console.log(`ORPHAN (declared) ${o.file} -- ${brief(mayBeUnnamed.get(key(o)))}`);
for (const [k] of orphanStale) console.log(`STALE-DECLARATION ${k} is declared unnamed but a canonical parent names it`);

// Nothing may hold tracked generation records and not be scanned. The name pattern above made that
// silently possible for five units; this makes it loud, and a failure, whatever the directories are called.
const skippedUnits = [
  ...new Set(
    [...tracked]
      .map((f) => f.slice(SPEC.length + 1).split("/"))
      .filter((p) => p.length >= 3 && !NON_UNIT.has(p[0]) && p[2].endsWith(".json") && rank(p[1]) >= 0)
      .map((p) => p[0])
      .filter((u) => !unitDirs.includes(u)),
  ),
].sort();
for (const u of skippedUnits)
  console.log(`SILENT-SKIP ${u}: tracked generation records exist but the directory is not a scanned unit`);

console.log(
  `units=${unitDirs.length} records=${checked.length} (in generations=${records.length}, in unit directories=${loose.length}, elsewhere=${elsewhere.length}) canonical=${canonical.size} hash_ok=${checked.length - hashBad.length - hashWaived.length}/${checked.length - hashWaived.length} field_ok=${checked.length - fieldBad.length}`,
);
console.log(`schema=${SPEC}/templates/handoff.schema.json required=${required.length}`);
console.log(`canonical chain links resolved=${chainOk.length} offenders=${chainBad.length}`);
for (const b of chainBad) console.log(`  CHAIN ${b}`);
console.log(`superseded-generation links (informational)=${chainHistory.length}`);
console.log(`canonical records no canonical parent names=${orphans.length} (declared=${orphanDeclared.length} offences=${orphanBad.length})`);
console.log(`evidence dangling=${dangling.length} untracked=${untracked.length}`);
console.log(
  `payload fixtures under */fixtures/=${payloadWaived.size}, each equal to another record of its unit apart from the absent field (offences=${payloadOffence.length}, stale rules=${payloadStale.length})`,
);
for (const u of [...new Set(untracked)].slice(0, 40)) console.log(`  UNTRACKED ${u}`);
for (const u of unread) console.log(`  UNREAD ${u}`);
console.log(`waivers=${hashWaiver.size} stale (hash=${waiverStale.length}, unnamed=${orphanStale.length})`);
const dirty = git(["status", "--short", SPEC]).trim().split("\n").filter(Boolean);
console.log(`working-tree dirty entries under ${SPEC}: ${dirty.length}`);
for (const d of dirty.slice(0, 20)) console.log(`  ${d}`);
// Until X15 this script had no exit status at all: it printed offenders and still exited 0, so any
// CI gate written against it passed while the chain was broken. Offences are now failures, and so is
// anything the scan could not read (unread) or any waiver/declaration that no longer applies (stale).
// What exit 0 does NOT certify: that the trail is one connected walk -- connectivity is the chain
// walk plus the declared-orphans rule together, so read the lines above, not just the exit code.
const offences =
  hashBad.length + fieldBad.length + chainBad.length + dangling.length + untracked.length + skippedUnits.length +
  orphanBad.length + unread.length + waiverStale.length + orphanStale.length + payloadOffence.length + payloadStale.length;
console.log(
  `RESULT ${offences === 0 ? "ok" : "offenders=" + offences}: ${chainOk.length} canonical forward links resolved, ${orphans.length} unnamed (${orphanDeclared.length} declared), hash waived=${hashWaived.length}`,
);
process.exit(offences === 0 ? 0 : 1);
