import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadVisionDelegateSettings } from "../../src/visionDelegation/config.ts";

const DEFAULTS = { enabled: true, waitSeconds: 300, aliasPreference: ["qwen3.8-vision"], notes: [] };

async function withDir<T>(yaml: string | undefined, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "vision-config-"));
  try {
    if (yaml !== undefined) writeFileSync(join(dir, "engineering.yaml"), yaml);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const load = (yaml: string | undefined) => withDir(yaml, (d) => loadVisionDelegateSettings(d));

function assertOff(s: Awaited<ReturnType<typeof load>>) {
  assert.equal(s.enabled, false);
  assert.equal(s.waitSeconds, 300);
  assert.deepEqual(s.aliasPreference, ["qwen3.8-vision"]);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0] ?? "", /^vision_delegate off:/);
}

test("defaults when the block is absent", async () => {
  assert.deepEqual(await load(undefined), DEFAULTS);
  assert.deepEqual(await load("forks:\n  enabled: false\n"), DEFAULTS);
});

test("a present block without enabled stays on", async () => {
  assert.deepEqual(await load("vision_delegate:\n  wait_seconds: 60\n"), { ...DEFAULTS, waitSeconds: 60 });
});

test("a valid block is honoured", async () => {
  const s = await load("vision_delegate:\n  enabled: true\n  wait_seconds: 10\n  alias_preference: [a, b]\n");
  assert.deepEqual(s, { enabled: true, waitSeconds: 10, aliasPreference: ["a", "b"], notes: [] });
});

test("enabled false is the kill switch", async () => {
  const s = await load("vision_delegate:\n  enabled: false\n");
  assert.equal(s.enabled, false);
});

test("a non-boolean enabled turns it off with a note", async () => {
  assertOff(await load('vision_delegate:\n  enabled: "yes"\n'));
});

test("wait_seconds outside 10..3600 is rejected with a note and the default kept", async () => {
  for (const v of ["9", "3601", "0", "-5", "30.5", '"60"']) {
    const s = await load(`vision_delegate:\n  wait_seconds: ${v}\n`);
    assert.equal(s.enabled, true, v);
    assert.equal(s.waitSeconds, 300, v);
    assert.equal(s.notes.length, 1, v);
    assert.match(s.notes[0] ?? "", /wait_seconds/);
  }
  assert.equal((await load("vision_delegate:\n  wait_seconds: 3600\n")).waitSeconds, 3600);
});

test("a non-list alias_preference turns the feature off with a note", async () => {
  assertOff(await load("vision_delegate:\n  alias_preference: qwen\n"));
  assertOff(await load("vision_delegate:\n  alias_preference: []\n"));
  assertOff(await load('vision_delegate:\n  alias_preference: ["a", ""]\n'));
  assertOff(await load("vision_delegate:\n  alias_preference: [a, 3]\n"));
});

test("unknown keys, a non-mapping block, and unreadable yaml turn it off", async () => {
  assertOff(await load("vision_delegate:\n  enabled: true\n  bogus: 1\n"));
  assertOff(await load("vision_delegate: yes\n"));
  assertOff(await load("vision_delegate: [1]\n"));
  assertOff(await load("vision_delegate: [unclosed\n"));
});

test("a repository engineering.yaml cannot change it", async () => {
  await withDir("vision_delegate:\n  wait_seconds: 60\n", async (agentDir) => {
    const repo = mkdtempSync(join(tmpdir(), "vision-config-repo-"));
    const prevCwd = process.cwd();
    try {
      mkdirSync(join(repo, ".pi"), { recursive: true });
      const evil = "vision_delegate:\n  enabled: false\n  wait_seconds: 3000\n  alias_preference: [evil]\n";
      writeFileSync(join(repo, "engineering.yaml"), evil);
      writeFileSync(join(repo, ".pi", "engineering.yaml"), evil);
      process.chdir(repo);
      const s = await loadVisionDelegateSettings(agentDir);
      assert.deepEqual(s, { ...DEFAULTS, waitSeconds: 60 });
    } finally {
      process.chdir(prevCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
