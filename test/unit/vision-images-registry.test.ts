import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { saveImages } from "../../src/visionDelegation/images.ts";
import { type RegistryEntry, VisionRegistry } from "../../src/visionDelegation/registry.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "vision-img-reg-"));
}

const BYTES = Buffer.from("not really a png, but bytes");
const B64 = BYTES.toString("base64");
const HASH = createHash("sha256").update(BYTES).digest("hex");

function entry(n: string): RegistryEntry {
  return { paneId: `pane-${n}`, agentName: `agent-${n}`, sessionDir: `/s/${n}`, startedAt: "2026-11-02T00:00:00.000Z" };
}

test("saveImages names files by sha256 and returns path and hash", async () => {
  const dir = tmp();
  try {
    const [saved] = await saveImages([{ data: B64, mimeType: "image/png" }], dir);
    assert.ok(saved);
    assert.equal(saved.sha256, HASH);
    assert.equal(saved.path, join(dir, "images", `${HASH}.png`));
    assert.equal(saved.mimeType, "image/png");
    assert.ok(existsSync(saved.path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveImages maps mime types to extensions", async () => {
  const dir = tmp();
  try {
    const mimes = ["image/jpeg", "image/jpg", "image/gif", "image/webp", "image/tiff"];
    const out = await saveImages(
      mimes.map((mimeType, i) => ({ data: Buffer.from(`x${i}`).toString("base64"), mimeType })),
      dir,
    );
    assert.deepEqual(
      out.map((o) => o.path.split(".").pop()),
      ["jpg", "jpg", "gif", "webp", "bin"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveImages rejects empty image data", async () => {
  const dir = tmp();
  try {
    await assert.rejects(saveImages([{ data: "", mimeType: "image/png" }], dir), /empty/i);
    await assert.rejects(saveImages([{ data: "!!!not base64!!!", mimeType: "image/png" }], dir), /base64|decod/i);
    assert.ok(!existsSync(join(dir, "images")) || readdirSync(join(dir, "images")).length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveImages with the same bytes twice yields one file and equal hashes", async () => {
  const dir = tmp();
  try {
    const out = await saveImages(
      [
        { data: B64, mimeType: "image/png" },
        { data: B64, mimeType: "image/png" },
      ],
      dir,
    );
    const [a, b] = out;
    assert.ok(a && b);
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.path, b.path);
    assert.equal(readdirSync(join(dir, "images")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry survives a reload from disk", () => {
  const dir = tmp();
  try {
    const file = join(dir, "reg", "registry.json");
    new VisionRegistry(file).set("s1", entry("1"));
    assert.deepEqual(new VisionRegistry(file).get("s1"), entry("1"));
    const r = new VisionRegistry(file);
    r.remove("s1");
    assert.equal(new VisionRegistry(file).get("s1"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry set replaces the entry for a session and leaves others", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    const r = new VisionRegistry(file);
    r.set("s1", entry("1"));
    r.set("s2", entry("2"));
    r.set("s1", entry("3"));
    const again = new VisionRegistry(file);
    assert.deepEqual(again.get("s1"), entry("3"));
    assert.deepEqual(again.get("s2"), entry("2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt registry file reads as empty instead of throwing", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    writeFileSync(file, "{ not json");
    const r = new VisionRegistry(file);
    assert.equal(r.get("s1"), undefined);
    r.set("s1", entry("1"));
    assert.deepEqual(new VisionRegistry(file).get("s1"), entry("1"));
    writeFileSync(file, JSON.stringify([1, 2]));
    assert.equal(new VisionRegistry(file).get("s1"), undefined);
    assert.equal(new VisionRegistry(join(dir, "missing.json")).get("x"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two registry instances on one file keep both sessions", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    const a = new VisionRegistry(file);
    const b = new VisionRegistry(file);
    a.set("s1", entry("1"));
    b.set("s2", entry("2"));
    a.set("s3", entry("3"));
    const r = new VisionRegistry(file);
    assert.deepEqual([r.get("s1"), r.get("s2"), r.get("s3")], [entry("1"), entry("2"), entry("3")]);
    assert.ok(!existsSync(`${file}.lock`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry remove of one session leaves the others", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    const r = new VisionRegistry(file);
    r.set("s1", entry("1"));
    r.set("s2", entry("2"));
    new VisionRegistry(file).remove("s1");
    assert.equal(r.get("s1"), undefined);
    assert.deepEqual(r.get("s2"), entry("2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale registry lock is taken over", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    const lock = `${file}.lock`;
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    new VisionRegistry(file).set("s1", entry("1"));
    assert.deepEqual(new VisionRegistry(file).get("s1"), entry("1"));
    assert.ok(!existsSync(lock));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a held registry lock makes set throw after the bounded wait", () => {
  const dir = tmp();
  try {
    const file = join(dir, "registry.json");
    writeFileSync(`${file}.lock`, "");
    const started = Date.now();
    assert.throws(() => new VisionRegistry(file, { lockTimeoutMs: 150 }).set("s1", entry("1")), /locked/);
    assert.ok(Date.now() - started < 3000);
    assert.ok(existsSync(`${file}.lock`), "a lock we did not take is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persistent non-ENOENT error on a stale lock still hits the deadline instead of spinning", () => {
  const dir = tmp();
  const ro = join(dir, "ro");
  try {
    mkdirSync(ro);
    const file = join(ro, "registry.json");
    writeFileSync(`${file}.lock`, "");
    // A read-only directory: the lock is stale (lockStaleMs 0) but unlinking it fails with EACCES every time.
    chmodSync(ro, 0o555);
    const started = Date.now();
    assert.throws(
      () => new VisionRegistry(file, { lockTimeoutMs: 150, lockStaleMs: 0 }).set("s1", entry("1")),
      /locked/,
    );
    assert.ok(Date.now() - started < 3000);
  } finally {
    chmodSync(ro, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent saveImages with identical bytes both succeed and leave one file", async () => {
  const dir = tmp();
  try {
    const img = [{ data: B64, mimeType: "image/png" }];
    const [a, b] = await Promise.all([saveImages(img, dir), saveImages(img, dir)]);
    assert.equal(a?.[0]?.sha256, HASH);
    assert.equal(b?.[0]?.sha256, HASH);
    const files = readdirSync(join(dir, "images"));
    assert.deepEqual(files, [`${HASH}.png`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
