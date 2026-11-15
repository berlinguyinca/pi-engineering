import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPack } from "../../src/skillpack/verify.ts";

const PACK = join(import.meta.dirname, "..", "..", "skill-packs", "pe-operator");
const ROOT = join(import.meta.dirname, "..", "..");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

test("committed pe-operator pack matches its digest manifest (sha256 + sha512)", () => {
  assert.deepEqual(verifyPack(PACK), { ok: true, problems: [] });
});

test("pack version agrees across package.json, SKILL.md metadata and the OMP-format lockfile", () => {
  const version = json(join(PACK, "package.json")).version as string;
  const skill = readFileSync(join(PACK, "skills", "pe-operator", "SKILL.md"), "utf8");
  assert.match(skill, new RegExp(`^  version: ${version.replaceAll(".", "\\.")}$`, "m"));
  const lock = json(join(PACK, "skills.lock.json"));
  assert.equal(lock.version, 1);
  const entry = lock.skills["@pi_engineering/pe-operator"];
  assert.equal(entry.version, version);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "SHA-512 SRI as OMP writes it");
  assert.equal(entry.resolved, "", "unpublished pack: no registry route");
});

test("SKILL.md frontmatter has the fields OMP requires and no executable payload ships", () => {
  const skill = readFileSync(join(PACK, "skills", "pe-operator", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: pe-operator\ndescription: .+\n/);
  const manifest = json(join(PACK, "pack.manifest.json"));
  for (const path of Object.keys(manifest.files)) {
    assert.ok(!/(^|\/)scripts\//.test(path) && !/\.(sh|ts|js|mjs|py)$/.test(path), `script-like file in pack: ${path}`);
  }
});

test("nothing in Pi Engineering loads the pack by default", () => {
  const pkg = json(join(ROOT, "package.json"));
  assert.deepEqual(pkg.pi.extensions, ["./src/runtime/host/entry.ts"]);
  assert.equal(pkg.pi.skills, undefined);
  assert.equal(pkg.omp, undefined);
  const worker = readFileSync(join(ROOT, "src", "workers", "PiWorkerExecutor.ts"), "utf8");
  assert.match(worker, /getSkills:\s*\(\)\s*=>\s*\(\{\s*skills:\s*\[\]/, "worker sessions stay skill-less");
});
