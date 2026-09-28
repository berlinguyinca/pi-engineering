import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";

const exec = promisify(execFile);

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

    // Missing content file surfaces as undefined (not an empty string).
    await rm(join(dir, "artifacts", "logs", "paged.txt"));
    assert.equal(await store.readSliceByUri("artifact://logs/paged", 0, 4), undefined);
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
    await mkdir(root, { recursive: true });
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
