/** T16 L10: a lock record naming pid 0 or a negative pid (kill(-1, 0) always "succeeds") must not be unstealable. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withFileLock } from "../../src/runtime/herdr/portableLock.ts";

const linux = process.platform === "linux";

for (const pid of [-1, 0]) {
  test(`a lock whose recorded owner pid is ${pid} is stale`, { skip: !linux }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-lock-"));
    const path = join(dir, "x.lock");
    writeFileSync(
      path,
      JSON.stringify({
        host: hostname(),
        boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        pidns: readlinkSync("/proc/self/ns/pid"),
        pid,
        token: "corrupt-owner",
        at: new Date().toISOString(),
      }),
    );
    let ran = false;
    await withFileLock(
      path,
      async () => {
        ran = true;
      },
      { timeoutMs: 1500, staleMs: 60_000 },
    );
    assert.equal(ran, true);
  });
}
