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
import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { SourceCache, type TrustedSource, type UpdateChannel } from "../../update/gitSource.ts";
import { InstallLayout } from "../../update/installLayout.ts";
import { UpdateJournal } from "../../update/journal.ts";
import { type UpdateCheckResult, UpdateManager, type UpdateOutcome, type UpdateRequest } from "../../update/manager.ts";
import { MetadataError, parseCandidateMetadata, piCompatible } from "../../update/metadata.ts";
import { MutationLockBusyError, type MutationLockHandle, RuntimeMutationLock } from "../../update/mutationLock.ts";
import { readPreferences, writePreferences } from "../../update/preferences.ts";
import { type RecoveryOutcome, recoverInterruptedTransaction } from "../../update/recovery.ts";
import { applyRetention } from "../../update/retention.ts";
import { planRollback } from "../../update/rollback.ts";
import { DEFAULT_CHECK_INTERVAL_MS, shouldCheck } from "../../update/selfUpdate.ts";
import { runActivation } from "../../update/transaction.ts";
import type { ValidationMode } from "../../update/validate.ts";
import { readStateSchema } from "../migrations/schema.ts";
import { HOST_SUPPORTED_RUNTIME_APIS, PI_ENGINEERING_RUNTIME_API } from "./contract.ts";
import { ago, formatHandover, short, waitingText } from "./format.ts";
import { type HandoverHooks, type HandoverResult, type HandoverTask, RuntimeBusyError, RuntimeHost } from "./host.ts";
import { type RuntimeSource, snapshotRuntimeSource } from "./loader.ts";
import { publishRuntimeStatus } from "./runtimeStatus.ts";
import { type RuntimeEventFields, RuntimeTelemetry } from "./telemetry.ts";

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
  /** Update source (default: the package checkout's `origin`). */
  updateRemote?: string;
  /** Remotes updates may come from (default: just the update remote's default, `origin`). */
  trustedRemotes?: string[];
  /** Running Pi version (default: the loaded pi-coding-agent's VERSION). */
  piVersion?: string;
  /** Candidate validation depth (default "default"; "full" also runs the whole test suite). */
  validation?: ValidationMode;
  /** Allow `npm ci --ignore-scripts` in staging when a candidate's lockfile changed (default true). */
  allowDependencyInstall?: boolean;
  /** Check for updates automatically at session start (default true; installation stays opt-in). */
  autoUpdateCheck?: boolean;
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
    ...(env.PI_ENGINEERING_UPDATE_REMOTE?.trim() ? { updateRemote: env.PI_ENGINEERING_UPDATE_REMOTE.trim() } : {}),
    ...(env.PI_ENGINEERING_UPDATE_TRUSTED?.trim()
      ? {
          trustedRemotes: env.PI_ENGINEERING_UPDATE_TRUSTED.split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        }
      : {}),
    ...(env.PI_ENGINEERING_UPDATE_VALIDATION === "quick" || env.PI_ENGINEERING_UPDATE_VALIDATION === "full"
      ? { validation: env.PI_ENGINEERING_UPDATE_VALIDATION }
      : {}),
    allowDependencyInstall: env.PI_ENGINEERING_UPDATE_INSTALL_DEPS !== "0",
    autoUpdateCheck: env.PI_ENGINEERING_UPDATE_CHECK !== "0",
  };
}

/** A runtime directory's declared metadata, or null when absent/malformed. */
export function readCandidateMeta(dir: string): ReturnType<typeof parseCandidateMetadata> | null {
  try {
    return parseCandidateMetadata(readFileSync(join(dir, "package.json"), "utf8"), DEFAULT_RUNTIME_ENTRY);
  } catch (error) {
    if (error instanceof MetadataError) return null;
    return null;
  }
}

/** The runtime entry a version declares (package.json `piEngineering.entry`), when well-formed. */
export function declaredEntry(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { piEngineering?: { entry?: unknown } };
    const entry = pkg.piEngineering?.entry;
    return typeof entry === "string" &&
      /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}\.(?:ts|js|mjs)$/.test(entry) &&
      !entry.includes("..")
      ? entry
      : null;
  } catch {
    return null;
  }
}

