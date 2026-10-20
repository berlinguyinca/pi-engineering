import assert from "node:assert/strict";
import { test } from "node:test";
import {
  StreamingActivityThrottle,
  activityFromSessionEvent,
  safeWorkerOutputPreview,
  sanitizeWorkerActivity,
} from "../../src/workers/activity.ts";

const start = (toolName: string, args: unknown) =>
  activityFromSessionEvent({ type: "tool_execution_start", toolName, args });

test("file activity identifies the normalized target without copying edit content", () => {
  const activity = start("edit", {
    path: "./src/old/../index.ts",
    oldText: "private reasoning",
    newText: "password=hidden-secret",
  });
  assert.equal(activity?.toolTarget, "src/index.ts");
  assert.match(activity?.summary ?? "", /src\/index\.ts/);
  assert.doesNotMatch(JSON.stringify(activity), /private reasoning|hidden-secret|oldText|newText/);
  assert.deepEqual(sanitizeWorkerActivity(activity), activity);
});

test("command activity exposes only recognized operation labels, never arguments", () => {
  for (const [command, label] of [
    ["npm test --token secret-token-value", "npm test"],
    ["npm run build -- --api-key private-key-value", "npm run build"],
    ["npx tsc --noEmit", "tsc"],
    ["cargo test -p private-project", "cargo test"],
    ["git diff -- private-filename", "git diff"],
  ]) {
    const activity = start("bash", { command });
    assert.equal(activity?.toolCommand, label);
    assert.ok(activity?.summary.includes(label!));
    assert.doesNotMatch(JSON.stringify(activity), /secret-token|private-key|private-project|private-filename/);
    assert.deepEqual(sanitizeWorkerActivity(activity), activity);
  }
  assert.equal(start("bash", { command: "deploy --secret password-value" })?.toolCommand, undefined);
  assert.equal(start("bash", { command: "echo 'npm test'" })?.toolCommand, undefined);
});

test("activity boundary rejects invented labels and unsafe path details", () => {
  const secret = `sk-${"a".repeat(32)}`;
  const activity = start("read", { path: `./src/${secret}/file.ts` });
  assert.doesNotMatch(JSON.stringify(activity), /sk-a/);
  assert.match(activity?.toolTarget ?? "", /REDACTED/);
  for (const path of ["src/\u001b[31mfile.ts", "src/\u202efile.ts", "https://user:password@host/file"]) {
    assert.equal(start("read", { path })?.toolTarget, undefined);
  }
  const forged = sanitizeWorkerActivity({
    kind: "tool",
    phase: "started",
    toolName: "bash",
    toolCommand: `npm test --token ${secret}`,
    toolTarget: "private reasoning",
    invocationSignature: "token=private-value",
    summary: "private reasoning",
  });
  assert.equal(forged?.toolCommand, undefined);
  assert.equal(forged?.toolTarget, undefined);
  assert.equal(forged?.invocationSignature, undefined);
  assert.doesNotMatch(JSON.stringify(forged), /private|sk-a/);
  assert.ok((start("read", { path: `src/${"a".repeat(400)}.ts` })?.summary.length ?? 0) <= 160);
});

test("invocation signatures distinguish arguments without disclosing them or counting absent arguments", () => {
  const first = start("read", { path: "src/a.ts", offset: 10 });
  const repeated = start("read", { offset: 10, path: "src/a.ts" });
  const differentPath = start("read", { path: "src/b.ts", offset: 10 });
  const differentOffset = start("read", { path: "src/a.ts", offset: 20 });
  assert.match(first?.invocationSignature ?? "", /^[a-f0-9]{64}$/);
  assert.equal(first?.invocationSignature, repeated?.invocationSignature);
  assert.notEqual(first?.invocationSignature, differentPath?.invocationSignature);
  assert.notEqual(first?.invocationSignature, differentOffset?.invocationSignature);
  assert.equal(start("read", undefined)?.invocationSignature, undefined);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(start("read", cycle)?.invocationSignature, undefined);
});

test("tool completion previews strip terminal escapes and redact secrets before bounding the output tail", () => {
  const key = `sk-${"b".repeat(32)}`;
  const output = `\u001b[31m${"old log ".repeat(300)}\nAPI_KEY=${key}\n\u001b[0m12 tests passed\u0007`;
  const activity = activityFromSessionEvent({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [
        { type: "text", text: output },
        { type: "thinking", text: "private reasoning" },
      ],
    },
  });
  assert.ok(activity?.outputPreview);
  assert.ok(activity.outputPreview.length <= 1000);
  assert.match(activity.outputPreview, /12 tests passed$/);
  assert.match(activity.outputPreview, /REDACTED/);
  assert.doesNotMatch(activity.outputPreview, /sk-b|private reasoning/);
  assert.equal(activity.outputPreview.includes("\u001b"), false);
  assert.equal(activity.outputPreview.includes("\u0007"), false);
  assert.equal(activity.meaningfulProgress, false);
  assert.deepEqual(sanitizeWorkerActivity(activity), activity);
});

test("throttled tool updates preview actual partial output without accepting assistant text or arguments", () => {
  const throttle = new StreamingActivityThrottle(1000);
  const event = {
    type: "tool_execution_update",
    partialResult: { content: [{ type: "text", text: "6 of 12 tests passed" }] },
    message: { role: "assistant", content: "private reasoning" },
    args: { command: "secret command" },
  };
  const activity = throttle.note(event, 0);
  assert.equal(activity?.outputPreview, "6 of 12 tests passed");
  assert.equal(throttle.note(event, 100), null);
  assert.deepEqual(sanitizeWorkerActivity(activity), activity);
  assert.doesNotMatch(JSON.stringify(activity), /private reasoning|secret command/);
  const modelActivity = throttle.note({ ...event, type: "message_update" }, 1000);
  assert.equal(modelActivity?.outputPreview, undefined);
  assert.equal(start("bash", { command: "npm test", outputPreview: "secret" })?.outputPreview, undefined);
  assert.equal(sanitizeWorkerActivity({ ...activity, summary: "Model streaming" })?.outputPreview, undefined);
  assert.equal(
    sanitizeWorkerActivity({
      kind: "tool",
      phase: "started",
      toolName: "bash",
      outputPreview: "secret",
    })?.outputPreview,
    undefined,
  );
});

test("preview redaction survives control-interrupted credentials and multiline private keys", () => {
  const preview = safeWorkerOutputPreview(
    `sk-${"c".repeat(8)}\u0007${"c".repeat(24)}\n-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\nfinished`,
  );
  assert.match(preview ?? "", /finished$/);
  assert.doesNotMatch(preview ?? "", /sk-|cccc|private-key-material/);
});
