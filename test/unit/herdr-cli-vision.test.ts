import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HerdrError, RealHerdrCli } from "../../src/runtime/herdr/HerdrCli.ts";

/** A stand-in `herdr` that records its argv, so we pin the exact flags herdr 0.9.1 accepts. */
function fake(response: unknown = { result: { type: "ok" } }) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-vision-"));
  const log = join(dir, "argv.log");
  const bin = join(dir, "herdr");
  writeFileSync(join(dir, "response.json"), JSON.stringify(response));
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\ncat ${join(dir, "response.json")}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, lines: () => readFileSync(log, "utf8").trim().split("\n") };
}

// Captured from `herdr pane split --direction right --no-focus --cwd /tmp` on herdr 0.9.1.
const SPLIT_RESPONSE = {
  id: "cli:pane:split",
  result: {
    pane: {
      agent_status: "unknown",
      cwd: "/tmp",
      focused: false,
      foreground_cwd: "/tmp",
      pane_id: "wE:p2",
      revision: 0,
      scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 97 },
      tab_id: "wE:t1",
      terminal_id: "term_65f50145e66a51f",
      workspace_id: "wE",
    },
    type: "pane_info",
  },
};

test("startAgent with args puts them after --", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).startAgent("w1:p2", "pi", "vision-ab12", [
      "--provider",
      "metabolomics",
      "--model",
      "qwen3.8-vision",
      "@/tmp/h.md",
    ]);
    assert.deepEqual(f.lines(), [
      "agent start vision-ab12 --kind pi --pane w1:p2 -- --provider metabolomics --model qwen3.8-vision @/tmp/h.md",
    ]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("startAgent without args is unchanged", async () => {
  const f = fake();
  try {
    await new RealHerdrCli({ bin: f.bin }).startAgent("p", "pi", "n");
    await new RealHerdrCli({ bin: f.bin }).startAgent("p", "pi", "n", []);
    assert.deepEqual(f.lines(), ["agent start n --kind pi --pane p", "agent start n --kind pi --pane p"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("splitPane passes cwd, direction, env and --no-focus and returns the new pane id", async () => {
  const f = fake(SPLIT_RESPONSE);
  try {
    const out = await new RealHerdrCli({ bin: f.bin }).splitPane({
      paneId: "wE:p1",
      cwd: "/tmp",
      direction: "down",
      env: { PI_VISION: "1", PI_HOME: "/tmp/x" },
    });
    assert.deepEqual(out, { paneId: "wE:p2" });
    assert.deepEqual(f.lines(), [
      "pane split --pane wE:p1 --direction down --no-focus --cwd /tmp --env PI_VISION=1 --env PI_HOME=/tmp/x",
    ]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("splitPane defaults direction to right and rejects a response without a pane", async () => {
  const f = fake({ result: { type: "ok" } });
  try {
    await assert.rejects(new RealHerdrCli({ bin: f.bin }).splitPane({ paneId: "p", cwd: "/tmp" }), /no pane/);
    assert.deepEqual(f.lines(), ["pane split --pane p --direction right --no-focus --cwd /tmp"]);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("splitPane rejects an env key or value outside [A-Z0-9_] and [A-Za-z0-9._:@/-]", async () => {
  const f = fake(SPLIT_RESPONSE);
  try {
    const cli = new RealHerdrCli({ bin: f.bin });
    await assert.rejects(cli.splitPane({ paneId: "p", cwd: "/tmp", env: { lower: "x" } }), /unsafe/);
    await assert.rejects(cli.splitPane({ paneId: "p", cwd: "/tmp", env: { A: "x; rm -rf /" } }), /unsafe/);
    await assert.rejects(cli.splitPane({ paneId: "p", cwd: "/tmp", env: { A: "" } }), /unsafe/);
    assert.throws(() => f.lines(), /ENOENT/); // nothing was executed
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

/**
 * A stand-in `herdr` that prints `body` and exits with `code`. herdr 0.9.1 prints API errors on STDERR (observed
 * live: `herdr agent get <closed pane> 2>/dev/null` prints nothing), so that is the default stream.
 */
function failing(body: unknown, code = 1, stream: "stderr" | "stdout" = "stderr") {
  const dir = mkdtempSync(join(tmpdir(), "herdr-vision-err-"));
  const bin = join(dir, "herdr");
  writeFileSync(join(dir, "response.json"), JSON.stringify(body));
  const redirect = stream === "stderr" ? " >&2" : "";
  writeFileSync(bin, `#!/bin/sh\ncat ${join(dir, "response.json")}${redirect}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

// Captured from `herdr agent get <closed pane>` on herdr 0.9.1 (on stderr, exit 1); the same answer comes for
// a pane with no agent, an unknown agent name and an unknown workspace.
const AGENT_NOT_FOUND = {
  error: { code: "agent_not_found", message: "agent target wX:p2 not found" },
  id: "cli:agent:get",
};

test("R21: getAgent resolves null when herdr answers agent_not_found", async () => {
  const f = failing(AGENT_NOT_FOUND);
  try {
    assert.equal(await new RealHerdrCli({ bin: f.bin }).getAgent("wX:p2"), null);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R21: getAgent resolves null for agent_not_found printed on stdout too", async () => {
  const f = failing(AGENT_NOT_FOUND, 1, "stdout");
  try {
    assert.equal(await new RealHerdrCli({ bin: f.bin }).getAgent("wX:p2"), null);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R21: getAgent still throws a HerdrError for any other herdr error", async () => {
  const f = failing({ error: { code: "server_unavailable", message: "socket closed" }, id: "cli:agent:get" });
  try {
    await assert.rejects(new RealHerdrCli({ bin: f.bin }).getAgent("wX:p2"), (err: unknown) => {
      assert.ok(err instanceof HerdrError);
      assert.equal(err.code, "server_unavailable");
      return true;
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R21: getAgent still throws when herdr fails without a JSON error", async () => {
  const f = failing("not json", 2);
  try {
    await assert.rejects(new RealHerdrCli({ bin: f.bin }).getAgent("wX:p2"), (err: unknown) => {
      assert.ok(err instanceof HerdrError);
      assert.equal(err.code, "herdr_cli_error");
      return true;
    });
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
