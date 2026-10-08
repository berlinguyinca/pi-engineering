/**
 * The package's declared Pi compatibility (package.json `piEngineering`):
 * Pi core 1.x is supported, and the range is enforced at both ends.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCandidateMetadata, piCompatible } from "../../src/update/metadata.ts";

const metadata = parseCandidateMetadata(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  "src/runtime/host/runtimeEntry.ts",
);

test("package.json declares Pi 0.87.0 up to any 1.x", () => {
  assert.equal(metadata.minimumPiVersion, "0.87.0");
  assert.equal(metadata.maximumPiVersion, "1.x");
});

test("piCompatible with this package's metadata: accepts 0.87.1 and 1.0.0, rejects 2.0.0 and 0.86.0", () => {
  const check = (pi: string) => piCompatible(pi, metadata.minimumPiVersion, metadata.maximumPiVersion);
  assert.deepEqual(check("0.87.1"), { ok: true });
  assert.deepEqual(check("1.0.0"), { ok: true });
  assert.deepEqual(check("1.9.3"), { ok: true });
  assert.equal(check("2.0.0").ok, false);
  assert.equal(check("0.86.0").ok, false);
});
