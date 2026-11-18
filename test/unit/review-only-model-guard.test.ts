/**
 * Review-only model guard (#727).
 *
 * Mission work is routed by role and reviewers are read-only, but an
 * interactive or handoff-resumed session runs on whatever the harness pinned
 * in `/model`, and nothing reconciled that pin against "may this model
 * mutate". Observed: a session pinned to a review-only Opus was handed off,
 * resumed, IMPLEMENTED and MERGED (#725, squash 599c06d0). Operator policy is
 * that model is review-only; nothing stopped it.
 *
 * The guard mirrors `primaryWorktreeGuard.ts`: it sits on the session's
 * `tool_call` hook and blocks the session's own MUTATING calls — `write` /
 * `edit`, mutating git verbs, bash writes, and `gh pr merge` — while leaving
 * read-only inspection, tests/CI and the review tools alone. It is opt-in
 * (`models.review_only`, default empty = inert) with an env override and a
 * kill switch, so it cannot strand existing sessions.
 *
 * The model it judges comes from the tool_call context's live `ctx.model`
 * (pi resolves it at call time); `PI_MODEL`/`PI_PROVIDER` are the fallback for
 * processes pi spawned with those variables in their environment, because pi
 * sets them only on a bash child's env, not on its own `process.env`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type ModelRef,
  ReviewOnlyModelGuard,
  type ReviewOnlyModelGuardHost,
  type ReviewOnlyVerdict,
  activeModelFromEnv,
  isReviewOnlyModel,
  loadReviewOnlyModelConfig,
  registerReviewOnlyModelGuard,
  resolveReviewOnlyModelGuardConfig,
} from "../../src/guard/reviewOnlyModelGuard.ts";

// ── config resolution ────────────────────────────────────────────────────────

test("review-only config: opt-in — enabled but with no list, so inert by default", () => {
  assert.deepEqual(resolveReviewOnlyModelGuardConfig({}), { enabled: true, reviewOnly: [] });
});

test("review-only config: PI_ENG_REVIEW_ONLY_GUARD=0 is the kill switch", () => {
  for (const off of ["0", "false", "off", "no"]) {
    const cfg = resolveReviewOnlyModelGuardConfig({ PI_ENG_REVIEW_ONLY_GUARD: off }, ["anthropic/x"]);
    assert.equal(cfg.enabled, false, off);
  }
  assert.equal(resolveReviewOnlyModelGuardConfig({ PI_ENG_REVIEW_ONLY_GUARD: "1" }, ["anthropic/x"]).enabled, true);
});

test("review-only config: PI_ENG_REVIEW_ONLY_MODELS is a comma-separated list", () => {
  const cfg = resolveReviewOnlyModelGuardConfig({
    PI_ENG_REVIEW_ONLY_MODELS:
      " anthropic/claude-opus-4-8 , paiton-local/Qwen3.8-Flash-Next ,, anthropic/claude-opus-4-8 ",
  });
  assert.deepEqual(cfg.reviewOnly, ["anthropic/claude-opus-4-8", "paiton-local/Qwen3.8-Flash-Next"]);
  assert.deepEqual(resolveReviewOnlyModelGuardConfig({ PI_ENG_REVIEW_ONLY_MODELS: "  , ,, " }).reviewOnly, []);
});

test("review-only config: the env override replaces the engineering.yaml list", () => {
  assert.deepEqual(resolveReviewOnlyModelGuardConfig({ PI_ENG_REVIEW_ONLY_MODELS: "a/b" }, ["c/d", "e/f"]).reviewOnly, [
    "a/b",
  ]);
  assert.deepEqual(resolveReviewOnlyModelGuardConfig({}, ["c/d", "c/d", " e/f "]).reviewOnly, ["c/d", "e/f"]);
});

// ── engineering.yaml `models:` block ─────────────────────────────────────────

const dirWith = (yaml?: string) => {
  const d = mkdtempSync(join(tmpdir(), "review-only-cfg-"));
  if (yaml !== undefined) writeFileSync(join(d, "engineering.yaml"), yaml);
  return d;
};

test("review-only config: models.review_only is read from engineering.yaml", async () => {
  const { config, notes } = await loadReviewOnlyModelConfig(
    dirWith("models:\n  review_only:\n    - anthropic/claude-opus-4-8\n    - claude-fable-5\n"),
    {},
  );
  assert.deepEqual(config.reviewOnly, ["anthropic/claude-opus-4-8", "claude-fable-5"]);
  assert.deepEqual(notes, []);
});

test("review-only config: no block, no file, or an empty list leaves the guard inert with no note", async () => {
  for (const yaml of [undefined, "foo: 1\n", "models:\n", "models:\n  review_only: []\n"]) {
    const r = await loadReviewOnlyModelConfig(dirWith(yaml), {});
    assert.deepEqual(r.config, { enabled: true, reviewOnly: [] }, String(yaml));
    assert.deepEqual(r.notes, [], String(yaml));
  }
});

test("review-only config: a malformed block turns the guard off with a note, never half-applied", async () => {
  for (const yaml of [
    // A scalar where a list was asked for.
    'models:\n  review_only: "anthropic/claude-opus-4-8"\n',
    // A non-string entry.
    "models:\n  review_only: [42]\n",
    // A blank entry.
    'models:\n  review_only: [""]\n',
    // Something that is not a model id.
    'models:\n  review_only: ["anthropic/x; rm -rf /"]\n',
    // A key this loader does not own: refuse rather than guess.
    "models:\n  review_only: [anthropic/x]\n  review_only_model: anthropic/x\n",
    // The block itself is not a mapping.
    "models: [anthropic/x]\n",
  ]) {
    const { config, notes } = await loadReviewOnlyModelConfig(dirWith(yaml), {});
    assert.deepEqual(config.reviewOnly, [], yaml);
    assert.equal(notes.length, 1, yaml);
    assert.match(notes[0] ?? "", /models/iu, yaml);
  }
});

test("review-only config: an unreadable engineering.yaml is a note, not a crash", async () => {
  const d = mkdtempSync(join(tmpdir(), "review-only-cfg-"));
  writeFileSync(join(d, "engineering.yaml"), "models:\n  review_only: [a\n   b: ]]\n");
  const { config, notes } = await loadReviewOnlyModelConfig(d, {});
  assert.deepEqual(config.reviewOnly, []);
  assert.equal(notes.length, 1);
});

// ── model matching ───────────────────────────────────────────────────────────

test("isReviewOnlyModel: provider/id matches exactly, a bare id matches any provider", () => {
  const anthropic: ModelRef = { provider: "anthropic", id: "claude-opus-4-8" };
  assert.equal(isReviewOnlyModel(anthropic, ["anthropic/claude-opus-4-8"]), true);
  assert.equal(isReviewOnlyModel(anthropic, ["claude-opus-4-8"]), true);
  // A provider-qualified entry does not match the same id behind another provider.
  assert.equal(isReviewOnlyModel({ provider: "openai", id: "claude-opus-4-8" }, ["anthropic/claude-opus-4-8"]), false);
  assert.equal(isReviewOnlyModel(anthropic, ["anthropic/claude-fable-5"]), false);
  assert.equal(isReviewOnlyModel(anthropic, []), false);
  assert.equal(isReviewOnlyModel(undefined, ["claude-opus-4-8"]), false);
  // Ids are compared as written: `Qwen3.8` and `qwen3.8` are different models.
  assert.equal(
    isReviewOnlyModel({ provider: "paiton-local", id: "Qwen3.8-Flash-Next" }, ["paiton-local/qwen3.8"]),
    false,
  );
});

test("activeModelFromEnv: PI_MODEL may already carry its provider", () => {
  assert.deepEqual(activeModelFromEnv({ PI_PROVIDER: "paiton-local", PI_MODEL: "Qwen3.8-Flash-Next" }), {
    provider: "paiton-local",
    id: "Qwen3.8-Flash-Next",
  });
  assert.deepEqual(activeModelFromEnv({ PI_MODEL: "paiton-local/Qwen3.8-Flash-Next" }), {
    provider: "paiton-local",
    id: "Qwen3.8-Flash-Next",
  });
  assert.deepEqual(activeModelFromEnv({ PI_MODEL: "claude-opus-4-8" }), { id: "claude-opus-4-8" });
  assert.equal(activeModelFromEnv({}), undefined);
  assert.equal(activeModelFromEnv({ PI_MODEL: "   " }), undefined);
  // A provider without a model is not a model.
  assert.equal(activeModelFromEnv({ PI_PROVIDER: "anthropic" }), undefined);
});

// ── guard verdicts ───────────────────────────────────────────────────────────

const REVIEW_ONLY = ["anthropic/claude-opus-4-8"];
const opus: ModelRef = { provider: "anthropic", id: "claude-opus-4-8" };

function guard(reviewOnly = REVIEW_ONLY, env: NodeJS.ProcessEnv = {}) {
  return new ReviewOnlyModelGuard(resolveReviewOnlyModelGuardConfig(env, reviewOnly), { env });
}

test("guard: a review-only model's writes and edits are blocked with the way out named", () => {
  const guard_ = guard();
  const blocked = guard_.onToolCall("write", { path: "src/a.ts", content: "x" }, opus);
  assert.equal(blocked?.block, true);
  const reason = blocked?.reason ?? "";
  assert.match(reason, /anthropic\/claude-opus-4-8/u);
  assert.match(reason, /review-only/iu);
  assert.match(reason, /\/model/u);
  assert.match(reason, /models\.review_only/u);
  assert.match(reason, /PI_ENG_REVIEW_ONLY_GUARD=0/u);
  assert.equal(guard_.onToolCall("edit", { path: "src/a.ts", edits: [] }, opus)?.block, true);
});

test("guard: mutating git and bash writes are blocked; the culprit segment is named", () => {
  const guard_ = guard();
  for (const command of [
    "git commit -m x",
    "git add -A",
    "git push -u origin fix/x",
    "git checkout -b feat/x",
    "git reset --hard HEAD~1",
    "git -C /repo branch feat/y",
    "cd /wt && git add -A && git commit -m x",
    "echo x >> NOTES.md",
    "sed -i 's/a/b/' src/a.ts",
    "cp a.ts b.ts",
  ]) {
    const blocked = guard_.onToolCall("bash", { command }, opus);
    assert.equal(blocked?.block, true, command);
  }
  const compound = guard_.onToolCall("bash", { command: "cd /wt && git add -A && git commit -m x" }, opus);
  assert.match(compound?.reason ?? "", /git add/u);
});

test("guard: `gh pr merge` is blocked — the step that shipped the incident — but prose is not", () => {
  const guard_ = guard();
  for (const command of ["gh pr merge 727 --squash --admin", "cd /wt && gh pr merge --squash"]) {
    assert.equal(guard_.onToolCall("bash", { command }, opus)?.block, true, command);
  }
  // Quoting is data, not a command: neither of these merges anything.
  for (const command of ['echo "then gh pr merge --squash"', "grep -rn 'gh pr merge' docs/"]) {
    assert.equal(guard_.onToolCall("bash", { command }, opus), undefined, command);
  }
});

test("guard: read-only tools, git inspection, tests and the review tools stay allowed", () => {
  const guard_ = guard();
  for (const [toolName, input] of [
    ["read", { path: "src/a.ts" }],
    ["symbol", { path: "src/a.ts" }],
    ["repo_search", { query: "guard" }],
    ["ledger_read", {}],
  ] as const) {
    assert.equal(guard_.onToolCall(toolName, input, opus), undefined, toolName);
  }
  for (const command of [
    "git status --porcelain",
    "git log --oneline -5",
    "git fetch origin",
    "git diff origin/main",
    "git worktree list --porcelain",
    "git worktree add ../wt -b fix/x origin/main",
    "npm run test:unit",
    "npx tsc --noEmit -p tsconfig.json",
    "npx biome check src",
    "gh pr view 727",
    "gh pr checks 727",
    "gh pr review 727 --approve --body lgtm",
    "gh issue view 727",
    "cat src/a.ts | head -5",
  ]) {
    assert.equal(guard_.onToolCall("bash", { command }, opus), undefined, command);
  }
});

test("guard: a model that is not review-only is unaffected", () => {
  const guard_ = guard();
  const fable: ModelRef = { provider: "anthropic", id: "claude-fable-5" };
  assert.equal(guard_.onToolCall("write", { path: "src/a.ts", content: "x" }, fable), undefined);
  assert.equal(guard_.onToolCall("edit", { path: "src/a.ts", edits: [] }, fable), undefined);
  assert.equal(guard_.onToolCall("bash", { command: "git commit -m x" }, fable), undefined);
  assert.equal(guard_.onToolCall("bash", { command: "gh pr merge --squash" }, fable), undefined);
});

test("guard: disabled by the kill switch, by an empty list, and by having no model to judge", () => {
  // Kill switch.
  assert.equal(
    guard(REVIEW_ONLY, { PI_ENG_REVIEW_ONLY_GUARD: "0" }).onToolCall("write", { path: "a" }, opus),
    undefined,
  );
  // Default configuration (no list): the guard is inert whatever the model is.
  assert.equal(resolveReviewOnlyModelGuardConfig({}).reviewOnly.length, 0);
  assert.equal(guard([]).onToolCall("write", { path: "a" }, opus), undefined);
  // Nothing to judge: pi gave no model and the process has no PI_MODEL.
  assert.equal(guard(REVIEW_ONLY).onToolCall("write", { path: "a" }, undefined), undefined);
});

test("guard: PI_MODEL/PI_PROVIDER are the fallback when the call carries no model", () => {
  // pi sets these on a bash child's env, so a runtime it spawned carries them
  // while its own process.env does not.
  const env: NodeJS.ProcessEnv = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-4-8" };
  const guard_ = new ReviewOnlyModelGuard(resolveReviewOnlyModelGuardConfig(env, REVIEW_ONLY), { env });
  assert.equal(guard_.onToolCall("write", { path: "a" })?.block, true);
  // An explicit model wins over the inherited environment.
  assert.equal(guard_.onToolCall("write", { path: "a" }, { provider: "anthropic", id: "claude-fable-5" }), undefined);
});

test("guard: a config that lands late (async YAML read) takes effect on the next call", () => {
  let config = resolveReviewOnlyModelGuardConfig({});
  const guard_ = new ReviewOnlyModelGuard(() => config, {});
  assert.equal(guard_.onToolCall("write", { path: "a" }, opus), undefined);
  config = resolveReviewOnlyModelGuardConfig({}, REVIEW_ONLY);
  assert.equal(guard_.onToolCall("write", { path: "a" }, opus)?.block, true);
});

// ── hook registration ────────────────────────────────────────────────────────

/** A host whose only capability is the hook this guard attaches to. */
type CallHandler = (
  event: { toolName: string; input: unknown },
  ctx?: { model?: ModelRef },
) => Promise<ReviewOnlyVerdict | undefined>;

