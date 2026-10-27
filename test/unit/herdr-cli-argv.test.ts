import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RealHerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";

/** A stand-in `herdr` that records its argv, so we pin the exact flags herdr 0.9.1 accepts. */
function fake(response: unknown = { result: { agent: { agent_status: "idle" } } }) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-argv-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "herdr");
  writeFileSync(join(dir, "response.json"), JSON.stringify(response));
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\ncat ${join(dir, "response.json")}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, lines: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("workspace provisioning returns the actual nested root pane without focus", async () => {
  const f = fake({ result: { workspace: { workspace_id: "w3" }, root_pane: { pane_id: "w3:p1", cwd: "/tmp/repo" } } });
  try {
    assert.deepEqual(await new RealHerdrCli({ bin: f.bin }).createWorkspace("/tmp/repo"), {
      workspaceId: "w3",
      paneId: "w3:p1",
      path: "/tmp/repo",
    });
    assert.deepEqual(f.lines(), ["workspace create --cwd /tmp/repo --no-focus"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("worktree provisioning uses --cwd and returns checkout and root pane", async () => {
  const f = fake({
    result: { workspace: { workspace_id: "w4" }, root_pane: { pane_id: "w4:p1" }, worktree: { path: "/tmp/checkout" } },
  });
  try {
    assert.deepEqual(await new RealHerdrCli({ bin: f.bin }).createWorktree("/tmp/repo"), {
      workspaceId: "w4",
      paneId: "w4:p1",
      path: "/tmp/checkout",
    });
    assert.deepEqual(f.lines(), ["worktree create --cwd /tmp/repo --no-focus"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("provisioning rejects incomplete topology rather than inventing a target", async () => {
  const f = fake({ result: { workspace: { workspace_id: "w3" } } });
  try {
    const cli = new RealHerdrCli({ bin: f.bin });
    await assert.rejects(cli.createWorkspace("/tmp/repo"), /pane/i);
    await assert.rejects(cli.createWorktree("/tmp/repo"), /pane/i);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent start uses the positional name and --pane", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).startAgent("w1:p2", "pi", "reviewer");
    assert.deepEqual(f.lines(), ["agent start reviewer --kind pi --pane w1:p2"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("agent wait repeats --until and uses --timeout", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).wait("a1", ["idle", "done"], 5000);
    assert.deepEqual(f.lines(), ["agent wait a1 --until idle --until done --timeout 5000"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("get and wait unwrap the live agent_info response", async () => {
  const agent = { pane_id: "w1:p2", agent_status: "done", revision: 5, state_change_seq: 8 };
  const f = fake({ result: { type: "agent_info", agent } });
  try {
    const cli = new RealHerdrCli({ bin: f.bin });
    assert.deepEqual(await cli.getAgent("w1:p2"), agent);
    assert.deepEqual(await cli.wait("w1:p2", ["done"], 5000), agent);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("wait and prompt honor requested deadlines beyond the default subprocess timeout", async () => {
  const f = fake();
  try {
    writeFileSync(f.bin, readFileSync(f.bin, "utf8").replace("cat ", "sleep 0.2\ncat "));
    const cli = new RealHerdrCli({ bin: f.bin, timeoutMs: 10 });
    assert.equal((await cli.wait("w1:p2", ["done"], 100)).agent_status, "idle");
    await cli.prompt("w1:p2", "bounded task", 100);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("an indefinite server wait has no subprocess deadline", async () => {
  const f = fake();
  try {
    writeFileSync(f.bin, readFileSync(f.bin, "utf8").replace("cat ", "sleep 0.2\ncat "));
    const cli = new RealHerdrCli({ bin: f.bin, timeoutMs: 10 });
    assert.equal((await cli.wait("w1:p2", ["done"])).agent_status, "idle");
    assert.equal((await cli.wait("w1:p2", ["done"], 0)).agent_status, "idle");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("exportEnv runs one export line in the pane and refuses unsafe values", async () => {
  const f = fake();
  try {
    const cli = new RealHerdrCli({ bin: f.bin });
    await cli.exportEnv("w1:p2", { PI_ENGINEERING_ROLE: "reviewer" });
    assert.deepEqual(f.lines(), ["pane run w1:p2 export PI_ENGINEERING_ROLE=reviewer"]);
    await assert.rejects(cli.exportEnv("w1:p2", { PI_ENGINEERING_ROLE: "x; rm -rf /" }), /unsafe/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
