#!/usr/bin/env node
/**
 * Live self-update dogfood: reload, update and rollback of the REAL
 * pi-engineering code inside a REAL Pi session, against a temp install root.
 *
 * The update source is a bare clone of this repository, published from a
 * scratch clone, so the candidates are real commits of this code base. Each
 * one goes through the real validation: probe process, typecheck and critical
 * tests. Nothing under ~/.pi is read or written: HOME and PI_ENGINEERING_HOME
 * point into a temp directory, and the repository you run this from is only
 * read.
 *
 *   node scripts/dogfood-runtime-update.ts [--quick] [--verbose]
 *
 * --quick skips typecheck and critical tests during validation.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { EngineeringHostExtension } from "../src/runtime/host/extension.ts";

const quick = process.argv.includes("--quick");
const verbose = process.argv.includes("--verbose");
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures: string[] = [];
function check(ok: boolean, what: string): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

const root = mkdtempSync(join(tmpdir(), "dogfood-runtime-update-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
Object.assign(process.env, {
  HOME: home,
  PI_ENGINEERING_HOME: join(root, "install"),
  PI_ENGINEERING_CONTROL_DIR: join(root, "control"),
  PI_SELF_UPDATE: "0",
  PI_PANEL_AUTO_OPEN: "0",
  PI_PANEL_NARRATOR: "0",
});

async function main(): Promise<void> {
  console.log("live self-update dogfood");
  const head = git(repoRoot, "rev-parse", "HEAD");
  const previous = git(repoRoot, "rev-parse", "HEAD~1");

  // A real update source: a bare clone whose main is this checkout's HEAD.
  const remote = join(root, "remote.git");
  git(root, "clone", "--quiet", "--bare", "--no-local", repoRoot, remote);
  git(remote, "update-ref", "refs/heads/main", head);
  // The checkout Pi "installed": one commit behind, with dependencies linked.
  const checkout = join(root, "checkout");
  git(root, "clone", "--quiet", remote, checkout);
  git(checkout, "checkout", "--quiet", "--detach", previous);
  symlinkSync(join(repoRoot, "node_modules"), join(checkout, "node_modules"), "dir");

  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const ext = new EngineeringHostExtension({
    installRoot: join(root, "install"),
    packageRoot: checkout,
    entry: "src/runtime/host/runtimeEntry.ts",
    baseline: true,
    autoUpdateCheck: false,
    validation: quick ? "quick" : "default",
  });
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsManager = SettingsManager.create(project, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [((api: never) => ext.install(api)) as never],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(project),
    settingsManager,
    tools: [],
  });
  await session.bindExtensions({});
  const host = ext.host as NonNullable<typeof ext.host>;
  const run = async (cmd: string) => {
    const started = Date.now();
    await session.prompt(cmd);
    const o = ext.lastUpdateOutcome;
    if (o?.status === "handover") await o.done;
    await host.pendingTask()?.promise;
    while (ext.lock.isHeldByLiveProcess()) await new Promise((r) => setTimeout(r, 10));
    if (verbose) console.log(`  · ${cmd} (${Date.now() - started} ms)`);
  };

  try {
    console.log("\nphase 1: Pi loads the Host; the real runtime is generation 1");
    check(host.activeGeneration()?.generation === 1, "generation 1 active");
    check(host.activeGeneration()?.source.commit === previous, "running the installed checkout");

    console.log("\nphase 2: /engineering reload (development loop)");
    writeFileSync(join(checkout, "src", "dogfood-marker.ts"), "export const MARKER = 1;\n");
    await run("/engineering reload");
    check(
      host.lastHandover?.ok === true,
      `reload committed${host.lastHandover?.failure ? `: ${host.lastHandover.failure}` : ""}`,
    );
    check(host.activeGeneration()?.generation === 2, "generation 2");
    check(
      existsSync(join(host.activeGeneration()?.dir ?? "", "src", "dogfood-marker.ts")),
      "edited source tree loaded",
    );

    console.log("\nphase 3: dirty checkout refuses update, still reloads");
    await run("/engineering update");
    check(ext.lastUpdateOutcome?.status === "refused", `update refused (${ext.lastUpdateOutcome?.status})`);
    rmSync(join(checkout, "src", "dogfood-marker.ts"));

    console.log("\nphase 4: --check, then install the previous commit, then update to main");
    const check1 = await ext.updates.check({});
    check(check1.target?.sha === head && !check1.upToDate, "main is available");
    await run(`/engineering update --commit ${previous} --force`);
    check(ext.lastUpdateOutcome?.status === "handover", `--commit installed (${describe(ext)})`);
    await run("/engineering update");
    const o = ext.lastUpdateOutcome;
    check(o?.status === "handover", `main installed (${describe(ext)})`);
    if (o?.status === "handover") {
      for (const step of o.steps) check(step.status !== "failed", `validation: ${step.name} ${step.status}`);
    }
    check(host.activeGeneration()?.source.commit === head, "running HEAD from versions/");
    check(ext.layout.readMeta(ext.layout.readPointer("previous") ?? "")?.commit === previous, "previous retained");

    console.log("\nphase 5: /engineering rollback");
    await run("/engineering rollback");
    check(host.lastHandover?.ok === true, "rollback committed");
    check(host.activeGeneration()?.source.commit === previous, "previous version running again");
    const journal = ext.journal.read();
    check(journal !== "corrupt" && journal?.kind === "rollback" && journal.phase === "committed", "rollback journaled");

    console.log("\nphase 6: telemetry");
    const events = readFileSync(join(root, "install", "telemetry", "runtime-events.jsonl"), "utf8");
    for (const e of [
      "runtime.reload.completed",
      "runtime.update.validated",
      "runtime.update.committed",
      "runtime.rollback.completed",
    ]) {
      check(events.includes(`"event":"${e}"`), `${e} recorded`);
    }
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" } as never);
    session.dispose();
  }
}

function describe(ext: EngineeringHostExtension): string {
  const o = ext.lastUpdateOutcome;
  if (!o) return "none";
  if (o.status === "failed") return `failed at ${o.stage}: ${o.reason}`;
  if (o.status === "refused" || o.status === "pi_incompatible") return `${o.status}: ${o.reason}`;
  return o.status;
}

main()
  .catch((err) => {
    console.error("dogfood-runtime-update:", err);
    failures.push(String(err));
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    console.log("");
    if (failures.length > 0) {
      console.log(`RUNTIME UPDATE DOGFOOD FAILED: ${failures.length} check(s)`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
    console.log("RUNTIME UPDATE DOGFOOD OK");
    process.exit(0);
  });
