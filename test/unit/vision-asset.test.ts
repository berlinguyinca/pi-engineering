import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AssetStatus, type VisionAsset, VisionAssetManager, nextStatus } from "../../src/vision/asset.ts";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_MAX_LONG_EDGE,
  MAX_MAX_LONG_EDGE,
  MIN_MAX_LONG_EDGE,
  computeSha256,
  detectMimeType,
  extractMetadata,
  parseJpegDimensions,
  parsePngDimensions,
  planDerivative,
  scaleDimensions,
  shouldTile,
} from "../../src/vision/processor.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function makePng(width: number, height: number, colorType: number): Uint8Array {
  const buf = new Uint8Array(30);
  buf.set(PNG_SIGNATURE, 0);
  buf.set([0x00, 0x00, 0x00, 0x0d], 8); // IHDR chunk length = 13
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint32(16, width, false);
  dv.setUint32(20, height, false);
  buf[24] = 8; // bit depth
  buf[25] = colorType;
  return buf;
}

function makeJpeg(width: number, height: number): Uint8Array {
  // SOF0 (C0) frame: FF C0, length(2) = 8+3, precision(1), height(2), width(2).
  const buf = new Uint8Array(16);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  dv.setUint16(4, 11, false); // segment length (includes the 2 length bytes)
  buf[6] = 8; // precision
  dv.setUint16(7, height, false);
  dv.setUint16(9, width, false);
  return buf;
}

function makeAsset(overrides: Partial<VisionAsset> = {}): VisionAsset {
  return {
    assetId: "asset-1",
    sourcePath: "/tmp/screen.png",
    sha256: "abc123",
    mimeType: "image/png",
    width: 100,
    height: 100,
    originalBytes: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "NEW",
    ...overrides,
  };
}

test("detectMimeType sniffs png/jpeg/gif/webp and returns null otherwise", () => {
  assert.equal(detectMimeType(makePng(10, 10, 2)), "image/png");
  assert.equal(detectMimeType(makeJpeg(10, 10)), "image/jpeg");
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(detectMimeType(gif), "image/gif");
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  ]);
  assert.equal(detectMimeType(webp), "image/webp");
  assert.equal(detectMimeType(new Uint8Array([0x00, 0x01, 0x02])), null);
  assert.equal(detectMimeType(new Uint8Array(0)), null);
});

test("parsePngDimensions reads IHDR width/height big-endian", () => {
  assert.deepEqual(parsePngDimensions(makePng(800, 600, 2)), { width: 800, height: 600 });
  assert.deepEqual(parsePngDimensions(makePng(1, 1, 2)), { width: 1, height: 1 });
});

test("parsePngDimensions is defensive on malformed input", () => {
  assert.equal(parsePngDimensions(new Uint8Array(0)), null);
  assert.equal(parsePngDimensions(new Uint8Array(10)), null);
  assert.equal(parsePngDimensions(new Uint8Array([0x00, 0x00])), null);
  const noIhdr = new Uint8Array(30);
  noIhdr.set(PNG_SIGNATURE, 0);
  assert.equal(parsePngDimensions(noIhdr), null);
});

test("parseJpegDimensions reads SOF0/SOF2 markers", () => {
  assert.deepEqual(parseJpegDimensions(makeJpeg(1920, 1080)), { width: 1920, height: 1080 });
  // SOF2 (C2) marker
  const jpeg = makeJpeg(640, 480);
  jpeg[3] = 0xc2;
  assert.deepEqual(parseJpegDimensions(jpeg), { width: 640, height: 480 });
});

test("parseJpegDimensions is defensive on malformed input", () => {
  assert.equal(parseJpegDimensions(new Uint8Array(0)), null);
  assert.equal(parseJpegDimensions(new Uint8Array([0xff, 0xd8])), null);
  assert.equal(parseJpegDimensions(new Uint8Array([0x01, 0x02, 0x03])), null);
});

test("extractMetadata returns mime, dims and hasAlpha", () => {
  const opaque = extractMetadata(makePng(200, 100, 2));
  assert.deepEqual(opaque, { mimeType: "image/png", width: 200, height: 100, hasAlpha: false });
  const alpha = extractMetadata(makePng(200, 100, 6));
  assert.equal(alpha.hasAlpha, true);
  const jpeg = extractMetadata(makeJpeg(320, 240));
  assert.deepEqual(jpeg, { mimeType: "image/jpeg", width: 320, height: 240, hasAlpha: false });
});

test("computeSha256 is deterministic hex", () => {
  const buf = new TextEncoder().encode("hello world");
  const first = computeSha256(buf);
  const second = computeSha256(buf);
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(computeSha256(new TextEncoder().encode("hello")), first);
});

test("scaleDimensions never upscales and preserves aspect ratio", () => {
  assert.deepEqual(scaleDimensions(100, 100, DEFAULT_MAX_LONG_EDGE), { width: 100, height: 100 });
  const scaled = scaleDimensions(3600, 1800, 1800);
  assert.deepEqual(scaled, { width: 1800, height: 900 }); // long edge clamped, aspect 2:1 preserved
  const wide = scaleDimensions(4000, 2000, 1800);
  assert.deepEqual(wide, { width: 1800, height: 900 });
  assert.equal(wide.width / wide.height, 2);
});