function host(): { on: ReviewOnlyModelGuardHost["on"]; handlers: Map<string, CallHandler> } {
  const handlers = new Map<string, CallHandler>();
  return { on: (event, handler) => void handlers.set(event, handler), handlers };
}

test("register: the tool_call handler judges the call's own live ctx.model", async () => {
  const pi = host();
  registerReviewOnlyModelGuard(pi, resolveReviewOnlyModelGuardConfig({}, REVIEW_ONLY));
  const call = async (input: unknown, ctx?: unknown) =>
    (await pi.handlers.get("tool_call")!({ toolName: "write", input }, ctx as { model?: ModelRef } | undefined)) as
      | { block?: boolean }
      | undefined;

  assert.equal((await call({ path: "a" }, { model: { provider: "anthropic", id: "claude-opus-4-8" } }))?.block, true);
  assert.equal(await call({ path: "a" }, { model: { provider: "anthropic", id: "claude-fable-5" } }), undefined);
  assert.equal(await call({ path: "a" }, { model: undefined }), undefined);
  assert.equal(await call({ path: "a" }), undefined);
});

test("register: a context whose model cannot be read falls back to the environment, and never throws", async () => {
  const pi = host();
  const env: NodeJS.ProcessEnv = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-4-8" };
  registerReviewOnlyModelGuard(pi, resolveReviewOnlyModelGuardConfig(env, REVIEW_ONLY), { env });
  // Pi raises when a stale context is dereferenced; the guard must not carry
  // that out of the hook, and must still judge what it can.
  const dead = {
    get model(): ModelRef {
      throw new Error("context is no longer active");
    },
  };
  const verdict = (await pi.handlers.get("tool_call")!(
    { toolName: "bash", input: { command: "git commit -m x" } },
    dead,
  )) as { block?: boolean } | undefined;
  assert.equal(verdict?.block, true);
});
