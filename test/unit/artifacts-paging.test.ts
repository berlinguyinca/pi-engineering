import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, mkdtemp, open, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactStore } from "../../src/artifacts/ArtifactStore.ts";

// Count actual content IO, leaving metadata reads and filesystem validation real.
async function measureContentReads<T>(
  operation: () => Promise<T>,
  afterFirstContentRead?: () => Promise<void>,
): Promise<{ value: T; bytes: number }> {
  const handle = await open(import.meta.filename, "r");
  const prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const originalReadFile = prototype.readFile;
  const originalRead = prototype.read;
  let bytes = 0;
  let injected = false;
  const isContent = (fd: number) => realpathSync(`/proc/self/fd/${fd}`).endsWith(".txt");
  prototype.readFile = async function (...args: unknown[]) {
    const content = isContent(this.fd);
    const result = await originalReadFile.apply(this, args);
    if (content) bytes += Buffer.byteLength(result);
    return result;
  };
  prototype.read = async function (...args: unknown[]) {
    const content = isContent(this.fd);
    const result = await originalRead.apply(this, args);
    if (content) {
      bytes += result.bytesRead;
      if (afterFirstContentRead && !injected) {
        injected = true;
        await afterFirstContentRead();
      }
    }
    return result;
  };
  try {
    return { value: await operation(), bytes };
  } finally {
    prototype.readFile = originalReadFile;
    prototype.read = originalRead;
  }
}

test("artifact reopen reads metadata without loading historical blobs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-art-lazy-start-"));
  try {
    const store = await ArtifactStore.create(dir);
    await store.put("logs", "large", "x".repeat(2 * 1024 * 1024), "large log");
    const measured = await measureContentReads(() => ArtifactStore.create(dir));
    assert.equal(measured.value.getByUri("artifact://logs/large")?.size, 2 * 1024 * 1024);
    assert.equal(measured.bytes, 0, "opening an intact store must not load artifact content");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact pages validate once then use bounded ranged IO for distant unicode slices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-art-ranged-pages-"));
  try {
    const writer = await ArtifactStore.create(dir);
    const body = `${"a".repeat(65535)}😀é${"界😀".repeat(400_000)}`;
    await writer.put("logs", "unicode", body, "unicode log");
    const store = await ArtifactStore.create(dir);
    const initial = await measureContentReads(() => store.readSlice("logs", "unicode", 65535, 1));
    assert.equal(initial.value?.content, body.slice(65535, 65536), "UTF-16 offsets may split surrogate pairs");
    const pages = await measureContentReads(async () => {
      for (const offset of [65536, 65537, 700_000, body.length - 100, body.length + 100]) {
        const page = await store.readSlice("logs", "unicode", offset, 100);
        assert.equal(page?.content, body.slice(offset, offset + 100));
        assert.equal(page?.nextOffset, offset + body.slice(offset, offset + 100).length);
      }
    });
    assert.ok(pages.bytes < 1024 * 1024, `five cached pages read ${pages.bytes} bytes`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact page validation catches same-mtime rewrites and substituted content files", async () => {
  for (const replacement of ["rewrite", "rename", "symlink", "hardlink"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-art-page-${replacement}-`));
    try {
      const store = await ArtifactStore.create(dir);
      await store.put("logs", "item", "trusted content", "log");
      assert.equal((await store.readSlice("logs", "item", 0, 7))?.content, "trusted");
      const path = join(dir, "logs", "item.txt");
      const before = await stat(path);
      const other = join(dir, "substitute");
      if (replacement === "rewrite") {
        await writeFile(path, "changed content");
        await utimes(path, before.atime, before.mtime);
      } else {
        await writeFile(other, replacement === "hardlink" ? "trusted content" : "changed content");
        await rm(path);
        if (replacement === "rename") await rename(other, path);
        if (replacement === "symlink") await symlink(other, path);
        if (replacement === "hardlink") await link(other, path);
      }
      await assert.rejects(() => store.readSlice("logs", "item", 0, 7), /artifact integrity|ELOOP/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("artifact ranged decoding preserves malformed UTF-8 replacement at chunk boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-art-invalid-utf8-"));
  try {
    const writer = await ArtifactStore.create(dir);
    await writer.put("logs", "legacy", "placeholder", "legacy bytes");
    const bytes = Buffer.concat([
      Buffer.alloc(65535, 0x61),
      Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0xe0, 0x80]),
      Buffer.alloc(65532, 0x62),
      Buffer.from([0xe2, 0x82]),
      Buffer.alloc(65536, 0x63),
      Buffer.from([0xc2]),
    ]);
    const metadataPath = join(dir, "logs", "legacy.json");
    const meta = JSON.parse(await readFile(metadataPath, "utf8"));
    meta.size = bytes.length;
    meta.sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(dir, "logs", "legacy.txt"), bytes);
    await writeFile(metadataPath, JSON.stringify(meta));
    const store = await ArtifactStore.create(dir);
    const decoded = bytes.toString("utf8");
    for (const offset of [65534, 65535, 65536, 65537, 131064, 131070, decoded.length - 5]) {
      assert.equal((await store.readSlice("logs", "legacy", offset, 20))?.content, decoded.slice(offset, offset + 20));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact page indexes evict old entries and revalidate changed metadata digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-art-page-evict-"));
  try {
    const store = await ArtifactStore.create(dir);
    const body = "a".repeat(128 * 1024);
    for (let index = 0; index < 17; index++) {
      await store.put("logs", `item-${index}`, body, "log");
      await store.readSlice("logs", `item-${index}`, 0, 1);
    }
    const evicted = await measureContentReads(() => store.readSlice("logs", "item-0", 0, 1));
    assert.ok(evicted.bytes >= body.length, "the least recently used index must be revalidated after eviction");
    const cached = await measureContentReads(() => store.readSlice("logs", "item-0", 0, 1));
    assert.ok(cached.bytes < body.length, "the rebuilt index must serve bounded ranged reads");
    const metadataPath = join(dir, "logs", "item-0.json");
    const meta = JSON.parse(await readFile(metadataPath, "utf8"));
    meta.sha256 = createHash("sha256").update("b".repeat(body.length)).digest("hex");
    await writeFile(metadataPath, JSON.stringify(meta));
    await assert.rejects(() => store.readSlice("logs", "item-0", 0, 1), /artifact integrity.*digest/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact ranged reads reject content mutation or path replacement during IO", async () => {
  for (const change of ["rewrite", "replacement"] as const) {
    const dir = await mkdtemp(join(tmpdir(), `pi-art-page-race-${change}-`));
    try {
      const store = await ArtifactStore.create(dir);
      const body = "a".repeat(128 * 1024);
      await store.put("logs", "item", body, "log");
      await store.readSlice("logs", "item", 0, 1);
      const path = join(dir, "logs", "item.txt");
      let injected = false;
      await assert.rejects(
        () =>
          measureContentReads(
            () => store.readSlice("logs", "item", 0, 1),
            async () => {
              injected = true;
              if (change === "rewrite") await writeFile(path, `${body.slice(0, -1)}b`);
              else {
                const replacement = join(dir, "replacement");
                await writeFile(replacement, body);
                await rename(replacement, path);
              }
            },
          ),
        /artifact integrity.*changed during read/i,
      );
      assert.equal(injected, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
