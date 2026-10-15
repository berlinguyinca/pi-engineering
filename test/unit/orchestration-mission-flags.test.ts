import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import extension from "../../extensions/index.ts";
import { parseMissionFlags } from "../../src/orchestration/missionFlags.ts";
import type { AutospecFlags } from "../../src/orchestration/missionMode.ts";
import { Orchestrator } from "../../src/orchestration/orchestrator.ts";

const OFF: AutospecFlags = { enabled: false, managedEnabled: false, autoClassify: false };
const ON: AutospecFlags = { enabled: true, managedEnabled: true, autoClassify: false };
const ENABLED_ONLY: AutospecFlags = { enabled: true, managedEnabled: false, autoClassify: false };

describe("parseMissionFlags (R-MODE)", () => {
  it("returns the text unchanged, with no options, when it has no leading flags", () => {
    const r = parseMissionFlags("Add a health endpoint", OFF);
    assert.deepEqual(r, { rest: "Add a health endpoint", warnings: [] });
  });

  it("does not treat dashes inside the request as flags", () => {
    const r = parseMissionFlags("rename foo --max-workers to workers in the docs", OFF);
    assert.equal(r.error, undefined);
    assert.equal(r.rest, "rename foo --max-workers to workers in the docs");
    assert.equal(r.maxWorkers, undefined);
  });

  it("strips leading flags in any order, in both `--flag value` and `--flag=value` forms", () => {
    const r = parseMissionFlags("--max-workers 2 --budget=50GiB --mode autospec  Add a health endpoint", ON);
    assert.equal(r.error, undefined);
    assert.equal(r.mode, "autospec");
    assert.equal(r.maxWorkers, 2);
    assert.equal(r.budgetBytes, 50 * 1024 ** 3);
    assert.equal(r.rest, "Add a health endpoint");
  });

  it("accepts --backend pi-local with the flags off, and autospec-managed when managed is enabled", () => {
    assert.equal(parseMissionFlags("--backend pi-local do it", OFF).backend, "pi-local");
    const managed = parseMissionFlags("--mode autospec --backend autospec-managed do it", ON);
    assert.equal(managed.error, undefined);
    assert.equal(managed.backend, "autospec-managed");
  });

  it("returns an error for --max-workers 0", () => {
    const r = parseMissionFlags("--max-workers 0 x", ON);
    assert.match(r.error ?? "", /max-workers/);
  });

  it("returns an error for a non-positive, fractional, signed or non-numeric --max-workers", () => {
    for (const bad of ["-1", "1.5", "+2", "two", "1e2", "0x2", ""]) {
      const r = parseMissionFlags(`--max-workers=${bad} x`, ON);
      assert.match(r.error ?? "", /max-workers/, JSON.stringify(bad));
    }
  });

  it("caps --max-workers at the configured cap and says so", () => {
    const r = parseMissionFlags("--max-workers 64 x", ON, { maxWorkersCap: 4 });
    assert.equal(r.error, undefined);
    assert.equal(r.maxWorkers, 4);
    assert.match(r.warnings.join("\n"), /capped at 4/);
    // A value within the cap is untouched and warns nothing.
    const ok = parseMissionFlags("--max-workers 3 x", ON, { maxWorkersCap: 4 });
    assert.equal(ok.maxWorkers, 3);
    assert.deepEqual(ok.warnings, []);
  });

  it("returns an error for --backend autospec-managed with PI_AUTOSPEC_MANAGED_ENABLED unset", () => {
    for (const flags of [OFF, ENABLED_ONLY]) {
      const r = parseMissionFlags("--backend autospec-managed x", flags);
      assert.match(r.error ?? "", /PI_AUTOSPEC_MANAGED_ENABLED/);
    }
  });

  it("refuses autospec and mission modes unless PI_AUTOSPEC_ENABLED is on, but allows local", () => {
    for (const mode of ["autospec", "mission"]) {
      assert.match(parseMissionFlags(`--mode ${mode} x`, OFF).error ?? "", /PI_AUTOSPEC_ENABLED/);
      assert.equal(parseMissionFlags(`--mode ${mode} x`, ENABLED_ONLY).error, undefined);
    }
    assert.equal(parseMissionFlags("--mode local x", OFF).mode, "local");
  });

  it("rejects unknown modes, backends and flags, missing values, duplicates and an empty request", () => {
    const table: Array<[string, RegExp]> = [
      ["--mode turbo x", /--mode/],
      ["--backend cloud x", /--backend/],
      ["--frobnicate x", /unknown option --frobnicate/],
      ["--mode", /--mode/],
      ["--max-workers 2 --max-workers 3 x", /more than once/],
      ["--mode local", /request/i],
      ["--budget lots x", /--budget/],
      ["--budget 0 x", /--budget/],
    ];
    for (const [text, want] of table) {
      assert.match(parseMissionFlags(text, ON).error ?? "", want, text);
    }
  });

  it("parses budgets as bytes with binary units", () => {
    const table: Array<[string, number]> = [
      ["1024", 1024],
      ["1KiB", 1024],
      ["2MiB", 2 * 1024 ** 2],
      ["100GiB", 100 * 1024 ** 3],
      ["1tib", 1024 ** 4],
      ["7B", 7],
    ];
    for (const [raw, bytes] of table) {
      assert.equal(parseMissionFlags(`--budget ${raw} x`, ON).budgetBytes, bytes, raw);
    }
  });

  it("leaves /mission resume and cancel syntax alone: they are not flag-prefixed", () => {
    for (const text of ["resume MSN-1", "resume MSN-1 --model auto", "cancel MSN-1", "why MSN-1"]) {
      const r = parseMissionFlags(text, ON);
      assert.deepEqual(r, { rest: text, warnings: [] });
    }
  });
});

