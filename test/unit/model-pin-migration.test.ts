/**
 * Pins to concrete model ids must follow the catalogue onto aliases.
 *
 * Refresh configures aliases only. A pin in Pi's settings or in
 * `engineering.yaml` that still names a concrete id would dangle, so refresh
 * rewrites it to the most specific alias that still covers it, keeping the
 * file's comments and layout, and backs the file up first.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type PinCatalog,
  aliasForPin,
  migrateConfiguredPins,
  planPinMigration,
} from "../../src/models/pinMigration.ts";

const metabolomics: PinCatalog = {
  aliasOnly: true,
  ids: new Set([
    "qwen3.8",
    "qwen3.8-27b",
    "qwen3.8-27b-vision",
    "qwen3.8-flash",
    "qwen3.8-flash-vision",
    "qwen3.8-flash_next",
    "qwen3.8-text",
    "qwen3.8-vision",
  ]),
};
const development: PinCatalog = {
  aliasOnly: true,
  ids: new Set(["qwen3.8", "qwen3.8-27b", "qwen3.8-27b-text", "qwen3.8-text"]),
};
const providers = new Map([
  ["metabolomics", metabolomics],
  ["development", development],
]);

const SETTINGS = `{
  "defaultModel": "qwen3.8-flash-next",
  "defaultProvider": "metabolomics",
  "enabledModels": [
    "metabolomics/*",
    "development/qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m",
    "metabolomics/qwen3.8-27b-modality-vision-quant-q8_k_xl"
  ]
}
`;

const POLICY = `# Planning and implementation use the 27B text model.
routing:
  mode: auto
  roles:
    planner:
      model: development/qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m
      timeout_ms: 1200000
    reviewer:
      model: development/qwen3.8-flash_next-modality-vision-quant-mxfp4_fp8_gptq
`;

test("the most specific covering alias is chosen", () => {
  assert.equal(aliasForPin("qwen3.8-27b-modality-vision-quant-q8_k_xl", metabolomics.ids), "qwen3.8-27b-vision");
  assert.equal(aliasForPin("qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m", development.ids), "qwen3.8-27b-text");
  // No flash text alias is served, so the pin widens to the flash size.
  assert.equal(aliasForPin("qwen3.8-flash-modality-text-quant-iq4_xs", metabolomics.ids), "qwen3.8-flash");
  // A hand-written short name whose size is two words.
  assert.equal(aliasForPin("qwen3.8-flash-next", metabolomics.ids), "qwen3.8-flash_next");
  assert.equal(aliasForPin("unrelated-model-x", metabolomics.ids), undefined);
});

test("settings: stale pins move, the glob and the layout stay", () => {
  const plan = planPinMigration(SETTINGS, providers);
  assert.match(plan.text, /"metabolomics\/\*"/);
  assert.match(plan.text, /"metabolomics\/qwen3\.8-27b-vision"/);
  assert.match(plan.text, /"development\/qwen3\.8-27b-text"/);
  assert.match(plan.text, /"defaultModel": "qwen3\.8-flash_next"/);
  assert.doesNotThrow(() => JSON.parse(plan.text));
  assert.equal(plan.unresolved.length, 0);
});

test("policy: role pins move and the comments survive", () => {
  const plan = planPinMigration(POLICY, providers);
  assert.match(plan.text, /^# Planning and implementation use the 27B text model\./);
  assert.match(plan.text, /planner:\n {6}model: development\/qwen3\.8-27b-text\n {6}timeout_ms: 1200000/);
  // No served alias covers this id except the family, which is the widest fallback.
  assert.match(plan.text, /reviewer:\n {6}model: development\/qwen3\.8\n/);
});

test("pins are untouched when valid, unresolved, or the provider is not alias-only", () => {
  const valid = planPinMigration("model: metabolomics/qwen3.8-text\n", providers);
  assert.equal(valid.changes.length, 0);
  const none = planPinMigration("model: metabolomics/other-family-modality-text-quant-q4\n", providers);
  assert.deepEqual(none.unresolved, [{ provider: "metabolomics", id: "other-family-modality-text-quant-q4" }]);
  assert.match(none.text, /other-family-modality-text-quant-q4/);
  const concrete = planPinMigration(
    "model: metabolomics/qwen3.8-27b-modality-vision-quant-q8_k_xl\n",
    new Map([["metabolomics", { ...metabolomics, aliasOnly: false }]]),
  );
  assert.equal(concrete.changes.length, 0);
});

test("a second pass changes nothing", () => {
  const once = planPinMigration(SETTINGS, providers).text;
  assert.equal(planPinMigration(once, providers).changes.length, 0);
});

test("files are backed up first, modes kept, and a dry run writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-pins-"));
  const settings = join(dir, "settings.json");
  const policy = join(dir, "engineering.yaml");
  writeFileSync(settings, SETTINGS, { mode: 0o600 });
  writeFileSync(policy, POLICY);
  const now = () => new Date("2026-11-02T18:00:00Z");

  const dry = migrateConfiguredPins({ agentDir: dir, providers, dryRun: true, now });
  assert.equal(dry.written, false);
  assert.equal(readFileSync(settings, "utf8"), SETTINGS);

  const real = migrateConfiguredPins({ agentDir: dir, providers, now });
  assert.equal(real.written, true);
  assert.equal(readFileSync(`${settings}.bak-20261102T180000Z-model-refresh`, "utf8"), SETTINGS);
  assert.equal(readFileSync(`${policy}.bak-20261102T180000Z-model-refresh`, "utf8"), POLICY);
  assert.equal(statSync(settings).mode & 0o777, 0o600);
  assert.match(readFileSync(settings, "utf8"), /qwen3\.8-27b-vision/);

  const again = migrateConfiguredPins({ agentDir: dir, providers, now });
  assert.equal(again.written, false);
  assert.ok(existsSync(settings));
});
