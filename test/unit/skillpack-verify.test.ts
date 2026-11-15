import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PACK_MANIFEST_FILE, buildPackManifest, verifyPack } from "../../src/skillpack/verify.ts";

function makePack(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillpack-"));
  mkdirSync(join(dir, "skills", "demo"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-pack", version: "1.2.3" }));
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: d\n---\nbody\n");
  return dir;
}

test("buildPackManifest records sha256 and sha512 for every file except the manifests, sorted", () => {
  const dir = makePack();
  writeFileSync(join(dir, "skills.lock.json"), "{}");
  const manifest = buildPackManifest(dir);
  assert.equal(manifest.name, "demo-pack");
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(Object.keys(manifest.files), ["package.json", "skills/demo/SKILL.md"]);
  const skill = manifest.files["skills/demo/SKILL.md"];
  assert.ok(skill);
  assert.match(skill.sha256, /^[0-9a-f]{64}$/);
  assert.match(skill.sha512, /^sha512-[A-Za-z0-9+/]+=*$/);
});

test("verifyPack passes for an untouched pack", () => {
  const dir = makePack();
  writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(buildPackManifest(dir)));
  assert.deepEqual(verifyPack(dir), { ok: true, problems: [] });
});

test("verifyPack reports a modified file, an added file and a removed file", () => {
  const dir = makePack();
  writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(buildPackManifest(dir)));
  writeFileSync(join(dir, "skills", "demo", "SKILL.md"), "tampered");
  writeFileSync(join(dir, "skills", "demo", "extra.sh"), "echo hi");
  mkdirSync(join(dir, "skills", "demo", "scripts"), { recursive: true });
  const result = verifyPack(dir);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.startsWith("digest mismatch: skills/demo/SKILL.md")));
  assert.ok(result.problems.includes("unlisted file: skills/demo/extra.sh"));
});

test("verifyPack reports missing files and a version that disagrees with package.json", () => {
  const dir = makePack();
  const manifest = buildPackManifest(dir);
  writeFileSync(
    join(dir, PACK_MANIFEST_FILE),
    JSON.stringify({
      ...manifest,
      version: "9.9.9",
      files: { ...manifest.files, "gone.md": manifest.files["package.json"] },
    }),
  );
  const result = verifyPack(dir);
  assert.ok(result.problems.includes("missing file: gone.md"));
  assert.ok(result.problems.some((p) => p.startsWith("version mismatch")));
});

test("verifyPack reports an unreadable manifest instead of throwing", () => {
  const dir = makePack();
  assert.equal(verifyPack(dir).ok, false);
  writeFileSync(join(dir, PACK_MANIFEST_FILE), "{not json");
  const result = verifyPack(dir);
  assert.equal(result.ok, false);
  assert.match(result.problems[0] ?? "", /manifest/);
  assert.equal(readFileSync(join(dir, PACK_MANIFEST_FILE), "utf8"), "{not json");
});
