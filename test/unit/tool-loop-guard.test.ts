import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolLoopDetector, callKey, maskScratchNames, toolResultText } from "../../src/workers/toolLoopGuard.ts";

const run = (d: ToolLoopDetector, tool: string, args: unknown, out = "ok", err = false) =>
  d.observe(tool, args, out, err);

test("identical calls trip at the limit, whitespace and key order ignored", () => {
  const d = new ToolLoopDetector(3);
  assert.equal(run(d, "bash", { command: "npm  test", timeout: 5 }), undefined);
  assert.equal(run(d, "bash", { timeout: 5, command: "npm test " }), undefined);
  const trip = run(d, "bash", { command: "npm\ntest", timeout: 5 });
  assert.equal(trip?.count, 3);
  assert.equal(trip?.tool, "bash");
});

test("a different output, args or tool resets the streak", () => {
  const d = new ToolLoopDetector(3);
  run(d, "bash", { command: "a" }, "1");
  run(d, "bash", { command: "a" }, "2");
  run(d, "bash", { command: "a" }, "3");
  run(d, "bash", { command: "a" }, "3");
  assert.equal(run(d, "bash", { command: "b" }, "3"), undefined);
  assert.equal(run(d, "read", { path: "a" }, "3"), undefined);
  assert.equal(run(d, "read", { path: "b" }, "3"), undefined, "different files");
  assert.equal(run(d, "read", { path: "c" }, "3"), undefined);
});

test("an error result is not the same as a success result", () => {
  const d = new ToolLoopDetector(2);
  run(d, "bash", { command: "a" }, "x", true);
  assert.equal(run(d, "bash", { command: "a" }, "x", false), undefined);
});

test("a file-changing tool resets the streak", () => {
  const d = new ToolLoopDetector(3);
  run(d, "bash", { command: "t" });
  run(d, "bash", { command: "t" });
  run(d, "edit", { path: "x" });
  assert.equal(run(d, "bash", { command: "t" }), undefined);
  assert.equal(run(d, "bash", { command: "t" }), undefined);
  assert.ok(run(d, "bash", { command: "t" }));
});

test("scratch names are masked only when the command creates them", () => {
  const mk = (n: string) => `cat > ${n}.mjs <<'EOF'\nx\nEOF\nnode ${n}.mjs`;
  assert.equal(callKey("bash", { command: mk("pa") }, "o", false), callKey("bash", { command: mk("pb") }, "o", false));
  assert.notEqual(
    callKey("bash", { command: mk("pa") }, "o", false),
    callKey("bash", { command: mk("pb") }, "p", false),
  );
  // reading different files is never masked
  assert.notEqual(
    callKey("bash", { command: "cat a.txt" }, "o", false),
    callKey("bash", { command: "cat b.txt" }, "o", false),
  );
  // long stems and directories are not scratch names
  assert.notEqual(
    callKey("bash", { command: "echo 1 > report.txt" }, "", false),
    callKey("bash", { command: "echo 1 > output.txt" }, "", false),
  );
  assert.notEqual(
    callKey("bash", { command: "echo 1 > d/a.txt" }, "", false),
    callKey("bash", { command: "echo 1 > d/b.txt" }, "", false),
  );
  assert.equal(maskScratchNames("node pa.mjs; node spa.mjs", "cat > pa.mjs"), "node <scratch>.mjs; node spa.mjs");
  // non-bash tools are never masked
  assert.notEqual(callKey("write", { path: "a.js" }, "", false), callKey("write", { path: "b.js" }, "", false));
});

test("toolResultText joins text parts", () => {
  assert.equal(
    toolResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
    "a\n\nb",
  );
  assert.equal(toolResultText(undefined), "");
});
