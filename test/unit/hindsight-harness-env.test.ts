import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultRunner, makeRunner } from "../../src/blackhole/hindsight.ts";

function fakeCli(): string {
  const dir = mkdtempSync(join(tmpdir(), "hs-cli-"));
  const path = join(dir, "herdr-memory");
  writeFileSync(path, '#!/bin/sh\nprintf \'{"harness":"%s"}\' "$HERDR_HARNESS"\n');
  chmodSync(path, 0o755);
  return path;
}

test("the Hindsight runner identifies the harness as pi (the CLI defaults to codex)", async () => {
  const saved = process.env.HERDR_HARNESS;
  delete process.env.HERDR_HARNESS;
  try {
    const res = await defaultRunner(fakeCli(), ["status"], 3000);
    assert.equal(JSON.parse(res.stdout).harness, "pi");
  } finally {
    if (saved !== undefined) process.env.HERDR_HARNESS = saved;
  }
});

test("the harness comes from memory.hindsight.harness, not from the ambient HERDR_HARNESS", async () => {
  const saved = process.env.HERDR_HARNESS;
  process.env.HERDR_HARNESS = "claude";
  try {
    assert.equal(JSON.parse((await defaultRunner(fakeCli(), ["status"], 3000)).stdout).harness, "pi");
    assert.equal(JSON.parse((await makeRunner("pi-lab")(fakeCli(), ["status"], 3000)).stdout).harness, "pi-lab");
  } finally {
    if (saved === undefined) delete process.env.HERDR_HARNESS;
    else process.env.HERDR_HARNESS = saved;
  }
});

test("retain argv follows the real herdr-memory CLI: --evidence flags, no --timeout-ms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-cli2-"));
  const path = join(dir, "herdr-memory");
  // Mimics the argparse rules of herdr-memory contract v1: retain rejects --timeout-ms and needs --evidence or --explicit.
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'case "$*" in *--timeout-ms*) echo "unrecognized arguments: --timeout-ms" >&2; exit 2;; esac',
      'case "$*" in *--evidence*) printf \'{"outcome":"persisted","memory_id":"m1","bank_id":"b","revision":1}\';;',
      '*) printf \'{"outcome":"rejected"}\'; exit 1;; esac',
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  const { HindsightDurableMemory } = await import("../../src/blackhole/hindsight.ts");
  const m = new HindsightDurableMemory({ cli: path });
  const res = await m.retain({
    id: "x",
    text: "a fact",
    kind: "fact",
    status: "verified",
    scope: "project",
    evidenceIds: ["e1"],
    provenance: {},
  } as any);
  assert.equal(res.outcome, "persisted");
});