/** The `origin` remote of a checkout, if any. */
export function originRemote(root: string): string | null {
  try {
    const url = execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return url || null;
  } catch {
    return null;
  }
}

export type UpdateArgs = { ok: true; check: boolean; request: UpdateRequest } | { ok: false; error: string };

/** Parse `/engineering update` flags. Tokenised; values validated; unknown flags rejected. */
export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const request: UpdateRequest = {};
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--check") check = true;
    else if (a === "--force") request.force = true;
    else if (a === "--verify-full") request.verify = "full";
    else if (a === "--channel") {
      const v = argv[++i];
      if (v !== "stable" && v !== "main") return { ok: false, error: "--channel must be stable or main" };
      request.channel = v;
    } else if (a === "--commit") {
      const v = argv[++i];
      if (!v || !/^[0-9a-fA-F]{7,40}$/.test(v))
        return { ok: false, error: "--commit needs a 7-40 character commit id" };
      request.commit = v.toLowerCase();
    } else return { ok: false, error: `unknown option ${a}` };
  }
  if (request.channel && request.commit) return { ok: false, error: "use --channel or --commit, not both" };
  return { ok: true, check, request };
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

type Ctx = {
  ui?: { notify?: (text: string, level?: string) => void; setStatus?: (key: string, text: string | undefined) => void };
  cwd?: string;
};

export class EngineeringHostExtension {
  readonly config: HostExtensionConfig;
  readonly generationsDir: string;
  host: RuntimeHost | undefined;
  readonly telemetry: RuntimeTelemetry;
  readonly layout: InstallLayout;
  readonly journal: UpdateJournal;
  readonly lock: RuntimeMutationLock;
  recovery: RecoveryOutcome | undefined;
  readonly updates: UpdateManager;
  private pi: ExtensionAPI | undefined;

  constructor(config: HostExtensionConfig) {
    this.config = config;
    this.layout = new InstallLayout(config.installRoot);
    this.journal = new UpdateJournal(this.layout.journalFile);
    this.lock = new RuntimeMutationLock(this.layout.lockFile);

    // Per process: another Pi process sharing the install root must never
    // prune a directory this one is still importing from.
    this.generationsDir = join(config.installRoot, "generations", `${process.pid}-${randomBytes(3).toString("hex")}`);
    this.telemetry = new RuntimeTelemetry(join(config.installRoot, "telemetry", "runtime-events.jsonl"));
    this.updates = new UpdateManager({
      layout: this.layout,
      journal: this.journal,
      lock: this.lock,
      telemetry: this.telemetry,
      cache: new SourceCache(this.layout.cacheRepo),
      source: () => this.trustedSource(),
      activation: this,
      running: () => {
        const a = this.host?.activeGeneration();
        if (!a) return null;
        return {
          version: a.source.version,
          commit: a.source.commit,
          label: a.source.label,
          root: a.source.root,
          checkout: !a.source.label.startsWith("installed:"),
        };
      },
      stateDir: () => this.stateDir(),
      piVersion: config.piVersion ?? PI_VERSION,
      supportedRuntimeApis: HOST_SUPPORTED_RUNTIME_APIS,
      defaultValidation: config.validation ?? "default",
      allowDependencyInstall: config.allowDependencyInstall !== false,
      packageRoot: config.packageRoot,
    });
  }

  async install(pi: ExtensionAPI): Promise<void> {
    this.pi = pi;
    const host = new RuntimeHost({ pi, generationsDir: this.generationsDir, telemetry: this.telemetry });
    this.host = host;
    host.bridge.registerHostCommand("engineering", {
      description:
        "Pi Engineering runtime: reload | update | rollback [--yes] | version | cancel (and runtime subcommands)",
      handler: (args, ctx) => this.command(args, ctx as Ctx),
    });
    cleanupDeadGenerationDirs(join(this.config.installRoot, "generations"));
    // Before anything loads: finish or undo a transaction a crash interrupted.
    this.recovery = await this.recoverOnStartup();
    const start = await this.startupSources();
    const result = await host.start(start[0] as RuntimeSource, start.slice(1));
    this.startupFallback = startupFallbackText(result, host.activeGeneration()?.source);
    if (this.startupFallback) {
      this.telemetry.emit("runtime.health.failed", { failure_reason: this.startupFallback });
    }
    await this.repairPointersAfterStart(result.ok ? host.activeGeneration()?.source : undefined);
    this.unpublish = publishRuntimeStatus(this, (now) => this.panelLines(now));
    host.bridge.onHostEvent("session_start", (_event, ctx) => this.onSessionStart(ctx as Ctx));
    host.bridge.onHostEvent("session_shutdown", () => this.dispose());
    await this.retain().catch(() => {});
  }