test("scaleDimensions clamps maxLongEdge to [1200, 2400]", () => {
  const small = scaleDimensions(6000, 3000, 1);
  assert.equal(small.width, MIN_MAX_LONG_EDGE); // long edge (width) clamped to floor
  const large = scaleDimensions(6000, 3000, 9999);
  assert.equal(large.width, MAX_MAX_LONG_EDGE); // long edge (width) clamped to ceiling
});

test("shouldTile thresholds", () => {
  assert.equal(shouldTile(3000, 3000), false);
  assert.equal(shouldTile(3001, 3000), true);
  assert.equal(shouldTile(3000, 3001), true);
  assert.equal(shouldTile(5000, 500, { threshold: 1000 }), true);
  assert.equal(shouldTile(500, 500, { threshold: 1000 }), false);
});

test("planDerivative format/quality/tile decisions", () => {
  const jpeg = planDerivative(800, 600);
  assert.equal(jpeg.format, "jpeg");
  assert.equal(jpeg.quality, DEFAULT_JPEG_QUALITY);
  assert.equal(jpeg.tiles, 0);
  assert.deepEqual([jpeg.targetWidth, jpeg.targetHeight], [800, 600]);

  const png = planDerivative(800, 600, { preserveTransparency: true, quality: 90 });
  assert.equal(png.format, "png");
  assert.equal(png.quality, 90);

  const tiled = planDerivative(5000, 3000);
  assert.equal(tiled.tiles, 4);
  const tiledCustom = planDerivative(1200, 1200, { tileThreshold: 1000 });
  assert.equal(tiledCustom.tiles, 4);

  const scaled = planDerivative(4000, 2000);
  assert.deepEqual([scaled.targetWidth, scaled.targetHeight], [1800, 900]);
});

test("cache paths are content-addressed under cacheRoot", () => {
  const m = new VisionAssetManager();
  assert.equal(m.cacheDir("sha1"), join(".vision-cache", "sha1"));
  assert.equal(m.derivativePath("sha1"), join(".vision-cache", "sha1", "vision.jpg"));
  assert.equal(m.analysisJsonPath("sha1"), join(".vision-cache", "sha1", "analysis.json"));
  assert.equal(m.analysisMdPath("sha1"), join(".vision-cache", "sha1", "analysis.md"));
});

test("duplicate detection via getBySha256", () => {
  const m = new VisionAssetManager();
  const a = makeAsset({ assetId: "a", sha256: "same" });
  const b = makeAsset({ assetId: "b", sha256: "same" });
  m.register(a);
  m.register(b);
  assert.equal(m.getBySha256("same")?.assetId, "b");
  assert.equal(m.getBySha256("missing"), undefined);
});

test("asset status lifecycle transitions", () => {
  const m = new VisionAssetManager();
  const asset = makeAsset({ assetId: "a", sha256: "s1" });
  m.register(asset);
  assert.equal(m.assetStatus("a"), "NEW");
  m.markAnalyzed("s1");
  assert.equal(m.assetStatus("a"), "ACTIVE_ANALYSIS");
});

test("nextStatus walks the lifecycle and is terminal at OFFLOADED", () => {
  const transitions: ReadonlyArray<[AssetStatus, AssetStatus]> = [
    ["NEW", "ACTIVE_ANALYSIS"],
    ["ACTIVE_ANALYSIS", "OBSERVATION_EXTRACTED"],
    ["OBSERVATION_EXTRACTED", "OFFLOADED"],
  ];
  for (const [from, to] of transitions) {
    assert.equal(nextStatus(from), to);
  }
  assert.equal(nextStatus("OFFLOADED"), "OFFLOADED");
});

test("markAnalyzed / hasCachedAnalysis (in-memory and disk)", () => {
  const m = new VisionAssetManager();
  const sha = "disk-sha";
  assert.equal(m.hasCachedAnalysis(sha), false);
  m.markAnalyzed(sha);
  assert.equal(m.hasCachedAnalysis(sha), true);

  const dir = mkdtempSync(join(tmpdir(), "vision-cache-"));
  try {
    const m2 = new VisionAssetManager(dir);
    const other = "other-sha";
    assert.equal(m2.hasCachedAnalysis(other), false);
    mkdirSync(m2.cacheDir(other), { recursive: true });
    writeFileSync(m2.analysisJsonPath(other), "{}");
    assert.equal(m2.hasCachedAnalysis(other), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldReanalyze: force, sha change, schema change, cache-hit reuse", () => {
  const m = new VisionAssetManager();
  const schema = "DesignObservation/v1";
  const asset = makeAsset({ assetId: "a", sha256: "s1" });
  m.register(asset);
  m.markAnalyzed("s1", schema);

  // cache-hit reuse: nothing changed
  assert.equal(m.shouldReanalyze(makeAsset({ assetId: "a", sha256: "s1" }), schema), false);

  // force
  assert.equal(m.shouldReanalyze(makeAsset({ assetId: "a", sha256: "s1" }), schema, { force: true }), true);

  // sha change (new content not in cache)
  assert.equal(m.shouldReanalyze(makeAsset({ assetId: "a", sha256: "s2" }), schema), true);

  // schema change
  assert.equal(m.shouldReanalyze(makeAsset({ assetId: "a", sha256: "s1" }), "DesignObservation/v2"), true);

  // never-marked asset needs analysis
  const m2 = new VisionAssetManager();
  m2.register(makeAsset({ assetId: "b", sha256: "s3" }));
  assert.equal(m2.shouldReanalyze(makeAsset({ assetId: "b", sha256: "s3" }), schema), true);
});
