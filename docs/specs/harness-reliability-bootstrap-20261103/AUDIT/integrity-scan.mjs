// Post-series integrity scan for the harness-reliability bootstrap evidence chain. Read-only.
// Checks every emitted handoff record for schema conformance and canonical-hash agreement, walks
// the forward chain (parent.nextTaskId + parent.nextBaseSha must name a child record with that
// taskId and baseSha), and reports whether each named evidence artifact exists AND is tracked in
// git - a chain parent a fresh clone cannot read is unverifiable, so that is an offender.
// usage: node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/integrity-scan.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalHash } from "../../../../src/bootstrap/resultGate.ts";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
// out-chain > out-final > out-corrected > later correction generations (out2, out3) > out.
// Generations holding negative controls -- *negctl*, out-noparent, out-tampered -- are scanned,
// never canonical. The two named out-noparent/out-tampered were ranked 2 (above real `out`) until
// X14, because the only negative-control test was a substring match on "negctl".
const NEGATIVE_GEN = /^(out-negctl|out-noparent|out-tampered)/;
const rank = (g) =>
  ({ "out-chain": 5, "out-final": 4, "out-corrected": 3, out: 1 })[g] ??
  (NEGATIVE_GEN.test(g) ? 0.5 : g.startsWith("out") ? 2 : -1);
const schema = JSON.parse(readFileSync(join(ROOT, SPEC, "templates/handoff.schema.json"), "utf8"));
const required = schema.required ?? [];
const props = schema.properties ?? {};
const unitDirs = readdirSync(join(ROOT, SPEC), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^[A-Z]{1,4}-?\d{1,2}$/.test(d.name))
  .map((d) => d.name)
  .sort();
const gens = (unit) =>
  readdirSync(join(ROOT, SPEC, unit), { withFileTypes: true })
    .filter((d) => d.isDirectory() && rank(d.name) >= 0)
    .map((d) => d.name)
    .sort((a, b) => rank(b) - rank(a));

const records = [];
for (const unit of unitDirs)
  for (const gen of gens(unit))
    for (const f of readdirSync(join(ROOT, SPEC, unit, gen)).filter((n) => n.endsWith(".json"))) {
      const file = join(SPEC, unit, gen, f);
      records.push({ unit, gen, file, rec: JSON.parse(readFileSync(join(ROOT, file), "utf8")) });
    }

const fieldErrors = (r) => [
  ...required.filter((k) => !(k in r)).map((k) => `missing ${k}`),
  ...Object.keys(r).filter((k) => k !== "handoffHash" && !(k in props)).map((k) => `extra ${k}`),
];
const hashBad = records.filter((r) => canonicalHash(r.rec) !== r.rec.handoffHash);
const fieldBad = records.filter((r) => fieldErrors(r.rec).length);
for (const r of hashBad) console.log(`HASH-OFFENDER ${r.file}`);
for (const r of fieldBad) console.log(`FIELD-OFFENDER ${r.file}: ${fieldErrors(r.rec).join(",")}`);

const tracked = new Set(
  execFileSync("git", ["ls-files", SPEC], { encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n"),
);
const dangling = [];
const untracked = [];
for (const { file, rec } of records) {
  for (const ev of rec.evidence ?? [])
    if (!existsSync(join(ROOT, ev))) dangling.push(`${file} -> ${ev}`);
    else if (!tracked.has(ev)) untracked.push(`${file} -> ${ev}`);
  if (!tracked.has(file)) untracked.push(`${file} (record itself)`);
}

// Canonical generation per unit = the highest-ranked generation that actually holds a record;
// lower ones are immutable history. A generation directory that exists but is empty must not be
// allowed to shadow the one carrying the record: negative-control runs leave such directories
// behind, git does not track empty directories, so they differ between checkouts -- and this scan
// read a directory listing, so the same committed tree produced a different offender count in two
// worktrees (X14: 2 beside the trail, 3 on main, the same bytes).
const canonical = new Map();
for (const unit of unitDirs) {
  const chainable = gens(unit).filter((g) => !NEGATIVE_GEN.test(g) && !g.includes("negctl"));
  const chosen = chainable.find((g) => records.some((r) => r.unit === unit && r.gen === g));
  if (chosen) canonical.set(unit, records.find((r) => r.unit === unit && r.gen === chosen));
}
const byTaskBase = new Map(records.map((r) => [`${r.rec.taskId}@${r.rec.baseSha}`, r]));
const isCanonical = (r) => canonical.get(r.unit)?.file === r.file;
const chainBad = [];
const chainHistory = [];
const chainOk = [];
for (const p of records.filter((r) => r.rec.nextTaskId)) {
  const child = byTaskBase.get(`${p.rec.nextTaskId}@${p.rec.nextBaseSha}`);
  const line = `${p.unit}/${p.gen} -> ${p.rec.nextTaskId}@${String(p.rec.nextBaseSha).slice(0, 12)}`;
  if (!child) (isCanonical(p) ? chainBad : chainHistory).push(`${line} (no such record)`);
  else if (isCanonical(p)) chainOk.push(`${line} (${child.gen})`);
  else chainHistory.push(`${line} (superseded generation, resolves to ${child.gen})`);
  if (isCanonical(p) && !tracked.has(p.file)) chainBad.push(`${p.file} names a child but is not tracked in git`);
}
const named = new Set(records.filter(isCanonical).map((p) => `${p.rec.nextTaskId}@${p.rec.nextBaseSha}`));
const orphans = [...canonical.values()].filter((r) => r && !named.has(`${r.rec.taskId}@${r.rec.baseSha}`));

console.log(`records=${records.length} canonical=${canonical.size} hash_ok=${records.length - hashBad.length} field_ok=${records.length - fieldBad.length}`);
console.log(`schema=${SPEC}/templates/handoff.schema.json required=${required.length}`);
console.log(`canonical chain links resolved=${chainOk.length} offenders=${chainBad.length}`);
for (const b of chainBad) console.log(`  CHAIN ${b}`);
console.log(`superseded-generation links (informational)=${chainHistory.length}`);
console.log(`canonical records not named by a canonical parent (chain head, terminal unit, or parent generation missing): ${orphans.length}`);
for (const o of orphans) console.log(`  ORPHAN ${o.file}`);
console.log(`evidence dangling=${dangling.length} untracked=${untracked.length}`);
for (const u of [...new Set(untracked)].slice(0, 40)) console.log(`  UNTRACKED ${u}`);
const dirty = execFileSync("git", ["status", "--short", SPEC], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
console.log(`working-tree dirty entries under ${SPEC}: ${dirty.length}`);
for (const d of dirty.slice(0, 20)) console.log(`  ${d}`);
