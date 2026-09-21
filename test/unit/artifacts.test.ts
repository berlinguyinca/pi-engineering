import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";

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