  /**
   * Set when startup could not run the preferred runtime: installed versions
   * failed and an older one or the package checkout runs, or nothing runs.
   * Shown in the status line, `/engineering version` and the panel.
   */
  startupFallback: string | undefined;

  private unpublish: () => void = () => {};
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last automatic or explicit update check (in memory; spec §14). */
  lastCheck: UpdateCheckResult | undefined;
  private checking: Promise<UpdateCheckResult | undefined> | undefined;

  /** Host shutdown: stop the update checker, let a running check finish, stop publishing panel status. */
  async dispose(): Promise<void> {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.unpublish();
    // A check in flight writes the preferences file; let it land before the
    // session (and possibly the process) goes away.
    await this.checking?.catch(() => undefined);
  }

  /**
   * Automatic update CHECK (spec §14): enabled by default, never blocks the
   * session, at most every PI_ENGINEERING_UPDATE_CHECK_INTERVAL (default 4h).
   * Installation stays off unless the operator turned `autoInstall` on.
   */
  private onSessionStart(ctx: Ctx): void {
    if (this.startupFallback) {
      try {
        ctx.ui?.setStatus?.(
          "pi-engineering-runtime",
          `Pi Engineering degraded: ${this.startupFallback.split("\n")[0]}`,
        );
      } catch {
        // No UI in this session; /engineering version still says it.
      }
    }
    if (this.config.autoUpdateCheck === false) return;
    const prefs = readPreferences(this.layout.preferencesFile);
    if (!prefs.autoCheck) return;
    const last = prefs.lastCheckAt ? Date.parse(prefs.lastCheckAt) : undefined;
    const interval = Number(process.env.PI_ENGINEERING_UPDATE_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS;
    if (!shouldCheck(Number.isFinite(last) ? last : undefined, Date.now(), interval)) return;
    // Deferred and unref'd: a network round trip never delays a session start.
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.automaticCheck(ctx);
    }, 0);
    this.checkTimer.unref?.();
  }

  async automaticCheck(ctx?: Ctx): Promise<UpdateCheckResult | undefined> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      try {
        const check = await this.updates.check({});
        this.lastCheck = check;
        const prefs = readPreferences(this.layout.preferencesFile);
        await writePreferences(this.layout.preferencesFile, {
          ...prefs,
          lastCheckAt: new Date().toISOString(),
          lastAvailable:
            check.target && !check.upToDate
              ? { version: check.target.metadata.version, commit: check.target.sha, channel: check.channel }
              : null,
        }).catch(() => {});
        if (check.target && !check.upToDate && !check.failure) {
          const target = (ctx ?? (this.host?.latestContext() as Ctx | undefined)) as Ctx | undefined;
          try {
            target?.ui?.setStatus?.(
              "pi-engineering-update",
              `Pi Engineering ${check.current?.version ?? ""} · ${check.target.metadata.version} available`,
            );
          } catch {
            // A stale ctx cannot show a status; the panel still does.
          }
          if (prefs.autoInstall && check.pi.ok) {
            const outcome = await this.updates.update({});
            this.lastUpdateOutcome = outcome;
            if (outcome.status === "handover") await outcome.done;
          }
        }
        return check;
      } catch {
        return undefined;
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  /** Retention after startup and after every committed transaction (spec §37). */
  async retain(): Promise<void> {
    // Under the mutation lock: another process's staging or install must never
    // be swept from under it. Busy means someone is mid-update; skip this round.
    let lock: MutationLockHandle;
    try {
      lock = this.lock.acquire("retention");
    } catch (error) {
      if (error instanceof MutationLockBusyError) return;
      throw error;
    }
    let removed: Awaited<ReturnType<typeof applyRetention>>;
    try {
      const running = this.host?.activeGeneration()?.source.root ?? null;
      removed = await applyRetention(this.layout, this.journal, { running });
    } finally {
      lock.release();
    }
    if (removed.versions.length + removed.staging.length + removed.checkpoints.length > 0) {
      this.telemetry.emit("runtime.retention.pruned", {
        versions: removed.versions.length,
        staging: removed.staging.length,
        checkpoints: removed.checkpoints.length,
      });
    }
    await this.host?.pruneSnapshots();
  }

  /** Crash recovery under the mutation lock (spec §30). Never blocks startup. */
  async recoverOnStartup(): Promise<RecoveryOutcome> {
    let handle: MutationLockHandle;
    try {
      handle = this.lock.acquire("crash-recovery");
    } catch (error) {
      if (error instanceof MutationLockBusyError) {
        return { action: "none", detail: `pid ${error.holder?.pid} is mid-update; it owns recovery` };
      }
      return { action: "none", detail: `recovery skipped: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      return await recoverInterruptedTransaction(this.layout, this.journal, this.telemetry);
    } catch (error) {
      // Recovery failing must not stop Pi: the Host's fallback chain still
      // finds a runtime that passes health.
      const detail = `crash recovery failed: ${error instanceof Error ? error.message : String(error)}`;
      this.telemetry.emit("runtime.crash_recovery.completed", { failure_reason: detail });
      return { action: "none", detail };
    } finally {
      handle.release();
    }
  }

  /** Where updates come from, and which sources are trusted (spec §46). */
  trustedSource(): TrustedSource {
    const origin = originRemote(this.config.packageRoot);
    const remote = this.config.updateRemote ?? origin;
    if (!remote) throw new Error("no update source: the package checkout has no origin and none is configured");
    const trusted = this.config.trustedRemotes ?? (origin ? [origin] : []);
    return { remote, trusted, identityRoots: [] };
  }

  /** Take the runtime mutation lock or tell the operator who has it (spec §28). */
  protected lockFor(operation: string, ctx: Ctx): MutationLockHandle | undefined {
    try {
      return this.lock.acquire(operation);
    } catch (error) {
      if (error instanceof MutationLockBusyError) {
        notify(ctx, error.message, "warning");
        return undefined;
      }
      throw error;
    }
  }

  /** `.pi-eng` of the repository the session works in (git toplevel, else cwd). */
  stateDir(cwd?: string): string | null {
    const dir = cwd ?? (this.host?.latestContext() as Ctx | undefined)?.cwd;
    if (!dir) return null;
    let root = dir;
    try {
      root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      root = dir;
    }
    return join(root, ".pi-eng");
  }

  /**
   * Generation 1, in order of preference: a development override, the
   * installed `current` version, the installed `previous` version, then the
   * package checkout Pi loaded this Host from. A source that fails to load,
   * start or pass health falls through to the next (spec §30, §57).
   */
  protected async startupSources(): Promise<RuntimeSource[]> {
    const sources: RuntimeSource[] = [];
    if (this.config.devSource) sources.push(await this.checkoutSource(this.config.devSource, "dev"));
    for (const pointer of ["current", "previous"] as const) {
      const dir = this.layout.readPointer(pointer);
      // Snapshotted, never imported in place: retention may later remove an
      // old version, and no process may be running code straight from it.
      if (dir) sources.push(this.installedSource(dir));
    }
    if (!this.config.devSource) {
      sources.push(await this.checkoutSource(this.config.packageRoot, "package", sources.length === 0));
    }
    return sources;
  }

  /** A mutable checkout, imported directly; a baseline copy is the rollback image. */
  protected async checkoutSource(root: string, label: string, baseline = true): Promise<RuntimeSource> {
    const meta = describeSource(root);
    let rollbackRoot: string | undefined;
    if (baseline && this.config.baseline !== false) {
      rollbackRoot = await snapshotRuntimeSource(root, this.generationsDir, "baseline").catch(() => undefined);
    }
    return {
      root,
      entry: this.config.entry,
      version: meta.version,
      commit: meta.commit,
      label,
      direct: true,
      ...(rollbackRoot ? { rollbackRoot } : {}),
    };
  }

  /** An installed version: immutable, so it is its own rollback image. */
  installedSource(dir: string, direct = false): RuntimeSource {
    const meta = this.layout.readMeta(dir);
    const described = describeSource(dir);
    return {
      root: dir,
      entry: declaredEntry(dir) ?? this.config.entry,
      version: meta?.version ?? described.version,
      commit: meta?.commit ?? described.commit,
      label: `installed:${meta?.id ?? dir.split("/").pop()}`,
      direct,
      ...(direct ? { rollbackRoot: dir } : {}),
    };
  }

  /**
   * If startup fell back from `current` to `previous`, make the pointers say
   * what is actually running, so the next start does not retry the bad one.
   */
  private async repairPointersAfterStart(running: RuntimeSource | undefined): Promise<void> {
    const current = this.layout.readPointer("current");
    if (!running || !current || !running.label.startsWith("installed:")) return;
    if (running.root === current) return;
    await this.layout.setPointer("current", running.root).catch(() => {});
    this.telemetry.emit("runtime.rollback.completed", {
      rollback_version: running.version,
      failure_reason: `startup could not run ${current}`,
    });
  }

  /** What `/engineering reload` loads: the same source tree (or installed pointer), re-read from disk. */
  protected reloadSource(): RuntimeSource {
    const active = this.host?.activeGeneration();
    if (!this.config.devSource && active?.source.label.startsWith("installed:")) {
      const current = this.layout.readPointer("current");
      return this.installedSource(current ?? active.source.root);
    }
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

  /**
   * Hand over to an installed version and make it `current` (spec §31-§35).
   * The pointer switch happens only after the old generation stopped; any
   * failure restores both pointers and the previous runtime.
   */
  async activateInstalled(
    dir: string,
    kind: "update" | "rollback",
    hooks: HandoverHooks = {},
    fields: RuntimeEventFields = {},
  ): Promise<HandoverTask> {
    const host = this.host as RuntimeHost;
    const pointers = { current: this.layout.readPointer("current"), previous: this.layout.readPointer("previous") };
    const activeDir = host.activeGeneration()?.source.root;
    return host.begin({
      kind,
      source: this.installedSource(dir),
      ...(this.config.safePointTimeoutMs ? { safePointTimeoutMs: this.config.safePointTimeoutMs } : {}),
      fields,
      hooks: {
        ...hooks,
        beforeLoad: async (snapshot) => {
          await hooks.beforeLoad?.(snapshot);
          this.telemetry.emit("runtime.activation.started", { ...fields });
          await this.layout.activate(dir);
          // Running from the checkout (no installed current yet): the previous
          // pointer cannot name it, which is fine; the checkout stays the fallback.
          if (!pointers.current && activeDir && this.layout.isVersionDir(activeDir)) {
            await this.layout.setPointer("previous", activeDir);
          }
          this.telemetry.emit("runtime.activation.completed", { ...fields });
        },
        onRollback: async (reason) => {
          await this.layout.restorePointers(pointers);
          await hooks.onRollback?.(reason);
        },
      },
    });
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
      case "update":
        return this.update(argv.slice(1), ctx);
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
      case "rollback": {
        const rest = argv.slice(1);
        const unknown = rest.find((a) => a.startsWith("-") && a !== "--yes");
        if (unknown) return notify(ctx, `unknown option ${unknown}\nusage: /engineering rollback [version] [--yes]`);
        return this.rollback(
          rest.find((a) => !a.startsWith("-")),
          ctx,
          rest.includes("--yes"),
        );
      }
      case "version":
        return notify(ctx, this.versionText());
      case "status":
        return notify(ctx, this.panelLines(Date.now()).join("\n"));
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
    const lock = this.lockFor("reload", ctx);
    if (!lock) return;
    let task: HandoverTask;
    try {
      task = host.begin({
        kind: "reload",
        source,
        ...(this.config.safePointTimeoutMs ? { safePointTimeoutMs: this.config.safePointTimeoutMs } : {}),
      });
    } catch (error) {
      lock.release();
      if (error instanceof RuntimeBusyError) return notify(ctx, error.message);
      throw error;
    }
    void task.promise.finally(() => lock.release());
    const from = host.activeGeneration()?.source.version;
    const result = await this.awaitOrBackground(task, ctx, `Reloading Pi Engineering ${source.version}.`, (r) =>
      formatHandover(r, { from, to: source.version, action: "Reloaded" }),
    );
    if (result) notify(ctx, formatHandover(result, { from, to: source.version, action: "Reloaded" }), level(result));
  }

  protected async update(argv: string[], ctx: Ctx): Promise<void> {
    const parsed = parseUpdateArgs(argv);
    if (!parsed.ok) {
      return notify(
        ctx,
        `${parsed.error}\nusage: /engineering update [--check] [--force] [--channel stable|main] [--commit <sha>] [--verify-full]`,
        "warning",
      );
    }
    if (parsed.check) {
      const check = await this.updates.check(parsed.request);
      return notify(ctx, formatCheck(check), check.failure ? "warning" : "info");
    }
    const progress: string[] = [];
    const outcome = await this.updates.update(parsed.request, (line) => progress.push(line));
    this.lastUpdateOutcome = outcome;
    if (outcome.status !== "handover") return notify(ctx, formatOutcome(outcome), "warning");
    const from = outcome.check.current?.version;
    const to = outcome.check.target?.metadata.version;
    const header = [`Pi Engineering ${from ?? "?"} → ${to ?? "?"}`, "", ...progress];
    const format = (r: HandoverResult) =>
      [...header, formatHandover(r, { from, to, action: "Updated" }).replace(/^Pi Engineering\n\n/, "")].join("\n");
    void outcome.done.then(({ result: r }) => (r.ok ? this.retain().catch(() => {}) : undefined));
    const result = await this.awaitOrBackground(outcome.task, ctx, `Pi Engineering ${to} ready.`, format);
    if (result) {
      await outcome.done;
      notify(ctx, format(result), level(result));
    }
  }

  /**
   * `/engineering rollback [version] [--yes]`: the same transactional handover
   * as an update (spec §36). When restoring the pre-migration checkpoint would
   * drop state written after the update, it lists what would be lost and
   * needs `--yes`.
   */
  protected async rollback(requested: string | undefined, ctx: Ctx, confirmed = false): Promise<void> {
    const lock = this.lockFor("rollback", ctx);
    if (!lock) return;
    let handedOver = false;
    try {
      const active = this.host?.activeGeneration();
      const stateDir = this.stateDir();
      let plan: Awaited<ReturnType<typeof planRollback>>;
      try {
        plan = await planRollback(this.layout, this.journal, active?.source.root ?? null, stateDir, requested);
      } catch (error) {
        return notify(ctx, `Rollback refused: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      if (plan.loss.paths.length > 0 && !confirmed) {
        const shown = plan.loss.paths.slice(0, 20);
        return notify(
          ctx,
          [
            `Rolling back to ${plan.target.version} restores the state checkpoint taken before schema ${plan.migration.from} and discards these files written since the update (${plan.loss.since}):`,
            ...shown.map((p) => `  ${p}`),
            ...(plan.loss.paths.length > shown.length ? [`  … and ${plan.loss.paths.length - shown.length} more`] : []),
            "",
            `Nothing was changed. To proceed: /engineering rollback${requested ? ` ${requested}` : ""} --yes`,
          ].join("\n"),
          "warning",
        );
      }
      const transaction = `rollback-${plan.target.id}-${randomBytes(3).toString("hex")}`;
      const record = this.journal.begin({
        transaction,
        kind: "rollback",
        fromVersion: active?.source.version ?? null,
        fromCommit: active?.source.commit ?? null,
        toVersion: plan.target.version,
        toCommit: plan.target.commit,
        previousRuntime: active?.source.root ?? null,
        candidateRuntime: plan.target.dir,
        pointers: { current: this.layout.readPointer("current"), previous: this.layout.readPointer("previous") },
        phase: "validating",
      });
      const fields = {
        transaction_id: transaction,
        from_version: active?.source.version,
        to_version: plan.target.version,
        rollback_version: plan.target.version,
      };
      this.telemetry.emit("runtime.rollback.started", fields);
      const tx = await runActivation({
        host: this,
        journal: this.journal,
        record,
        candidateDir: plan.target.dir,
        kind: "rollback",
        stateDir,
        migration: plan.migration,
        fields,
      });
      handedOver = true;
      const done = tx.done.finally(() => lock.release());
      void done.then(({ result }) => {
        this.telemetry.emit(result.ok ? "runtime.rollback.completed" : "runtime.rollback.failed", {
          ...fields,
          ...(result.failure ? { failure_reason: result.failure } : {}),
        });
        if (result.ok) void this.retain().catch(() => {});
      });
      const from = active?.source.version;
      const format = (r: HandoverResult) =>
        formatHandover(r, { from, to: plan.target.version, action: "Rolled back" }) +
        (plan.migration.plan.length > 0 && r.ok ? `\nState restored to schema ${plan.migration.to}.` : "");
      const result = await this.awaitOrBackground(tx.task, ctx, `Rolling back to ${plan.target.version}.`, format);
      if (result) {
        await done;
        notify(ctx, format(result), level(result));
      }
    } finally {
      if (!handedOver) lock.release();
    }
  }

  /** The Runtime/Update section of the Engineering panel (spec §44). */
  panelLines(nowMs: number): string[] {
    const host = this.host;
    const active = host?.activeGeneration();
    const prefs = readPreferences(this.layout.preferencesFile);
    const task = host?.pendingTask();
    const lines: string[] = [];
    if (task) {
      const label = task.kind === "reload" ? "Reloading" : task.kind === "rollback" ? "Rolling back" : "Updating";
      const to =
        this.lastUpdateOutcome?.status === "handover" ? this.lastUpdateOutcome.check.target?.metadata.version : "";
      lines.push(`${label} ${active?.source.version ?? "?"}${to ? ` → ${to}` : ""}`);
      if (task.kind === "update") lines.push("✓ staged", "✓ validation");
      lines.push(
        task.phase === "waiting_safe_point" ? "◌ waiting for safe point" : `◌ ${task.phase.replace(/_/g, " ")}`,
      );
      if (task.blocking.length > 0) lines.push("Active:", ...(host?.operations.summarize(task.blocking) ?? []));
      lines.push("");
    }
    const latest = this.lastCheck;
    lines.push(
      "Runtime",
      `Version       ${active?.source.version ?? "-"}`,
      `Commit        ${short(active?.source.commit)}`,
      `Generation    ${active?.generation ?? "none"}`,
      `Channel       ${prefs.channel}`,
      `Health        ${host?.lastFailure || this.startupFallback ? "degraded" : active ? "healthy" : "no runtime"}`,
      "Update",
      `Latest        ${latest?.target?.metadata.version ?? prefs.lastAvailable?.version ?? "-"}`,
      `Status        ${
        latest?.failure
          ? "check failed"
          : latest
            ? latest.upToDate
              ? "up to date"
              : "available"
            : prefs.lastAvailable
              ? "available"
              : "not checked"
      }`,
      "Previous",
    );
    const previous = this.layout.readPointer("previous");
    const prevMeta = previous ? this.layout.readMeta(previous) : null;
    const prevGood = host?.previousKnownGood();
    lines.push(
      prevMeta
        ? `${prevMeta.version}         retained`
        : prevGood
          ? `${prevGood.source.version}         retained (this session)`
          : "none",
      "Last reload",
      ago(host?.lastReloadAt, nowMs),
    );
    return lines;
  }

  lastUpdateOutcome: UpdateOutcome | undefined;

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
    const prefs = readPreferences(this.layout.preferencesFile);
    const stateDir = this.stateDir();
    const schema = stateDir && existsSync(stateDir) ? readStateSchema(stateDir) : null;
    const meta = active ? readCandidateMeta(active.source.root) : null;
    const piVersion = this.config.piVersion ?? PI_VERSION;
    const compat = meta ? piCompatible(piVersion, meta.minimumPiVersion, meta.maximumPiVersion) : { ok: true as const };
    const previous = this.layout.readPointer("previous");
    const prevMeta = previous ? this.layout.readMeta(previous) : null;
    const prevGood = host?.previousKnownGood();
    const lastUpdate = this.journal
      .history()
      .filter((r) => r.phase === "committed")
      .at(-1);
    const lines = [
      "Pi Engineering",
      "",
      `Version:        ${active?.source.version ?? "-"}`,
      `Commit:         ${short(active?.source.commit)}`,
      `Channel:        ${prefs.channel}`,
      `Source:         ${active?.source.label ?? "-"}`,
      "",
      `Runtime API:    ${meta?.runtimeApi ?? PI_ENGINEERING_RUNTIME_API}`,
      `Generation:     ${active?.generation ?? "none"}`,
      `State schema:   ${schema ?? "-"}`,
      "",
      `Pi compatibility: ${compat.ok ? "OK" : `NO (${compat.reason})`} (Pi ${piVersion})`,
      "",
      "Previous:",
      prevMeta
        ? `${prevMeta.version} / ${short(prevMeta.commit)}`
        : prevGood
          ? `${prevGood.source.version} / ${short(prevGood.source.commit)} (this session)`
          : "none retained",
      "",
      "Last update:",
      lastUpdate ? ago(Date.parse(lastUpdate.updatedAt)) : "never",
      "",
      "Last reload:",
      ago(host?.lastReloadAt),
    ];
    if (this.startupFallback) lines.push("", `Startup: ${this.startupFallback}`);
    const pending = host?.pendingTask();
    if (pending) lines.push("", `Handover in progress: ${pending.kind} (${pending.phase})`);
    if (host?.lastFailure) lines.push("", `Last failure: ${host.lastFailure}`);
    return lines.join("\n");
  }
}

