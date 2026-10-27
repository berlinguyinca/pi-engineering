/**
 * Actual LLM handoff proof against an operator-provisioned EPHEMERAL agentDir.
 * Usage: node --import ./test/support/isolatedState.ts scripts/evidence/c1-request-handoff-evidence.ts <agentDir> <provider> <big-id> <small-id>
 * Never point this at a live user's agentDir. All session/project state is temporary.
 * The supplied models/auth files are read by Pi; this script does not copy or log credentials.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerPlannerWorker } from "../../src/plannerWorker/extension.ts";

const [suppliedDir, provider, bigId, smallId] = process.argv.slice(2);
if (!suppliedDir || !provider || !bigId || !smallId) {
  throw new Error("Expected ephemeral agentDir, provider, big model id and small model id");
}
const agentDir = resolve(suppliedDir);
const root = await mkdtemp(join(tmpdir(), "c1-request-proof-"));
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const big = runtime.getModel(provider, bigId);
  const small = runtime.getModel(provider, smallId);
  assert.ok(big && small, "both supplied models must exist in the ephemeral registry");
  assert.ok(big.contextWindow > small.contextWindow, "proof requires a smaller successor window");
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  let requestChars = 0;
  let requests = 0;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        registerPlannerWorker(pi, { host: async () => ({ repoRoot: root, worker: null }) as never });
        pi.on("before_provider_request", (event) => {
          const serialized = JSON.stringify(event.payload);
          assert.ok(!serialized.includes("C1_OLD_CONTEXT_SENTINEL"), "old transcript must not reach the provider");
          assert.ok(serialized.includes("Reply with HANDOFF_OK"), "latest task must survive");
          assert.ok(serialized.includes("Continue the handed-off task"), "new user turn must survive");
          requestChars = serialized.length;
          assert.ok(
            Math.ceil(requestChars / 4) + 4096 < small.contextWindow,
            "complete serialized request plus reserve must fit the successor estimate",
          );
          requests++;
        });
      },
    ],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(root);
  manager.appendMessage({
    role: "user",
    content: `C1_OLD_CONTEXT_SENTINEL ${"old irrelevant details ".repeat(Math.ceil((small.contextWindow * 5) / 23))}`,
    timestamp: 1,
  });
  manager.appendMessage({
    role: "user",
    content: "Reply with HANDOFF_OK to confirm the current task reached you.",
    timestamp: 2,
  });
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: big,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager,
    sessionManager: manager,
    tools: ["read"],
  }));
  const errors: string[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error.error) });
  const before = session.getContextUsage()?.tokens ?? 0;
  assert.ok(before > small.contextWindow, "seeded context must exceed the successor window");
  await session.setModel(small);
  await session.prompt("Continue the handed-off task. Reply briefly without using tools.");
  assert.deepEqual(errors, []);
  const last = session.agent.state.messages.at(-1);
  assert.equal(last?.role, "assistant");
  assert.equal((last as { stopReason?: string }).stopReason, "stop");
  assert.match(JSON.stringify(last), /HANDOFF_OK/);
  assert.ok(requests > 0);
  assert.equal(manager.getEntries().filter((entry) => entry.type === "compaction").length, 0);
  console.log(
    JSON.stringify({
      provider,
      big: bigId,
      small: smallId,
      beforeTokens: before,
      contextWindow: small.contextWindow,
      requestChars,
      requests,
      response: "HANDOFF_OK",
      compactions: 0,
    }),
  );
} finally {
  session?.dispose();
  await rm(root, { recursive: true, force: true });
}