// ── The /mission handler ────────────────────────────────────────────────────

type Command = { handler: (args: string, ctx: unknown) => Promise<void> | void };

function loadMissionCommand(): Command {
  const commands = new Map<string, Command>();
  const pi = {
    on: () => {},
    registerCommand: (name: string, options: Command) => commands.set(name, options),
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    setModel: async () => false,
    events: { on: () => {}, emit: () => {} },
  };
  (extension as unknown as (api: unknown) => void)(pi);
  const command = commands.get("mission");
  assert.ok(command, "the extension registers /mission");
  return command;
}

function commandContext(cwd: string) {
  const notices: Array<{ text: string; level: string }> = [];
  return {
    notices,
    ctx: {
      cwd,
      mode: "tui",
      signal: undefined,
      model: undefined,
      modelRegistry: undefined,
      getContextUsage: () => undefined,
      isIdle: () => true,
      ui: {
        notify: (text: string, level: string) => notices.push({ text, level }),
        custom: () => ({ close: () => {} }),
        setFooter: () => {},
        onTerminalInput: () => () => {},
      },
    },
  };
}

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("/mission handler (R-MODE)", () => {
  it("with PI_MISSION_DEPTH=1 is refused before a mission is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-mission-depth-"));
    const original = Orchestrator.prototype.orchestrate;
    let orchestrated = 0;
    Orchestrator.prototype.orchestrate = (async () => {
      orchestrated++;
      throw new Error("a nested mission must not be orchestrated");
    }) as typeof Orchestrator.prototype.orchestrate;
    try {
      const command = loadMissionCommand();
      const { ctx, notices } = commandContext(root);
      await withEnv({ PI_MISSION_DEPTH: "1" }, () => Promise.resolve(command.handler("Add a health endpoint", ctx)));
      assert.equal(orchestrated, 0);
      const last = notices.at(-1);
      assert.equal(last?.level, "error");
      assert.match(last?.text ?? "", /PI_MISSION_DEPTH/);
      // Refused before the runtime opened: nothing but the refusal was said.
      assert.equal(notices.length, 1);
    } finally {
      Orchestrator.prototype.orchestrate = original;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a flag error as usage and does not start a mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-eng-mission-flags-"));
    const original = Orchestrator.prototype.orchestrate;
    let orchestrated = 0;
    Orchestrator.prototype.orchestrate = (async () => {
      orchestrated++;
      throw new Error("must not run");
    }) as typeof Orchestrator.prototype.orchestrate;
    try {
      const command = loadMissionCommand();
      for (const args of ["--max-workers 0 x", "--backend autospec-managed x"]) {
        const { ctx, notices } = commandContext(root);
        await withEnv(
          {
            PI_MISSION_DEPTH: undefined,
            PI_AUTOSPEC_ENABLED: undefined,
            PI_AUTOSPEC_MANAGED_ENABLED: undefined,
            PI_AUTOSPEC_AUTO_CLASSIFY: undefined,
          },
          () => Promise.resolve(command.handler(args, ctx)),
        );
        assert.equal(notices.length, 1, args);
        assert.equal(notices[0]?.level, "error");
        assert.match(notices[0]?.text ?? "", /\/mission \[--mode/);
      }
      assert.equal(orchestrated, 0);
    } finally {
      Orchestrator.prototype.orchestrate = original;
      await rm(root, { recursive: true, force: true });
    }
  });
});
