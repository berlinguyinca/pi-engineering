/**
 * The review-only model guard (#727) wired through the REAL extension.
 *
 * `extensions/index.ts` registers it next to the primary worktree guard, on the
 * session's `tool_call` hook, with the `engineering.yaml` list read
 * asynchronously — so what this proves is the wiring, not just the predicate:
 * that activation attaches the handler, that the env override is live on the
 * first call, that the file list arms the handler when it lands, and that a
 * malformed `models:` block leaves the session unblocked with a note rather than
 * half-configured.
 *
 * The host is the harness's own event interface (the shape pi passes to an
 * extension), as in `extension-auto-invoke.test.ts`; nothing of ours is stubbed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../../extensions/index.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

function loadExtension(): Map<string, Handler[]> {
  const handlers = new Map<string, Handler[]>();
  (extension as unknown as (pi: unknown) => void)({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand: () => {},
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  });
  return handlers;
}

/**
 * The guard's own handler. Every guard in this extension writes its hook as
 * `guard.onToolCall(...)`, so the match has to be the one name this module's
 * register function gives its own instance (as the auto-invoke test does).
 */
function reviewOnlyHandler(handlers: Map<string, Handler[]>): Handler {
  const h = (handlers.get("tool_call") ?? []).find((f) => f.toString().includes("reviewOnlyGuard.onToolCall"));
  assert.ok(h, "the review-only model guard registers a tool_call handler");
  return h;
}

const REVIEW_MODEL = { provider: "anthropic", id: "claude-opus-4-8" };
const WRITE_CALL = { toolName: "write", input: { path: "src/a.ts", content: "x" } };

/**
 * Run `body` with the environment set, and put it back afterwards.
 *
 * `PI_MODEL`/`PI_PROVIDER` are cleared unless a case sets them: tests here run
 * inside a live pi session (the harness exports its own model into the tool
 * environment), and the guard reads those as its fallback — leaving them set
 * would judge the suite's own model instead of the one the case describes.
 */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const wanted: Record<string, string | undefined> = { PI_MODEL: undefined, PI_PROVIDER: undefined, ...vars };
  const prior: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(wanted)) {
    prior[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A profile dir whose engineering.yaml is `yaml` (durable memory stays off, as the harness profile does). */
function profileDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "review-only-profile-"));
  writeFileSync(join(dir, "engineering.yaml"), `memory:\n  hindsight:\n    enabled: false\n${yaml}`);
  return dir;
}

/** Wait for the asynchronous configuration read to arm the handler (bounded). */
async function settled(handler: Handler, call: unknown, ctx: unknown, want: boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    const verdict = (await handler(call, ctx)) as { block?: boolean } | undefined;
    if (!!verdict?.block === want) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * Assert the handler stays permissive for a window longer than the async
 * configuration read needs: what did NOT arm the guard must not arm it late.
 */
async function staysAllowed(handler: Handler, call: unknown, ctx: unknown): Promise<void> {
  for (let i = 0; i < 20; i++) {
    assert.equal(await handler(call, ctx), undefined, "the guard must not arm");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the extension blocks a review-only model's mutating calls from its own tool_call handler", async () => {
  await withEnv(
    { PI_CODING_AGENT_DIR: profileDir(""), PI_ENG_REVIEW_ONLY_MODELS: "anthropic/claude-opus-4-8" },
    async () => {
      const handler = reviewOnlyHandler(loadExtension());

      // Blocked: the writes, the git verbs, the merge.
      for (const call of [
        WRITE_CALL,
        { toolName: "edit", input: { path: "src/a.ts", edits: [] } },
        { toolName: "bash", input: { command: "git commit -m x" } },
        { toolName: "bash", input: { command: "gh pr merge 727 --squash" } },
        { toolName: "bash", input: { command: "echo x > NOTES.md" } },
      ]) {
        const verdict = (await handler(call, {
          model: REVIEW_MODEL,
        })) as { block?: boolean; reason?: string } | undefined;
        assert.equal(verdict?.block, true, `${call.toolName} ${JSON.stringify(call.input)}`);
        assert.match(verdict?.reason ?? "", /review-only/iu);
      }

      // Allowed: reading, inspecting, testing, reviewing — and the same calls on
      // a model nobody marked review-only.
      for (const call of [
        { toolName: "read", input: { path: "src/a.ts" } },
        { toolName: "bash", input: { command: "git status --porcelain" } },
        { toolName: "bash", input: { command: "npm run test:unit" } },
        { toolName: "bash", input: { command: "gh pr checks 727" } },
      ]) {
        assert.equal(await handler(call, { model: REVIEW_MODEL }), undefined, JSON.stringify(call.input));
      }
      assert.equal(await handler(WRITE_CALL, { model: { provider: "anthropic", id: "claude-fable-5" } }), undefined);
      // No model in the context and none in the environment: nothing to judge.
      assert.equal(await handler(WRITE_CALL, {}), undefined);
    },
  );
});

test("the extension blocks a review-only model named only in engineering.yaml, once the read lands", async () => {
  const dir = profileDir("models:\n  review_only:\n    - anthropic/claude-opus-4-8\n");
  await withEnv({ PI_CODING_AGENT_DIR: dir, PI_ENG_REVIEW_ONLY_MODELS: undefined }, async () => {
    const handler = reviewOnlyHandler(loadExtension());
    assert.ok(
      await settled(handler, WRITE_CALL, { model: REVIEW_MODEL }, true),
      "the engineering.yaml list arms the guard once the read completes",
    );
    // The kill switch outranks the file.
    await withEnv({ PI_ENG_REVIEW_ONLY_GUARD: "0" }, async () => {
      const killed = reviewOnlyHandler(loadExtension());
      await staysAllowed(killed, WRITE_CALL, { model: REVIEW_MODEL });
    });
  });
});

test("the extension overrides engineering.yaml with PI_ENG_REVIEW_ONLY_MODELS", async () => {
  const dir = profileDir("models:\n  review_only:\n    - anthropic/claude-fable-5\n");
  await withEnv({ PI_CODING_AGENT_DIR: dir, PI_ENG_REVIEW_ONLY_MODELS: "anthropic/claude-opus-4-8" }, async () => {
    const handler = reviewOnlyHandler(loadExtension());
    assert.ok(await settled(handler, WRITE_CALL, { model: REVIEW_MODEL }, true));
    // The file's model is no longer review-only once the env list replaces it.
    assert.equal(
      await handler(WRITE_CALL, { model: { provider: "anthropic", id: "claude-fable-5" } }),
      undefined,
      "the env override replaces the file list, it does not extend it",
    );
  });
});

test("a malformed models block leaves the session unblocked and says so", async () => {
  const dir = profileDir('models:\n  review_only: "anthropic/claude-opus-4-8"\n');
  const notes: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void notes.push(args.join(" "));
  try {
    await withEnv({ PI_CODING_AGENT_DIR: dir, PI_ENG_REVIEW_ONLY_MODELS: undefined }, async () => {
      const handler = reviewOnlyHandler(loadExtension());
      // Give the read every chance to finish, then assert it changed nothing.
      await staysAllowed(handler, WRITE_CALL, { model: REVIEW_MODEL });
    });
  } finally {
    console.error = original;
  }
  assert.ok(
    notes.some((note) => String(note).includes("review-only guard") && /models/iu.test(String(note))),
    `a malformed models block is reported, got: ${JSON.stringify(notes)}`,
  );
});