/** What the operator must know about how startup went, or undefined when it ran the preferred runtime. */
export function startupFallbackText(result: HandoverResult, running: RuntimeSource | undefined): string | undefined {
  const failures = result.startupFailures ?? [];
  if (!result.ok) {
    return `No Pi Engineering runtime could start (${failures.join("; ") || result.failure || "unknown failure"}).`;
  }
  if (failures.length === 0 || !running) return undefined;
  const installedFailed = failures.filter((f) => f.startsWith("installed:"));
  if (running.label.startsWith("installed:")) {
    return `Running ${running.label} (${running.version}): ${failures.length} newer runtime(s) failed at startup: ${failures.join("; ")}`;
  }
  if (installedFailed.length > 0) {
    return `Every installed runtime failed at startup; running the package checkout (${running.version}), so installed updates are NOT in effect. Failures: ${failures.join("; ")}`;
  }
  return `Running ${running.label} (${running.version}) after: ${failures.join("; ")}`;
}

export function formatCheck(c: UpdateCheckResult): string {
  const lines = [
    "Pi Engineering",
    "",
    `Current:      ${c.current?.version ?? "-"}`,
    `Commit:       ${short(c.current?.commit)}`,
    `Channel:      ${c.channel}`,
    "",
  ];
  if (c.failure || !c.target) return [...lines, `Update check failed: ${c.failure ?? "no target"}`].join("\n");
  lines.push(
    `Available:    ${c.target.metadata.version}`,
    `Commit:       ${short(c.target.sha)}`,
    "",
    `Pi compatible: ${c.pi.ok ? "yes" : `no (${c.pi.reason})`}`,
    `Migration:     ${c.migration}`,
    "",
    c.upToDate ? "Up to date." : "Update available.",
  );
  return lines.join("\n");
}

export function formatOutcome(o: Exclude<UpdateOutcome, { status: "handover" }>): string {
  switch (o.status) {
    case "refused":
      return o.reason;
    case "up_to_date":
      return `Pi Engineering ${o.check.current?.version ?? ""} is up to date (${short(o.check.target?.sha)} on ${o.check.channel}). Use --force to reinstall it.`;
    case "pi_incompatible":
      return o.reason;
    case "failed":
      return [
        `Pi Engineering update failed during ${o.stage}: ${o.reason}`,
        ...(o.steps ?? []).map(
          (s) =>
            `${s.status === "passed" ? "✓" : s.status === "skipped" ? "–" : "✗"} ${s.name}${s.detail ? ` (${s.detail})` : ""}`,
        ),
        "",
        "The running runtime was not touched.",
      ].join("\n");
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
