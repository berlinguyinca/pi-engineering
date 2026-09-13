import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("roadmap dogfood: full lifecycle ends in a passing check (exit 0)", { timeout: 120_000 }, async () => {
  const { stdout } = await exec("node", [join(REPO, "scripts/dogfood-roadmap.ts")], { cwd: REPO, timeout: 120_000 });
  assert.match(stdout, /PASS: roadmap lifecycle dogfood succeeded/);
  assert.match(stdout, /6\. final passing check: exit 0/);
});

test("roadmap dogfood: lifecycle steps are deterministic", { timeout: 120_000 }, async () => {
  const { stdout } = await exec("node", [join(REPO, "scripts/dogfood-roadmap.ts")], { cwd: REPO, timeout: 120_000 });
  for (const step of [
    "1. incomplete: exit 1",
    "2. verified (evidence present): exit 0",
    "3. invalidated (scoped change): exit 1",
    "4. reverified: exit 0",
    "5. status: complete=true",
  ]) {
    assert.match(stdout, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
