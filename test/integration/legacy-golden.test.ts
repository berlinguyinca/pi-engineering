/**
 * Parity gate over the legacy implementation (OMP unification, Phase 3).
 *
 * Each scenario in `scenarios` is rendered through `legacyPath` and compared
 * byte for byte with test/fixtures/legacy-golden/<command>-<scenario>.golden.json.
 * UPDATE_GOLDEN=1 rewrites the files; commit that diff on purpose.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { goldenName, legacyPath, renderScenario, scenarios } from "../support/legacyGolden.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "legacy-golden");

describe("legacy golden outputs (parity gate, legacy path)", () => {
  for (const s of scenarios) {
    it(`${s.command} / ${s.scenario}`, async () => {
      const actual = await renderScenario(s, legacyPath);
      const file = join(DIR, goldenName(s));
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, actual);
        return;
      }
      assert.equal(
        actual,
        readFileSync(file, "utf8"),
        `${goldenName(s)} drifted; rerun with UPDATE_GOLDEN=1 if intended`,
      );
    });
  }

  it("has a unique golden file per scenario", () => {
    const names = scenarios.map(goldenName);
    assert.equal(new Set(names).size, names.length);
  });
});
