import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function sealed(): string {
  const dir = makePack();
  writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(buildPackManifest(dir)));
  return dir;
}
const problemsOf = (dir: string) => verifyPack(dir).problems.join(" | ");

test("verifyPack never throws on malformed manifest shapes", () => {
  const dir = sealed();
  const good = buildPackManifest(dir);
  const shapes: unknown[] = [
    null,
    [],
    "str",
    { ...good, files: [] },
    { ...good, files: null },
    { ...good, files: { "package.json": { sha256: 1, sha512: "x" } } },
    { ...good, files: { "package.json": null } },
    { ...good, name: 5 },
    { ...good, version: undefined },
  ];
  for (const shape of shapes) {
    writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(shape));
    const result = verifyPack(dir);
    assert.equal(result.ok, false, JSON.stringify(shape));
    assert.match(result.problems.join(" "), /manifest/);
  }
});

test("verifyPack reports a missing or malformed package.json instead of throwing", () => {
  const dir = sealed();
  writeFileSync(join(dir, "package.json"), "{nope");
  assert.match(problemsOf(dir), /package\.json unreadable/);
  rmSync(join(dir, "package.json"));
  assert.match(problemsOf(dir), /package\.json unreadable/);
  const dir2 = sealed();
  writeFileSync(join(dir2, "package.json"), JSON.stringify({ name: 3 }));
  assert.match(problemsOf(dir2), /package\.json unreadable/);
});

test("verifyPack handles a directory where the pack path is a file or missing", () => {
  const missing = join(tmpdir(), "skillpack-does-not-exist");
  assert.equal(verifyPack(missing).ok, false);
  const dir = sealed();
  rmSync(join(dir, PACK_MANIFEST_FILE));
  mkdirSync(join(dir, PACK_MANIFEST_FILE));
  assert.match(problemsOf(dir), /manifest unreadable/);
});

test("verifyPack reports symlinks without following them", () => {
  const dir = sealed();
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "secret.txt"), "s");
  symlinkSync(join(outside, "secret.txt"), join(dir, "skills", "demo", "link.md"));
  symlinkSync(outside, join(dir, "skills", "linkdir"));
  const result = problemsOf(dir);
  assert.match(result, /symlink: skills\/demo\/link\.md/);
  assert.match(result, /symlink: skills\/linkdir/);
  assert.ok(!result.includes("secret.txt"));
});

test("verifyPack compares manifest name with package.json name", () => {
  const dir = sealed();
  writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify({ ...buildPackManifest(dir), name: "other" }));
  assert.match(problemsOf(dir), /name mismatch: manifest other vs package\.json demo-pack/);
});

function lockWith(dir: string, lock: unknown): void {
  writeFileSync(join(dir, "skills.lock.json"), JSON.stringify(lock));
}
const SRI = `sha512-${"A".repeat(86)}==`;

test("verifyPack checks the pack's own skills.lock.json for agreement (no omp needed)", () => {
  const dir = sealed();
  lockWith(dir, { version: 1, skills: { "@pi_engineering/demo": { version: "1.2.3", integrity: SRI, resolved: "" } } });
  assert.deepEqual(verifyPack(dir), { ok: true, problems: [] });

  lockWith(dir, { version: 1, skills: { "@pi_engineering/demo": { version: "9.9.9", integrity: SRI, resolved: "" } } });
  assert.match(problemsOf(dir), /lock version mismatch: @pi_engineering\/demo/);

  lockWith(dir, {
    version: 1,
    skills: { "@pi_engineering/demo": { version: "1.2.3", integrity: "md5-x", resolved: "" } },
  });
  assert.match(problemsOf(dir), /lock integrity is not sha512 SRI/);

  lockWith(dir, { version: 1, skills: {} });
  assert.match(problemsOf(dir), /lock has no entry for skill: demo/);

  lockWith(dir, { version: 2, skills: null });
  assert.match(problemsOf(dir), /lock malformed/);
  writeFileSync(join(dir, "skills.lock.json"), "{bad");
  assert.match(problemsOf(dir), /lock unreadable/);
});
