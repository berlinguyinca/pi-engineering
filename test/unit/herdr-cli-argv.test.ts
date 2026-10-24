import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RealHerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";

/** A stand-in `herdr` that records its argv, so we pin the exact flags herdr 0.9.1 accepts. */
function fake() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-argv-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "herdr");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\necho '{"result":{"agent_status":"idle"}}'\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, lines: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("agent start uses the positional name and --pane", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).startAgent("w1:p2", "pi", "reviewer");
    assert.deepEqual(f.lines(), ["agent start reviewer --kind pi --pane w1:p2"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent wait repeats --until and uses --timeout", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).wait("a1", ["idle", "done"], 5000);
    assert.deepEqual(f.lines(), ["agent wait a1 --until idle --until done --timeout 5000"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("exportEnv runs one export line in the pane and refuses unsafe values", async () => {
  const f = fake();
  try {
    const cli = new RealHerdrCli({ bin: f.bin });
    await cli.exportEnv("w1:p2", { PI_ENGINEERING_ROLE: "reviewer" });
    assert.deepEqual(f.lines(), ["pane run w1:p2 export PI_ENGINEERING_ROLE=reviewer"]);
    await assert.rejects(cli.exportEnv("w1:p2", { PI_ENGINEERING_ROLE: "x; rm -rf /" }), /unsafe/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
