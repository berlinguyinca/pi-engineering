/**
 * APS Phase 1 — fingerprint stability under cosmetic churn, divergence on
 * real change, and strategy-family normalization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ToolCallNormalizer,
  canonicalJson,
  fnv1a64,
  normalizePathLike,
  semanticFingerprint,
} from "../../src/aps/fingerprint.ts";
import type { SemanticStrategyFamily } from "../../src/aps/types.ts";

const ROOT = "/home/u/proj";
const normalizer = new ToolCallNormalizer({ rootPrefix: ROOT });

function fp(tool: string, args: Record<string, unknown>, result = "ok"): string {
  const norm = normalizer.normalize({ name: tool, arguments: args });
  return semanticFingerprint({ tool, normalizedArguments: norm.arguments, toolResultSummary: result }, normalizer);
}

test("fingerprint is stable under cosmetic churn: absolute path prefixes", () => {
  const a = fp("read_file", { path: `${ROOT}/src/x.ts` }, "v1");
  const b = fp("read_file", { path: "src/x.ts" }, "v1");
  const c = fp("read_file", { path: `${ROOT}//src/x.ts` }, "v1");
  const d = fp("read_file", { path: `${ROOT}/src/./x.ts` }, "v1");
  const e = fp("read_file", { path: "src\\x.ts" }, "v1");
  assert.equal(a, b, "rootPrefix must be stripped");
  assert.equal(a, c, "duplicate slashes must be canonicalized");
  assert.equal(a, d, "dot segments must be canonicalized");
  assert.equal(a, e, "backslash paths must be canonicalized");
});

test("fingerprint is stable under cosmetic churn: whitespace and key order", () => {
  const a = fp("bash", { command: "npm  test   --watch" });
  const b = fp("bash", { command: "npm test --watch" });
  assert.equal(a, b, "whitespace runs in commands must not change the fingerprint");

  const c = fp("repo_search", { query: "fix   the   bug", limit: 5 });
  const d = fp("repo_search", { query: "fix the bug", limit: 5 });
  assert.equal(c, d, "whitespace in queries must not change the fingerprint");

  const e = fp("edit_file", { path: "src/x.ts", patch: "a = 1" });
  const g = fp("edit_file", { patch: "a = 1", path: "src/x.ts" });
  assert.equal(e, g, "argument key order must not change the fingerprint");
});

test("fingerprint is stable under cosmetic churn: timestamps and formatting-only churn", () => {
  const a = fp("ledger_claim", { claim: "x", timestamp: "2026-01-01T00:00:00Z", ts: 111 });
  const b = fp("ledger_claim", { claim: "x", timestamp: "2026-06-30T23:59:59Z", ts: 999 });
  assert.equal(a, b, "volatile timestamp arguments must be stripped");

  const c = fp("edit_file", { path: "src/x.ts", patch: "const x = 1;\n\n  " });
  const d = fp("edit_file", { path: "src/x.ts", patch: "const x = 1;" });
  assert.equal(c, d, "formatting-only whitespace churn must not change the fingerprint");
});

test("fingerprint diverges on real input change", () => {
  const base = fp("repo_search", { query: "foo" });
  assert.notEqual(base, fp("repo_search", { query: "bar" }), "different query");
  assert.notEqual(base, fp("repo_search", { query: "foo", limit: 3 }), "different arguments");
  assert.notEqual(fp("read_file", { path: "src/x.ts" }), fp("read_file", { path: "src/y.ts" }), "different file");
  assert.notEqual(
    fp("read_file", { path: "src/x.ts" }),
    fp("repo_search", { query: "src/x.ts" }),
    "different strategy family",
  );
  assert.notEqual(
    fp("edit_file", { path: "src/x.ts", patch: "a = 1" }),
    fp("edit_file", { path: "src/x.ts", patch: "a = 2" }),
    "different edit content",
  );
});

test("fingerprint diverges when observed state changes (result summary differs)", () => {
  const before = fp("read_file", { path: "src/x.ts" }, "content v1");
  const after = fp("read_file", { path: "src/x.ts" }, "content v2");
  assert.notEqual(before, after, "same intent+target but changed state must diverge");
  const sameState = fp("read_file", { path: "src/x.ts" }, "content v1");
  assert.equal(before, sameState, "unchanged state must stay identical");
});

test("fingerprint is stable when fed pre-normalized arguments (idempotence)", () => {
  const norm = normalizer.normalize({ name: "read_file", arguments: { path: `${ROOT}/src/x.ts` } });
  const viaRaw = fp("read_file", { path: `${ROOT}/src/x.ts` });
  const viaPreNormalized = semanticFingerprint(
    { tool: "read_file", normalizedArguments: norm.arguments, toolResultSummary: "ok" },
    normalizer,
  );
  assert.equal(viaRaw, viaPreNormalized);
});

test("normalizePathLike handles prefixes, homes, and URIs", () => {
  assert.equal(normalizePathLike(`${ROOT}/a/b.ts`, ROOT), "a/b.ts");
  assert.equal(normalizePathLike(ROOT, ROOT), ".");
  assert.equal(normalizePathLike("/a/b.ts"), "a/b.ts");
  assert.equal(normalizePathLike("~/a/b.ts"), "a/b.ts");
  assert.equal(normalizePathLike("./a/b.ts"), "a/b.ts");
  assert.equal(normalizePathLike("a//b.ts/"), "a/b.ts");
  assert.equal(normalizePathLike("artifact://runs/1/x", ROOT), "artifact://runs/1/x");
  assert.equal(normalizePathLike("  /a/ b.ts  ".replace(" ", ""), ROOT), "a/b.ts");
});

test("canonicalJson is order-independent and fnv1a64 is deterministic", () => {
  assert.equal(canonicalJson({ a: 1, b: [3, 2] }), canonicalJson({ b: [3, 2], a: 1 }));
  assert.equal(fnv1a64("same"), fnv1a64("same"));
  assert.notEqual(fnv1a64("same"), fnv1a64("different"));
  assert.match(fnv1a64("x"), /^[0-9a-f]{16}$/);
});

const FAMILY_CASES: Array<[string, Record<string, unknown>, SemanticStrategyFamily, string]> = [
  ["repo_search", { query: "foo" }, "SEARCH_TEXT", "foo"],
  ["search_symbols", { symbol: "Foo" }, "SEARCH_SYMBOL", "Foo"],
  ["search_files", { pattern: "*.ts" }, "SEARCH_FILE", "*.ts"],
  ["tests_for", { symbols: ["A", "B"] }, "SEARCH_FILE", "A,B"],
  ["read_file", { path: "src/x.ts" }, "READ_FILE", "src/x.ts"],
  ["ls", { dir: "src" }, "READ_DIRECTORY", "src"],
  ["list_dir", { dir: "src" }, "READ_DIRECTORY", "src"],
  ["run_test", { command: "npm test" }, "RUN_TEST", "npm test"],
  ["build", { command: "npm run build" }, "RUN_BUILD", "npm run build"],
  ["edit_file", { path: "src/x.ts", patch: "p" }, "EDIT_FILE", "src/x.ts"],
  ["edit_file", { path: "src/x.test.ts", patch: "p" }, "MODIFY_TEST", "src/x.test.ts"],
  ["edit_file", { path: "test/util.ts", patch: "p" }, "MODIFY_TEST", "test/util.ts"],
  ["edit_file", { path: "package.json", patch: "p" }, "MODIFY_CONFIG", "package.json"],
  ["edit_file", { path: "tsconfig.json", patch: "p" }, "MODIFY_CONFIG", "tsconfig.json"],
  ["run_format", { command: "biome format --write" }, "RUN_FORMAT", "biome format --write"],
  ["typecheck", { command: "tsc --noEmit" }, "RUN_TYPECHECK", "tsc --noEmit"],
  ["bash", { command: "git status" }, "RUN_COMMAND", "git status"],
  ["artifact_read", { uri: "artifact://runs/1/x" }, "INSPECT_ARTIFACT", "artifact://runs/1/x"],
  ["ask_user", { question: "which approach?" }, "ASK_USER", "which approach?"],
  ["update_plan", { note: "step 1" }, "UPDATE_PLAN", ""],
  ["generate_text", { text: "hello" }, "GENERATE_TEXT", ""],
  ["frobnicate", { amount: 3 }, "CALL_TOOL", "frobnicate"],
];

test("ToolCallNormalizer maps tool names to canonical strategy families", () => {
  for (const [tool, args, family, target] of FAMILY_CASES) {
    const call = normalizer.normalize({ name: tool, arguments: args });
    assert.equal(call.family, family, `${tool} -> ${call.family}`);
    assert.equal(call.target, target, `${tool} target`);
  }
});

test("ToolCallNormalizer honors explicit toolFamilyMap overrides", () => {
  const custom = new ToolCallNormalizer({ toolFamilyMap: { frobnicate: "RUN_BUILD" } });
  assert.equal(custom.familyFor("FROBNICATE"), "RUN_BUILD", "override must be case-insensitive");
});
