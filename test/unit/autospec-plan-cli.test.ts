import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runStandalonePlan } from "../../src/orchestration/standaloneEntry.ts";

type Rec = Record<string, unknown>;
const fixture = JSON.parse(readFileSync(new URL("../fixtures/autospec-dag/valid.json", import.meta.url), "utf8")) as {
  mission: Rec;
  tasks: Rec[];
};

function setup(opts: { global?: string; dag?: (d: { mission: Rec; tasks: Rec[] }) => void; asDir?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "pi-ag-cli-"));
  const agent = join(root, "agent");
  const cwd = join(root, "repo");
  mkdirSync(agent);
  mkdirSync(cwd);
  if (opts.global !== undefined) writeFileSync(join(agent, "engineering.yaml"), opts.global);
  const d = structuredClone(fixture);
  d.mission.state = "PLANNED";
  d.tasks[1]!.executor = "pi-local";
  opts.dag?.(d);
  let input: string;
  if (opts.asDir) {
    input = join(root, "dag");
    mkdirSync(input);
    writeFileSync(join(input, "mission.json"), JSON.stringify(d.mission));
    writeFileSync(join(input, "tasks.json"), JSON.stringify(d.tasks));
  } else {
    input = join(root, "dag.json");
    writeFileSync(input, JSON.stringify(d));
  }
  return { root, agent, cwd, input, store: join(root, "store") };
}

async function run(s: ReturnType<typeof setup>, extra: string[] = []) {
  let out = "";
  let err = "";
  const code = await runStandalonePlan(
    ["--store", s.store, "--from-autospec", s.input, ...extra],
    "",
    { PI_CODING_AGENT_DIR: s.agent, HOME: s.root },
    {
      write: (t) => {
        out += t;
      },
      error: (t) => {
        err += t;
      },
    },
    { cwd: s.cwd },
  );
  return { code, out, err, json: out ? (JSON.parse(out.trim().split("\n").pop()!) as Rec) : undefined };
}

describe("pi-engineering plan --from-autospec", () => {
  it("is refused unless autospec.dag.enabled is set (no block, or a block without dag)", async () => {
    const none = await run(setup({}));
    assert.equal(none.code, 2);
    assert.match(none.err, /DAG ingestion is off/);
    const other = await run(setup({ global: "autospec:\n  design_gate:\n    ui_paths: ['src/ui/**']\n" }));
    assert.equal(other.code, 2);
    const off = await run(setup({ global: "autospec:\n  dag:\n    enabled: false\n" }));
    assert.equal(off.code, 2);
    const bad = await run(setup({ global: "autospec:\n  dag:\n    enabled: 'yes'\n" }));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /invalid/);
  });

  it("a repo layer cannot enable ingestion", async () => {
    const s = setup({});
    mkdirSync(join(s.cwd, ".pi"));
    writeFileSync(join(s.cwd, ".pi/engineering.yaml"), "autospec:\n  dag:\n    enabled: true\n");
    assert.equal((await run(s)).code, 2);
  });

  it("ingests a file, records the plan revision and reports tasks, edges and issue refs", async () => {
    const s = setup({
      global: "autospec:\n  dag:\n    enabled: true\n",
      dag: (d) => {
        d.tasks[0]!.required_extensions = ["autospec.issue_refs"];
        d.tasks[0]!.extensions = { "autospec.issue_refs": ["berlinguyinca/autospec#12"] };
      },
    });
    const r = await run(s);
    assert.equal(r.code, 0, r.err + r.out);
    assert.equal(r.json?.result, "may_proceed");
    assert.equal(r.json?.reviewed, false);
    assert.equal(r.json?.source, "autospec");
    assert.deepEqual(
      (r.json?.tasks as Rec[]).map((t) => [t.taskId, t.dependsOn]),
      [
        ["t-1", []],
        ["t-2", ["t-1"]],
      ],
    );
    assert.deepEqual((r.json?.issueRefs as Rec)["t-1"], ["berlinguyinca/autospec#12"]);
  });

  it("reads a directory with mission.json and tasks.json", async () => {
    const r = await run(setup({ global: "autospec:\n  dag:\n    enabled: true\n", asDir: true }));
    assert.equal(r.code, 0, r.err + r.out);
  });

  it("applies the configured plan-review policy: require with no reviewer blocks the AutoSpec plan", async () => {
    const s = setup({
      global:
        "autospec:\n  dag:\n    enabled: true\nplan_review:\n  modes: {low: require, medium: require, high: require, critical: require}\n",
    });
    const r = await run(s);
    assert.equal(r.code, 1, r.err + r.out);
    assert.equal(r.json?.result, "blocked");
    assert.equal(r.json?.reviewed, true);
    assert.equal(typeof r.json?.planDigest, "string");
  });

  it("rejects an invalid DAG (cycle, managed executor, started mission) with exit 2 and a code", async () => {
    const cyc = await run(
      setup({
        global: "autospec:\n  dag:\n    enabled: true\n",
        dag: (d) => {
          d.tasks[0]!.depends_on = ["t-2"];
        },
      }),
    );
    assert.equal(cyc.code, 2);
    assert.equal(cyc.json?.code, "CYCLE");
    const managed = await run(
      setup({
        global: "autospec:\n  dag:\n    enabled: true\n",
        dag: (d) => {
          d.tasks[1]!.executor = "autospec-managed";
        },
      }),
    );
    assert.equal(managed.json?.code, "EXECUTOR_NOT_SUPPORTED");
    const running = await run(
      setup({
        global: "autospec:\n  dag:\n    enabled: true\n",
        dag: (d) => {
          d.mission.state = "RUNNING";
        },
      }),
    );
    assert.equal(running.json?.code, "MISSION_NOT_INGESTABLE");
  });

  it("a missing or malformed input file is a request error", async () => {
    const s = setup({ global: "autospec:\n  dag:\n    enabled: true\n" });
    writeFileSync(s.input, "{ nope");
    assert.equal((await run(s)).code, 2);
    s.input = join(s.root, "does-not-exist");
    assert.equal((await run(s)).code, 2);
  });
});
