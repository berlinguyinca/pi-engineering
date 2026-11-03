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
  assert.equal(aliasForPin("qwen3.8-27b-modality-vision-quant-q8_k_xl", metabolomics), "qwen3.8-27b-vision");
  assert.equal(aliasForPin("qwen3.8-27b-modality-text-ctx-c128k-quant-q4_k_m", development), "qwen3.8-27b-text");
  // No flash text alias is served, so the pin widens to the flash size.
  assert.equal(aliasForPin("qwen3.8-flash-modality-text-quant-iq4_xs", metabolomics), "qwen3.8-flash");
  // A hand-written short name whose size is two words.
  assert.equal(aliasForPin("qwen3.8-flash-next", metabolomics), "qwen3.8-flash_next");
  assert.equal(aliasForPin("unrelated-model-x", metabolomics), undefined);
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
  // The only alias that could take it is the family, and `development`'s family
  // alias covers 27B and text builds — moving a flash_next pin there would put a
  // different model behind a name chosen for quality, so it is refused and
  // reported rather than silently widened.
  assert.match(plan.text, /reviewer:\n {6}model: development\/qwen3\.8-flash_next-modality-vision-quant-mxfp4_fp8_gptq\n/);
  const reviewer = plan.unresolved.find((u) => u.id.startsWith("qwen3.8-flash_next"));
  assert.ok(reviewer, "the flash_next pin is reported as not moved");
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

// The gateway answers an alias with its `x_members`, so membership decides what a
// move would really run: a 27B pin must not land behind a name that answers Flash.
const Q27B = "qwen3.8-27b-modality-vision-quant-q8_k_xl";
const FLASH_V = "qwen3.8-flash-modality-vision-quant-iq4_xs";
const NEXT_W3 = "qwen3.8-flash_next-modality-text-quant-w3a8";

test("a pin moves only onto an alias that answers as the model it named", () => {
  const withMembers: PinCatalog = {
    aliasOnly: true,
    ids: new Set(["qwen3.8", "qwen3.8-27b", "qwen3.8-27b-vision", "qwen3.8-vision"]),
    members: {
      "qwen3.8-27b-vision": [Q27B],
      // Failover between classes: the name says nothing about which answers.
      "qwen3.8-vision": [Q27B, FLASH_V],
      "qwen3.8-27b": [Q27B],
      "qwen3.8": [Q27B, FLASH_V, NEXT_W3],
    },
  };
  // Exact membership wins, and it is the most specific covering alias anyway.
  assert.equal(aliasForPin(Q27B, withMembers), "qwen3.8-27b-vision");

  // When nothing of its own class is served, the pin is NOT widened to a family
  // alias whose members include Flash: the report says why instead.
  const onlyFamily: PinCatalog = {
    aliasOnly: true,
    ids: new Set(["qwen3.8"]),
    members: { "qwen3.8": [FLASH_V, NEXT_W3] },
  };
  assert.equal(aliasForPin(Q27B, onlyFamily), undefined);
  const { changes, unresolved } = planPinMigration(`pin: metabolomics/${Q27B}\n`, new Map([["metabolomics", onlyFamily]]));
  assert.equal(changes.length, 0);
  assert.equal(unresolved[0]!.id, Q27B);
  assert.match(unresolved[0]!.blocked!.because, /its members are flash, flash_next, not 27b/);

  // A member list of one class covers, even across two quants of that class.
  const oneClass: PinCatalog = {
    aliasOnly: true,
    ids: new Set(["qwen3.8-text"]),
    members: { "qwen3.8-text": [NEXT_W3, "qwen3.8-flash_next-modality-text-quant-q4_k_xl"] },
  };
  assert.equal(aliasForPin(NEXT_W3, oneClass), "qwen3.8-text");
});

test("without published members, the alias name must still carry the class", () => {
  // Same ids, no `x_members`: `qwen3.8` would silently widen a 27B pin to Flash,
  // so it is refused and reported; `qwen3.8-27b` says 27b and is accepted.
  assert.equal(aliasForPin(Q27B, { aliasOnly: true, ids: new Set(["qwen3.8"]) }), undefined);
  assert.equal(aliasForPin(Q27B, { aliasOnly: true, ids: new Set(["qwen3.8-27b"]) }), "qwen3.8-27b");
  // An id that names no class has nothing to preserve.
  assert.equal(aliasForPin("qwen3.8-flash-next", { aliasOnly: true, ids: new Set(["qwen3.8"]) }), "qwen3.8");
});

test("an operator alias that shares no name with the id still takes the pin", () => {
  // `qwen3.8-text` routes to a `-vision-`-shaped build and `laya` to
  // `laya-typed-decisions-…`: no derivable name reaches them, but the gateway's
  // membership says they answer, so they are where a stale pin belongs.
  const served: PinCatalog = {
    aliasOnly: true,
    ids: new Set(["qwen3.8-text", "laya", "laya-text"]),
    members: {
      "qwen3.8-text": [NEXT_W3],
      laya: ["laya-typed-decisions-modality-text-quant-fp16"],
      "laya-text": ["laya-typed-decisions-modality-text-quant-fp16"],
    },
  };
  assert.equal(aliasForPin(NEXT_W3, served), "qwen3.8-text");
  // Among aliases that all resolve to it, the most specific name wins.
  assert.equal(
    aliasForPin("laya-typed-decisions-modality-text-quant-fp16", served),
    "laya-text",
  );
});
