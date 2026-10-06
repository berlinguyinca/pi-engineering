/**
 * Pi entry point: the stable RuntimeHost (spec §2, §61).
 *
 * Pi loads THIS module once per session. It registers `/engineering` and the
 * Host's own lifecycle handlers, then loads the reloadable runtime generation
 * (`runtimeEntry.ts`, which drives the existing extension factory). Nothing
 * here is feature code; features live in the generation.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ago, formatHandover, short, waitingText } from "./format.ts";
import { type HandoverResult, type HandoverTask, RuntimeBusyError, RuntimeHost } from "./host.ts";
import { type RuntimeSource, snapshotRuntimeSource } from "./loader.ts";
import { RuntimeTelemetry } from "./telemetry.ts";

export const DEFAULT_RUNTIME_ENTRY = "src/runtime/host/runtimeEntry.ts";

export interface HostExtensionConfig {
  /** Pi Engineering's own state: generations, versions, journal (default ~/.pi/pi-engineering). */
  installRoot: string;
  /** The checkout Pi loaded this Host from. */
  packageRoot: string;
  /** Runtime entry, relative to a runtime source root. */
  entry: string;
  /** Development override: reload from this source tree instead of the package/installed runtime. */
  devSource?: string;
  /** Copy the package checkout before importing it directly, so a failed reload can roll back to it. */
  baseline?: boolean;
  /** Safe-point wait limit for handovers (ms). Absent: wait until cancelled. */
  safePointTimeoutMs?: number;
}

export function resolveHostConfig(env: NodeJS.ProcessEnv = process.env): HostExtensionConfig {
  const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const devSource = env.PI_ENGINEERING_RUNTIME_SOURCE?.trim();
  const timeout = Number(env.PI_ENGINEERING_SAFE_POINT_TIMEOUT_MS);
  return {
    installRoot: resolve(env.PI_ENGINEERING_HOME?.trim() || join(homedir(), ".pi", "pi-engineering")),
    packageRoot: resolve(packageRoot),
    entry: env.PI_ENGINEERING_RUNTIME_ENTRY?.trim() || DEFAULT_RUNTIME_ENTRY,
    ...(devSource ? { devSource: resolve(devSource) } : {}),
    baseline: env.PI_ENGINEERING_BASELINE !== "0",
    ...(Number.isFinite(timeout) && timeout > 0 ? { safePointTimeoutMs: timeout } : {}),
  };
}

/** Read version/commit for a runtime source directory. Never throws. */
export function describeSource(root: string): { version: string; commit: string | null } {
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // An unreadable manifest is reported as an unknown version, not a failure.
  }
  let commit: string | null = null;
  if (existsSync(join(root, ".git"))) {
    try {
      commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      commit = null;
    }
  }
  return { version, commit };
}

type Ctx = { ui?: { notify?: (text: string, level?: string) => void }; cwd?: string };

export class EngineeringHostExtension {
  readonly config: HostExtensionConfig;
  readonly generationsDir: string;
  host: RuntimeHost | undefined;
  readonly telemetry: RuntimeTelemetry;
  private pi: ExtensionAPI | undefined;

  constructor(config: HostExtensionConfig) {
    this.config = config;
    // Per process: another Pi process sharing the install root must never
    // prune a directory this one is still importing from.
    this.generationsDir = join(config.installRoot, "generations", `${process.pid}-${randomBytes(3).toString("hex")}`);
    this.telemetry = new RuntimeTelemetry(join(config.installRoot, "telemetry", "runtime-events.jsonl"));
  }

  async install(pi: ExtensionAPI): Promise<void> {
    this.pi = pi;
    const host = new RuntimeHost({ pi, generationsDir: this.generationsDir, telemetry: this.telemetry });
    this.host = host;
    host.bridge.registerHostCommand("engineering", {
      description: "Pi Engineering runtime: reload | update | rollback | version | cancel (and runtime subcommands)",
      handler: (args, ctx) => this.command(args, ctx as Ctx),
    });
    cleanupDeadGenerationDirs(join(this.config.installRoot, "generations"));
    const start = await this.startupSource();
    await host.start(start.source, start.fallbacks);
  }

  /** Where generation 1 comes from. Later phases add installed versions and crash recovery. */
  protected async startupSource(): Promise<{ source: RuntimeSource; fallbacks: RuntimeSource[] }> {
    const root = this.config.devSource ?? this.config.packageRoot;
    const meta = describeSource(root);
    let rollbackRoot: string | undefined;
    if (this.config.baseline !== false) {
      rollbackRoot = await snapshotRuntimeSource(root, this.generationsDir, "baseline").catch(() => undefined);
    }
    return {
      source: {
        root,
        entry: this.config.entry,
        version: meta.version,
        commit: meta.commit,
        label: this.config.devSource ? "dev" : "package",
        direct: true,
        ...(rollbackRoot ? { rollbackRoot } : {}),
      },
      fallbacks: [],
    };
  }

