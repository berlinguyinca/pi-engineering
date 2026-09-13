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
