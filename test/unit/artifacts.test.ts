import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";

const exec = promisify(execFile);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function processIncarnation(): Promise<{ bootId: string; processStartTime: string }> {
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const statLine = await readFile(`/proc/${process.pid}/stat`, "utf8");
  return {
    bootId,
    processStartTime: statLine
      .slice(statLine.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19]!,
  };
}

test("artifacts are stored on disk and read lazily by URI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-"));
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const big = "x".repeat(100_000);
    const meta = await store.put("verify", "tr-1", big, "summary: passed");
    assert.match(meta.uri, /^artifact:\/\/verify\/tr-1$/);
    assert.equal(meta.size, big.length);

    // Metadata is compact; full content is retrieved on demand.
    const byUri = store.getByUri("artifact://verify/tr-1");
    assert.equal(byUri?.summary, "summary: passed");
    const content = await store.readContentByUri("artifact://verify/tr-1");
    assert.equal(content, big);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact store is rehydrated from disk after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-"));
  try {
    const root = join(dir, "artifacts");
    const store1 = await ArtifactStore.create(root);
    await store1.put("logs", "a", "hello", "s");
    const store2 = await ArtifactStore.create(root);
    assert.equal(store2.getByUri("artifact://logs/a")?.size, 5);
    assert.equal(await store2.readContent("logs", "a"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact get resolves by composite key and by bare unique id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-"));
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    await store.put("verify", "tr-9", "content-a", "summary a");
    await store.put("logs", "run-1", "content-b", "summary b");

    // Composite key (the index key) resolves directly.
    assert.equal((await store.get("verify/tr-9"))?.summary, "summary a");
    // Bare id resolves across categories (the latent get(id) bug fix).
    assert.equal((await store.get("tr-9"))?.summary, "summary a");
    assert.equal((await store.get("run-1"))?.summary, "summary b");
    // Unknown ids return undefined.
    assert.equal(await store.get("does-not-exist"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact slices are read lazily and page correctly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-"));
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const body = "abcdefghij";
    await store.put("logs", "paged", body, "s");

    const first = await store.readSlice("logs", "paged", 0, 4);
    assert.equal(first?.content, "abcd");
    assert.equal(first?.nextOffset, 4);

    const second = await store.readSliceByUri("artifact://logs/paged", 4, 4);
    assert.equal(second?.content, "efgh");
    assert.equal(second?.nextOffset, 8);

    // Past the end returns the remaining tail, not more bytes than exist.
    const tail = await store.readSliceByUri("artifact://logs/paged", 8, 100);
    assert.equal(tail?.content, "ij");
    assert.equal(tail?.nextOffset, 10);

    // Metadata with missing content is a fail-closed integrity violation.
    await rm(join(dir, "artifacts", "logs", "paged.txt"));
    await assert.rejects(() => store.readSliceByUri("artifact://logs/paged", 0, 4), /artifact integrity/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkpoint-owned immutable writes keep concurrent equal-content claims distinct and replayable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-"));
  try {
    const root = join(dir, "artifacts");
    const store = await ArtifactStore.create(root);
    const [first, second] = await Promise.all([
      store.putImmutable("checkpoint", "TCP-same", "same bytes", "first claim"),
      store.putImmutable("checkpoint", "TCP-same", "same bytes", "second claim"),
    ]);

    assert.notEqual(first.uri, second.uri);
    assert.match(first.uri, /^artifact:\/\/checkpoint\/TCP-same-[a-f0-9]{64}-/);
    assert.equal(await store.readContentByUri(first.uri), "same bytes");
    assert.equal(await store.readContentByUri(second.uri), "same bytes");

    await assert.rejects(
      () => store.put("checkpoint", first.id, "mutated bytes", "overwrite attempt"),
      /immutable checkpoint artifact/i,
    );
    await assert.rejects(() => store.delete(second.uri), /immutable checkpoint artifact/i);
    assert.equal(await store.readContentByUri(first.uri), "same bytes");
    assert.equal(await store.readContentByUri(second.uri), "same bytes");

    const replayed = await ArtifactStore.create(root);
    assert.equal(await replayed.readContentByUri(first.uri), "same bytes");
    assert.equal(await replayed.readContentByUri(second.uri), "same bytes");
    await assert.rejects(
      () => replayed.put("checkpoint", first.id, "replayed mutation", "overwrite attempt"),
      /immutable checkpoint artifact/i,
    );
    await assert.rejects(() => replayed.delete(second.uri), /immutable checkpoint artifact/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact coordinates reject path aliases and remain contained in the exact category", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-canonical-"));
  try {
    const root = join(dir, "artifacts");
    const store = await ArtifactStore.create(root);
    const invalidSegments = [".", "..", "a/b", "a\\b", "%2e%2e", "x%2Fy"];

    for (const segment of invalidSegments) {
      await assert.rejects(() => store.put(segment, "safe", "bad", "bad"), /canonical artifact/i);
      await assert.rejects(() => store.put("safe", segment, "bad", "bad"), /canonical artifact/i);
      await assert.rejects(() => store.readContent(segment, "safe"), /canonical artifact/i);
      await assert.rejects(() => store.readContent("safe", segment), /canonical artifact/i);
    }

    const meta = await store.put("safe", "item-1", "contained", "proof");
    assert.equal(await readFile(join(root, "safe", "item-1.txt"), "utf8"), "contained");
    assert.throws(() => store.getByUri(`artifact://safe/../${meta.id}`), /canonical artifact/i);
    assert.throws(() => store.getByUri(`artifact://safe/%2e%2e`), /canonical artifact/i);
    await assert.rejects(() => store.delete(`artifact://safe/../${meta.id}`), /canonical artifact/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("immutable policy uses private canonical keys and frozen metadata across live and reopened stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-policy-"));
  try {
    const root = join(dir, "artifacts");
    const store = await ArtifactStore.create(root);
    const immutable = await store.putImmutable("checkpoint", "TCP-policy", "trusted bytes", "proof");

    assert.ok(Object.isFrozen(immutable));
    assert.throws(() => Object.assign(immutable, { id: "alias", category: "other", uri: "artifact://other/alias" }));
    const live = store.getByUri(immutable.uri)!;
    assert.ok(Object.isFrozen(live));
    assert.notEqual(live, immutable);
    assert.throws(() => Object.assign(live, { summary: "mutable policy" }));
    const listed = store.list("checkpoint");
    assert.ok(listed.every(Object.isFrozen));
    assert.notEqual(listed[0], live);

    const reopened = await ArtifactStore.create(root);

    const collisionResults = await Promise.allSettled([
      store.put("checkpoint", immutable.id, "collision", "collision"),
      reopened.delete(immutable.uri),
      reopened.put("checkpoint", immutable.id, "replay collision", "collision"),
      store.put("checkpoint/..", immutable.id, "alias collision", "collision"),
      store.delete(`artifact://checkpoint/%2e%2e/${immutable.id}`),
    ]);
    assert.ok(collisionResults.every((result) => result.status === "rejected"));
    assert.equal(await store.readContentByUri(immutable.uri), "trusted bytes");

    const replayed = reopened.getByUri(immutable.uri)!;
    assert.ok(Object.isFrozen(replayed));
    assert.notEqual(replayed, live);
    assert.throws(() => Object.assign(replayed, { id: "replayed-alias" }));
    await assert.rejects(
      () => reopened.put("checkpoint", immutable.id, "replay collision", "collision"),
      /immutable checkpoint artifact/i,
    );
    await assert.rejects(() => reopened.delete(immutable.uri), /immutable checkpoint artifact/i);
    assert.equal(await reopened.readContentByUri(immutable.uri), "trusted bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale store and a separate process cannot overwrite a newly durable immutable key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-cross-process-"));
  try {
    const root = join(dir, "artifacts");
    const stale = await ArtifactStore.create(root);
    const moduleUrl = new URL("../../src/artifacts/ArtifactStore.ts", import.meta.url).href;
    const child = await exec(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { ArtifactStore } from ${JSON.stringify(moduleUrl)}; const store = await ArtifactStore.create(${JSON.stringify(root)}); const meta = await store.putImmutable("checkpoint", "TCP-child", "child trusted bytes", "child"); process.stdout.write(meta.id);`,
      ],
      { encoding: "utf8" },
    );
    const id = child.stdout.trim();
    assert.match(id, /^TCP-child-/);

    await assert.rejects(
      () => stale.put("checkpoint", id, "stale overwrite", "stale"),
      /immutable checkpoint artifact/i,
    );
    assert.equal(await stale.readContent("checkpoint", id), "child trusted bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent processes serialize one canonical key without mixing content and metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-process-race-"));
  try {
    const root = join(dir, "artifacts");
    const moduleUrl = new URL("../../src/artifacts/ArtifactStore.ts", import.meta.url).href;
    const writer = (label: string, byte: string) =>
      exec(process.execPath, [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `import { ArtifactStore } from ${JSON.stringify(moduleUrl)}; const store = await ArtifactStore.create(${JSON.stringify(root)}); await new Promise((resolve) => setTimeout(resolve, 200)); await store.put("logs", "shared", ${JSON.stringify(byte)}.repeat(1048576), ${JSON.stringify(label)});`,
      ]);

    await Promise.all([writer("first", "a"), writer("second", "b")]);

    const reopened = await ArtifactStore.create(root);
    const meta = reopened.getByUri("artifact://logs/shared")!;
    const content = await reopened.readContentByUri(meta.uri);
    assert.equal(meta.size, 1_048_576);
    assert.equal(content, meta.summary === "first" ? "a".repeat(1_048_576) : "b".repeat(1_048_576));
    assert.ok(meta.summary === "first" || meta.summary === "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt immutable replay reserves the canonical key instead of permitting overwrite", async () => {
  for (const corruption of ["mismatched-uri", "missing-marker"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-eng-art-corrupt-${corruption}-`));
    try {
      const root = join(dir, "artifacts");
      const stale = await ArtifactStore.create(root);
      const writer = await ArtifactStore.create(root);
      const immutable = await writer.putImmutable("checkpoint", "TCP-corrupt", "trusted bytes", "proof");
      const metadataPath = join(root, "checkpoint", `${immutable.id}.json`);
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      if (corruption === "mismatched-uri") metadata.uri = `artifact://other/${immutable.id}`;
      else delete metadata.immutable;
      await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

      await assert.rejects(() => ArtifactStore.create(root), /artifact integrity/i);
      await assert.rejects(
        () => stale.put("checkpoint", immutable.id, "overwrite", "overwrite"),
        /artifact integrity/i,
      );
      assert.equal(await readFile(join(root, "checkpoint", `${immutable.id}.txt`), "utf8"), "trusted bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("artifact reads, writes, and deletes reject symlinked categories and final files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-symlink-"));
  try {
    const root = join(dir, "artifacts");
    const outside = join(dir, "outside");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(outside, { recursive: true });
    const store = await ArtifactStore.create(root);
    await symlink(outside, join(root, "linked"), "dir");

    await assert.rejects(() => store.put("linked", "escape", "outside", "bad"), /symlink|containment/i);
    await assert.rejects(() => store.readContent("linked", "escape"), /symlink|containment/i);

    const meta = await store.put("safe", "item", "trusted", "proof");
    const contentPath = join(root, "safe", "item.txt");
    const outsideFile = join(outside, "outside.txt");
    await writeFile(outsideFile, "outside", "utf8");
    await rm(contentPath);
    await symlink(outsideFile, contentPath);

    await assert.rejects(() => store.readContent("safe", "item"), /symlink|containment/i);
    await assert.rejects(() => store.put("safe", "item", "overwrite", "bad"), /symlink|containment/i);
    await assert.rejects(() => store.delete(meta.uri), /symlink|containment/i);
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-and-dispatch validates canonical metadata and immutable binding before dispatch", async () => {
  for (const corruption of ["missing-meta", "missing-marker", "mismatched-uri"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-eng-art-verify-meta-${corruption}-`));
    try {
      const root = join(dir, "artifacts");
      const store = await ArtifactStore.create(root);
      const content = "dispatch evidence";
      const artifact = await store.putImmutable("checkpoint", "TCP-dispatch", content, "proof");
      const metadataPath = join(root, "checkpoint", `${artifact.id}.json`);
      if (corruption === "missing-meta") {
        await rm(metadataPath);
      } else {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
        if (corruption === "missing-marker") delete metadata.immutable;
        else metadata.uri = `artifact://other/${artifact.id}`;
        await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
      }

      let dispatches = 0;
      assert.throws(
        () =>
          store.verifyAndDispatch([artifact.uri], [`sha256:${sha256(content)}`], () => {
            dispatches += 1;
          }),
        /artifact integrity|ENOENT/i,
      );
      assert.equal(dispatches, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("durable metadata binds every record to exact size and digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-digest-"));
  try {
    const root = join(dir, "artifacts");
    const store = await ArtifactStore.create(root);
    const mutable = await store.put("logs", "mutable", "old content", "old");
    const immutable = await store.putImmutable("checkpoint", "TCP-digest", "trusted bytes", "proof");

    const mutableMetadataPath = join(root, "logs", "mutable.json");
    const mutableMetadata = JSON.parse(await readFile(mutableMetadataPath, "utf8")) as Record<string, unknown>;
    assert.equal(mutableMetadata.sha256, sha256("old content"));
    const immutableMetadata = JSON.parse(
      await readFile(join(root, "checkpoint", `${immutable.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(immutableMetadata.sha256, sha256("trusted bytes"));
    assert.match(immutable.id, new RegExp(String.raw`-${immutableMetadata.sha256}-`));

    await store.put("logs", "mutable", "new content", "new");
    await writeFile(mutableMetadataPath, JSON.stringify(mutableMetadata), "utf8");
    await assert.rejects(() => ArtifactStore.create(root), /artifact integrity.*(digest|size)/i);

    await writeFile(join(root, "logs", "mutable.txt"), "old", "utf8");
    await assert.rejects(() => ArtifactStore.create(root), /artifact integrity.*(digest|size)/i);

    assert.equal(mutable.uri, "artifact://logs/mutable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pinned category descriptors prevent deterministic read write delete and verify swap escapes", async () => {
  for (const operation of ["read", "write", "delete", "verify"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-eng-art-dir-race-${operation}-`));
    try {
      const root = join(dir, "artifacts");
      const outside = join(dir, "outside");
      await mkdir(outside);
      const seed = await ArtifactStore.create(root);
      const artifact =
        operation === "verify"
          ? await seed.putImmutable("safe", "TCP-race", "trusted", "proof")
          : await seed.put("safe", "item", "trusted", "proof");
      await writeFile(join(outside, `${artifact.id}.txt`), "outside", "utf8");
      await writeFile(
        join(outside, `${artifact.id}.json`),
        JSON.stringify({
          id: artifact.id,
          category: "safe",
          uri: artifact.uri,
          size: 7,
          sha256: sha256("outside"),
          created_at: "2026-09-27T00:00:00.000Z",
          summary: "outside",
          ...(operation === "verify" ? { immutable: true } : {}),
        }),
        "utf8",
      );
      let swapped = false;
      const store = await ArtifactStore.create(root, {
        afterCategoryOpened: (kind: string, category: string) => {
          if (swapped || kind !== operation || category !== "safe") return;
          swapped = true;
          renameSync(join(root, "safe"), join(root, "safe-pinned"));
          symlinkSync(outside, join(root, "safe"), "dir");
        },
      });

      if (operation === "read") assert.equal(await store.readContentByUri(artifact.uri), "trusted");
      if (operation === "write") await store.put("safe", "item", "updated", "updated");
      if (operation === "delete") await store.delete(artifact.uri);
      if (operation === "verify") {
        store.verifyAndDispatch([artifact.uri], [`sha256:${sha256("trusted")}`], () => undefined);
      }
      assert.equal(swapped, true, "the deterministic swap hook must exercise the race window");
      assert.equal(await readFile(join(outside, `${artifact.id}.txt`), "utf8"), "outside");
      assert.equal(JSON.parse(await readFile(join(outside, `${artifact.id}.json`), "utf8")).summary, "outside");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test(
  "artifact key locks recover killed owners and release only their matching owner token",
  { timeout: 2_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-lock-owner-"));
    try {
      const root = join(dir, "artifacts");
      const store = await ArtifactStore.create(root);
      const lockBase = join(root, ".artifact-locks", sha256("logs/shared"));
      const lockPath = `${lockBase}.lock`;
      const incarnation = await processIncarnation();
      await writeFile(
        lockPath,
        `${JSON.stringify({
          pid: 2_000_000_000,
          host: hostname(),
          openedAt: "2026-01-01T00:00:00.000Z",
          ownerToken: "killed-owner",
          bootId: incarnation.bootId,
          processStartTime: "1",
        })}\n`,
        "utf8",
      );
      await utimes(lockPath, new Date(0), new Date(0));
      await store.put("logs", "shared", "recovered", "recovered");

      let releaseOperation: (() => void) | undefined;
      const operationPaused = new Promise<void>((resolve) => {
        releaseOperation = resolve;
      });
      let lockAcquired: (() => void) | undefined;
      const acquired = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const pausing = await ArtifactStore.create(root, {
        afterKeyLockAcquired: async (key: string) => {
          if (key !== "logs/replacement") return;
          lockAcquired?.();
          await operationPaused;
        },
      });
      const pending = pausing.put("logs", "replacement", "owner-a", "a");
      await acquired;
      const replacementLock = `${join(root, ".artifact-locks", sha256("logs/replacement"))}.lock`;
      const originalIdentity = readFileSync(replacementLock, "utf8");
      const originalInode = lstatSync(replacementLock).ino;
      rmSync(replacementLock, { force: true });
      for (let index = 0; index < 16; index += 1) {
        writeFileSync(join(root, ".artifact-locks", `inode-reservation-${index}`), "reserved", "utf8");
      }
      writeFileSync(replacementLock, originalIdentity, "utf8");
      assert.notEqual(lstatSync(replacementLock).ino, originalInode, "the replacement fixture needs a new inode");
      releaseOperation?.();
      await pending;
      assert.equal(
        readFileSync(replacementLock, "utf8"),
        originalIdentity,
        "release must also match the acquired inode",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a journal published before SIGKILL recovers one complete content-metadata generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-journal-crash-"));
  try {
    const root = join(dir, "artifacts");
    const seed = await ArtifactStore.create(root);
    await seed.put("logs", "crash", "old bytes", "old");
    const moduleUrl = new URL("../../src/artifacts/ArtifactStore.ts", import.meta.url).href;
    await assert.rejects(
      () =>
        exec(process.execPath, [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { ArtifactStore } from ${JSON.stringify(moduleUrl)}; const store = await ArtifactStore.create(${JSON.stringify(root)}, { afterJournalCommitted: () => process.kill(process.pid, "SIGKILL") }); await store.put("logs", "crash", "new bytes", "new");`,
        ]),
      /SIGKILL|killed/i,
    );

    const replayed = await ArtifactStore.create(root);
    assert.equal(await replayed.readContent("logs", "crash"), "new bytes");
    assert.equal(replayed.getByUri("artifact://logs/crash")?.summary, "new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("simultaneous stale-lock reapers serialize the artifact critical section at max concurrency one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-reaper-concurrency-"));
  try {
    const root = join(dir, "artifacts");
    await ArtifactStore.create(root);
    const lockPath = join(root, ".artifact-locks", `${sha256("logs/shared")}.lock`);
    const incarnation = await processIncarnation();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 2_000_000_000,
        host: hostname(),
        openedAt: "2026-01-01T00:00:00.000Z",
        ownerToken: "dead-owner-for-simultaneous-reapers",
        bootId: incarnation.bootId,
        processStartTime: "1",
      })}\n`,
      "utf8",
    );
    const events = join(dir, "events.jsonl");
    const moduleUrl = new URL("../../src/artifacts/ArtifactStore.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, index) =>
      spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--input-type=module",
          "--eval",
          `import { appendFile } from "node:fs/promises"; import { ArtifactStore } from ${JSON.stringify(moduleUrl)}; const store = await ArtifactStore.create(${JSON.stringify(root)}, { afterKeyLockAcquired: async (key) => { if (key !== "logs/shared") return; await appendFile(${JSON.stringify(events)}, JSON.stringify({type:"start", pid:process.pid})+"\\n"); await new Promise((resolve) => setTimeout(resolve, 75)); await appendFile(${JSON.stringify(events)}, JSON.stringify({type:"end", pid:process.pid})+"\\n"); } }); await store.put("logs", "shared", ${JSON.stringify(`writer-${index}`)}, ${JSON.stringify(`writer-${index}`)});`,
        ],
        { stdio: "inherit" },
      ),
    );
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => {
              if (code === 0) resolve();
              else reject(new Error(`artifact contender failed code=${code} signal=${signal}`));
            });
          }),
      ),
    );

    let active = 0;
    let maximum = 0;
    for (const event of (await readFile(events, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{
      type: "start" | "end";
    }>) {
      active += event.type === "start" ? 1 : -1;
      maximum = Math.max(maximum, active);
      assert.ok(active >= 0);
    }
    assert.equal(active, 0);
    assert.equal(maximum, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verify-and-dispatch rejects a mutable artifact even when its bytes and digest are valid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-dispatch-mutable-"));
  try {
    const store = await ArtifactStore.create(join(dir, "artifacts"));
    const mutable = await store.put("logs", "mutable", "valid bytes", "mutable");
    let dispatches = 0;
    assert.throws(
      () =>
        store.verifyAndDispatch([mutable.uri], [`sha256:${sha256("valid bytes")}`], () => {
          dispatches += 1;
        }),
      /artifact integrity.*immutable/i,
    );
    assert.equal(dispatches, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete recovery is durable across both category-fsync crash phases", async () => {
  for (const phase of ["afterDeleteFilesSynced", "afterDeleteJournalRemoved"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-eng-art-delete-crash-${phase}-`));
    try {
      const root = join(dir, "artifacts");
      const seed = await ArtifactStore.create(root);
      const artifact = await seed.put("logs", "delete-me", "bytes", "delete");
      const moduleUrl = new URL("../../src/artifacts/ArtifactStore.ts", import.meta.url).href;
      await assert.rejects(
        () =>
          exec(process.execPath, [
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            `import { ArtifactStore } from ${JSON.stringify(moduleUrl)}; const store = await ArtifactStore.create(${JSON.stringify(root)}, { ${phase}: () => process.kill(process.pid, "SIGKILL") }); await store.delete(${JSON.stringify(artifact.uri)});`,
          ]),
        /SIGKILL|killed/i,
      );

      const replayed = await ArtifactStore.create(root);
      assert.equal(await replayed.readContentByUri(artifact.uri), undefined);
      assert.equal(replayed.getByUri(artifact.uri), undefined);
      await assert.rejects(() => readFile(join(root, "logs", "delete-me.txn.json")), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a pinned lock-directory descriptor prevents a deterministic lock-root swap escape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-eng-art-lock-dir-race-"));
  try {
    const root = join(dir, "artifacts");
    const outside = join(dir, "outside-locks");
    await mkdir(outside, { mode: 0o700 });
    let swapped = false;
    const store = await ArtifactStore.create(root, {
      afterLockDirectoryOpened: () => {
        if (swapped) return;
        swapped = true;
        renameSync(join(root, ".artifact-locks"), join(root, ".artifact-locks-pinned"));
        symlinkSync(outside, join(root, ".artifact-locks"), "dir");
      },
    });
    await store.put("logs", "safe", "bytes", "safe");
    assert.equal(swapped, true);
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await store.readContent("logs", "safe"), "bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