  /** What `/engineering reload` loads: the same source tree, re-read from disk. */
  protected reloadSource(): RuntimeSource {
    const active = this.host?.activeGeneration();
    const root = this.config.devSource ?? active?.source.root ?? this.config.packageRoot;
    const meta = describeSource(root);
    return {
      root,
      entry: this.config.entry,
      version: meta.version,
      commit: meta.commit ?? active?.source.commit ?? null,
      label: active?.source.label ?? "package",
    };
  }

  async command(args: string, ctx: Ctx): Promise<void> {
    const host = this.host;
    if (!host) return;
    host.noteContext(ctx);
    const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = argv[0] ?? "version";
    switch (sub) {
      case "reload":
        return this.reload(ctx);
      case "cancel": {
        const task = host.pendingTask();
        if (!task) return notify(ctx, "No Pi Engineering runtime handover is pending.");
        return notify(
          ctx,
          task.cancel()
            ? "Pending runtime handover cancelled. The current runtime keeps running."
            : `The handover is past the point of cancellation (${task.phase}); it will finish or roll back.`,
        );
      }
      case "version":
      case "status":
        return notify(ctx, this.versionText());
      default: {
        // Subcommands owned by the runtime generation (if it provides /engineering).
        const generation = host.activeGeneration()?.generation;
        const forwarded =
          generation === undefined ? undefined : host.bridge.generationCommand(generation, "engineering");
        if (forwarded) return forwarded.handler(args, ctx);
        return notify(ctx, `usage: /engineering <reload|update|rollback|version|cancel>\nunknown subcommand "${sub}".`);
      }
    }
  }

  protected async reload(ctx: Ctx): Promise<void> {
    const host = this.host as RuntimeHost;
    const source = this.reloadSource();
    let task: HandoverTask;
    try {
      task = host.begin({
        kind: "reload",
        source,
        ...(this.config.safePointTimeoutMs ? { safePointTimeoutMs: this.config.safePointTimeoutMs } : {}),
      });
    } catch (error) {
      if (error instanceof RuntimeBusyError) return notify(ctx, error.message);
      throw error;
    }
    const from = host.activeGeneration()?.source.version;
    const result = await this.awaitOrBackground(task, ctx, `Reloading Pi Engineering ${source.version}.`, (r) =>
      formatHandover(r, { from, to: source.version, action: "Reloaded" }),
    );
    if (result) notify(ctx, formatHandover(result, { from, to: source.version, action: "Reloaded" }), level(result));
  }

  /**
   * Await a handover, unless it has to wait for a safe point: then report what
   * it waits for and finish in the background (spec §20, §23). Returns the
   * result when it completed in the foreground.
   */
  protected async awaitOrBackground(
    task: HandoverTask,
    ctx: Ctx,
    what: string,
    format: (r: HandoverResult) => string,
  ): Promise<HandoverResult | undefined> {
    const host = this.host as RuntimeHost;
    let off: () => void = () => {};
    const waiting = new Promise<"waiting">((resolveWaiting) => {
      off = task.onBlocking((blocking) => {
        if (blocking.length > 0) resolveWaiting("waiting");
      });
    });
    const outcome = await Promise.race([task.promise, waiting]);
    off();
    if (outcome !== "waiting") return outcome;
    notify(ctx, waitingText(task.blocking, host.operations, what));
    void task.promise.then((r) => {
      const latest = (host.latestContext() as Ctx | undefined) ?? ctx;
      notify(latest, format(r), level(r));
    });
    return undefined;
  }

  versionText(): string {
    const host = this.host;
    const active = host?.activeGeneration();
    const prev = host?.previousKnownGood();
    const lines = [
      "Pi Engineering",
      "",
      `Version:        ${active?.source.version ?? "-"}`,
      `Commit:         ${short(active?.source.commit)}`,
      `Source:         ${active?.source.label ?? "-"}`,
      "",
      "Runtime API:    1",
      `Generation:     ${active?.generation ?? "none"}`,
      "",
      "Previous:",
      prev ? `${prev.source.version} / ${short(prev.source.commit)}` : "none retained",
      "",
      "Last reload:",
      ago(host?.lastReloadAt),
    ];
    const pending = host?.pendingTask();
    if (pending) lines.push("", `Handover in progress: ${pending.kind} (${pending.phase})`);
    if (host?.lastFailure) lines.push("", `Last failure: ${host.lastFailure}`);
    return lines.join("\n");
  }
}

function level(result: HandoverResult): string {
  return result.ok ? "info" : result.rolledBack || result.untouched ? "warning" : "error";
}

export function notify(ctx: Ctx | undefined, text: string, lvl = "info"): void {
  try {
    ctx?.ui?.notify?.(text, lvl);
  } catch {
    // A stale ctx (session replaced) cannot be told anything.
  }
}

/** Remove generation directories of Pi processes that no longer exist. */
export function cleanupDeadGenerationDirs(root: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const pid = Number(name.split("-")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (processAlive(pid)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Best effort: a directory we cannot remove is retried next startup.
    }
  }
  return removed;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pi extension factory. */
export default async function piEngineeringHost(pi: ExtensionAPI): Promise<void> {
  await new EngineeringHostExtension(resolveHostConfig()).install(pi);
}
