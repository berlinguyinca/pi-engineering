/**
 * Rewriting `models.json`.
 *
 * The file holds the operator's API key, so the failure modes that matter are
 * not "the context window is wrong" but "the credentials are now world-readable"
 * and "an interrupted write left a truncated file where the key used to be".
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ModelsConfig,
  providerBaseUrl,
  providerModels,
  readModelsConfig,
  withProviderModels,
  writeModelsConfig,
} from "../../src/models/modelsConfig.ts";

function scratch(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "models-cfg-"));
  return { dir, path: join(dir, "models.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CONFIG: ModelsConfig = {
  providers: {
    metabolomics: {
      baseUrl: "https://llm.metabolomics.us/v1",
      api: "openai-completions",
      apiKey: "sk-super-secret",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
      models: [{ id: "deepseek-v4-flash", contextWindow: 1_048_576, maxTokens: 32_768 }],
    },
    anthropic: { apiKey: "sk-other", models: [{ id: "claude", contextWindow: 200_000 }] },
  },
  someFutureKey: { pi: "understands this, we do not" },
};

test("models config: an absent or empty file reads as empty, not an error", () => {
  const s = scratch();
  try {
    assert.deepEqual(readModelsConfig(s.path), {});
    writeFileSync(s.path, "   ");
    assert.deepEqual(readModelsConfig(s.path), {});
  } finally {
    s.cleanup();
  }
});

test("models config: malformed JSON is refused rather than overwritten", () => {
  const s = scratch();
  try {
    writeFileSync(s.path, "{not json");
    assert.throws(() => readModelsConfig(s.path));
    // A config this tool cannot parse is a config it must not replace: the file
    // still holds a working API key.
    assert.equal(readFileSync(s.path, "utf8"), "{not json");
  } finally {
    s.cleanup();
  }
});

test("models config: replacing one provider's models touches nothing else", () => {
  const next = withProviderModels(CONFIG, "metabolomics", [{ id: "new-model", contextWindow: 262_144 }]);

  assert.equal(next.providers?.metabolomics?.apiKey, "sk-super-secret", "the key must survive a refresh");
  assert.equal(next.providers?.metabolomics?.baseUrl, "https://llm.metabolomics.us/v1");
  assert.deepEqual(next.providers?.metabolomics?.compat, CONFIG.providers?.metabolomics?.compat);
  assert.deepEqual(next.providers?.anthropic, CONFIG.providers?.anthropic, "a sibling provider is not our business");
  assert.deepEqual(next.someFutureKey, CONFIG.someFutureKey, "unknown top-level keys must be carried through");
  assert.deepEqual(next.providers?.metabolomics?.models, [{ id: "new-model", contextWindow: 262_144 }]);
});

test("models config: the original object is not mutated", () => {
  const before = JSON.stringify(CONFIG);
  withProviderModels(CONFIG, "metabolomics", []);
  assert.equal(JSON.stringify(CONFIG), before);
});

test("models config: a provider absent from the config can still be populated", () => {
  const next = withProviderModels({}, "brand-new", [{ id: "m", contextWindow: 1 }]);
  assert.equal(next.providers?.["brand-new"]?.models?.length, 1);
});

test("models config: a write preserves the file mode", () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(CONFIG), { mode: 0o600 });
    chmodSync(s.path, 0o600);
    writeModelsConfig(s.path, CONFIG);

    const mode = statSync(s.path).mode & 0o777;
    assert.equal(mode, 0o600, `credentials must not be widened by a refresh (got ${mode.toString(8)})`);
  } finally {
    s.cleanup();
  }
});

test("models config: a write leaves a restorable backup", () => {
  const s = scratch();
  try {
    writeFileSync(s.path, JSON.stringify(CONFIG), { mode: 0o600 });
    const result = writeModelsConfig(
      s.path,
      withProviderModels(CONFIG, "metabolomics", []),
      new Date("2026-09-15T18:30:00Z"),
    );

    assert.ok(result.backupPath);
    assert.ok(existsSync(result.backupPath));
    assert.deepEqual(JSON.parse(readFileSync(result.backupPath, "utf8")), CONFIG, "the backup is the pre-write state");
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o600, "the backup holds the key too");
  } finally {
    s.cleanup();
  }
});

test("models config: a first write needs no backup", () => {
  const s = scratch();
  try {
    const result = writeModelsConfig(s.path, CONFIG);
    assert.equal(result.backupPath, undefined);
    assert.deepEqual(readModelsConfig(s.path), CONFIG);
  } finally {
    s.cleanup();
  }
});

test("models config: no temporary file survives a write", () => {
  const s = scratch();
  try {
    writeModelsConfig(s.path, CONFIG);
    const strays = readdirSync(s.dir).filter((f) => f.includes("tmp"));
    assert.deepEqual(strays, [], "an atomic write must not leave its scratch file behind");
  } finally {
    s.cleanup();
  }
});

test("models config: accessors tolerate a config with nothing in it", () => {
  assert.deepEqual(providerModels({}, "metabolomics"), []);
  assert.deepEqual(providerModels({ providers: { metabolomics: {} } }, "metabolomics"), []);
  assert.equal(providerBaseUrl({}, "metabolomics"), undefined);
  assert.equal(providerBaseUrl(CONFIG, "metabolomics"), "https://llm.metabolomics.us/v1");
});

test("models config: a round trip through disk preserves the key and the models", () => {
  const s = scratch();
  try {
    writeModelsConfig(s.path, CONFIG);
    const back = readModelsConfig(s.path);
    assert.deepEqual(back, CONFIG);
  } finally {
    s.cleanup();
  }
});
