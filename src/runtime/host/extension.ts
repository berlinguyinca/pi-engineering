/**
 * Pi entry point: the stable RuntimeHost (spec §2, §61).
 *
 * Pi loads THIS module once per session. It registers `/engineering` and the
 * Host's own lifecycle handlers, then loads the reloadable runtime generation
 * (`runtimeEntry.ts`, which drives the existing extension factory). Nothing
 * here is feature code; features live in the generation.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { safeGitOrThrow, safeGitSyncOut } from "../../git/safeGit.ts";
import { SourceCache, type TrustedSource, type UpdateChannel } from "../../update/gitSource.ts";
import { type RuntimeUpdateBridge, runtimeUpdateBridge, setRuntimeUpdateBridge } from "../../update/hostBridge.ts";
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
import { toAutocompleteItems } from "./completions.ts";
import { HOST_SUPPORTED_RUNTIME_APIS, PI_ENGINEERING_RUNTIME_API } from "./contract.ts";
import { ago, formatHandover, short, waitingText } from "./format.ts";
import { type HandoverHooks, type HandoverResult, type HandoverTask, RuntimeBusyError, RuntimeHost } from "./host.ts";
import { type RuntimeSource, snapshotRuntimeSource } from "./loader.ts";
import {
  type HostMaintenanceProvider,
  type HostMaintenanceReloadRequest,
  type HostMaintenanceReloadResult,
  publishHostMaintenance,
} from "./maintenance.ts";
import { DEFAULT_SAFE_POINT_TIMEOUT_MS } from "./operations.ts";
import { publishRuntimeStatus } from "./runtimeStatus.ts";
import {
  DEFAULT_AUTO_RELOAD_INTERVAL_MS,
  DEFAULT_FOLLOW_REMOTE_INTERVAL_MS,
  SourceWatcher,
  followRemote,
  gitHead,
  trackedChanges,
} from "./sourceWatch.ts";
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
  /** Safe-point wait limit for handovers (ms). Default: 30 seconds. */
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
  /**
   * Hot-reload the runtime by itself when the source checkout's HEAD moves
   * (a merge landed on the branch Pi loads from). Only for a git checkout
   * (the package or the dev override); an installed version changes only
   * through an update, which hands over on its own. Default true in
   * production (`PI_ENGINEERING_AUTO_RELOAD=0` turns it off).
   */
  autoReload?: boolean;
  /** How often the checkout's HEAD is polled (default 15 s). */
  autoReloadIntervalMs?: number;
  /**
   * Keep a checkout that tracks a remote up to that remote (fetch + strict
   * fast-forward, never over uncommitted work or a diverged branch), so a
   * session on another host follows GitHub and hot-reloads. Default on,
   * like the legacy session-start fast-forward it extends; off with
   * `PI_ENGINEERING_FOLLOW_REMOTE=0` or `PI_SELF_UPDATE=0|off|check`.
   */
  followRemote?: boolean;
  /** How often the remote is fetched (default 5 min). */
  followRemoteIntervalMs?: number;
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
    safePointTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_SAFE_POINT_TIMEOUT_MS,
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
    autoReload: env.PI_ENGINEERING_AUTO_RELOAD !== "0",
    ...(Number(env.PI_ENGINEERING_AUTO_RELOAD_INTERVAL_MS) > 0
      ? { autoReloadIntervalMs: Number(env.PI_ENGINEERING_AUTO_RELOAD_INTERVAL_MS) }
      : {}),
    followRemote:
      env.PI_ENGINEERING_FOLLOW_REMOTE !== "0" && !/^(0|false|off|check)$/i.test((env.PI_SELF_UPDATE ?? "auto").trim()),
    ...(Number(env.PI_ENGINEERING_FOLLOW_REMOTE_INTERVAL_MS) > 0
      ? { followRemoteIntervalMs: Number(env.PI_ENGINEERING_FOLLOW_REMOTE_INTERVAL_MS) }
      : {}),
  };
}

/** The Host's own `/engineering` (and `/pie`) subcommands; anything else is the runtime's. */
const HOST_SUBCOMMANDS = new Set(["reload", "update", "rollback", "version", "status", "cancel"]);

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

/**
 * Answers of two synchronous git probes that sit on startup paths (`trustedSource`, `stateDir`), kept per path: the
 * `origin` URL is keyed by the mtime of the repository's own config file (any edit shows at once), and the toplevel of a
 * directory for a few seconds. `describeSource` is NOT cached: HEAD and cleanliness move whenever the checkout does,
 * and a stale answer there would let a hot reload load the wrong commit. A failed probe is cached too (fail closed:
 * null / the directory itself), so a missing git does not cost a spawn each time.
 */
const probeCache = new Map<string, { stamp: string; at: number; value: unknown }>();
const TOPLEVEL_TTL_MS = 10_000;
export function invalidateGitProbeCache(): void {
  probeCache.clear();
}
function configStamp(root: string): string | null {
  try {
    const dotGit = join(root, ".git");
    if (!statSync(dotGit).isDirectory()) return null; // a linked work tree: its config is elsewhere, do not cache
    const st = statSync(join(dotGit, "config"));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}
function probed<T>(kind: "origin" | "toplevel", path: string, stamp: string | null, compute: () => T): T {
  if (stamp === null && kind === "origin") return compute();
  const key = `${kind}\0${path}`;
  const hit = probeCache.get(key);
  const now = Date.now();
  const fresh = hit && hit.stamp === (stamp ?? "") && (kind === "origin" || now - hit.at < TOPLEVEL_TTL_MS);
  if (fresh) return hit.value as T;
  const value = compute();
  if (probeCache.size > 256) probeCache.clear();
  probeCache.set(key, { stamp: stamp ?? "", at: now, value });
  return value;
}

/** The `origin` remote of a checkout, if any. */
export function originRemote(root: string): string | null {
  return probed("origin", root, configStamp(root), () => {
    try {
      const url = safeGitSyncOut(["remote", "get-url", "origin"], { cwd: root, timeoutMs: 2000 }).trim();
      return url || null;
    } catch {
      return null;
    }
  });
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

/** Read version/commit for a runtime source directory. Never throws. Not cached: HEAD and cleanliness move with the checkout. */
export function describeSource(root: string): { version: string; commit: string | null } {
  const version = readVersion(root);
  let commit: string | null = null;
  if (existsSync(join(root, ".git"))) {
    try {
      commit = safeGitSyncOut(["rev-parse", "HEAD"], { cwd: root, timeoutMs: 2000 }).trim();
      const dirty = safeGitSyncOut(["status", "--porcelain", "--untracked-files=no"], {
        cwd: root,
        timeoutMs: 2000,
        env: { GIT_OPTIONAL_LOCKS: "0" },
      }).trim();
      if (dirty || !/^[0-9a-f]{40}$/.test(commit)) commit = null;
    } catch {
      commit = null;
    }
  }
  return { version, commit };
}

function readVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // An unreadable manifest is reported as an unknown version, not a failure.
  }
  return "0.0.0";
}

/** `describeSource` for async callers: the git probes run without blocking the event loop (same answers). */
export async function describeSourceAsync(root: string): Promise<{ version: string; commit: string | null }> {
  const version = readVersion(root);
  let commit: string | null = null;
  if (existsSync(join(root, ".git"))) {
    try {
      commit = (
        await safeGitOrThrow(["rev-parse", "HEAD"], { cwd: root, trust: "operator", timeoutMs: 2000 })
      ).stdout.trim();
      const dirty = (
        await safeGitOrThrow(["status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
          trust: "operator",
          timeoutMs: 2000,
          env: { GIT_OPTIONAL_LOCKS: "0" },
        })
      ).stdout.trim();
      if (dirty || !/^[0-9a-f]{40}$/.test(commit)) commit = null;
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
  private bridgeRef: RuntimeUpdateBridge | undefined;
  private pi: ExtensionAPI | undefined;
  private readonly hostCommit: string | null;
  private unpublishMaintenance: () => void = () => {};

  constructor(config: HostExtensionConfig) {
    this.config = config;
    this.hostCommit = describeSource(config.packageRoot).commit;
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
    try {
      await this.installSteps(pi);
    } catch (error) {
      // A Host that failed to install must not leave `/update` pointed at an
      // UpdateManager whose generation never started.
      this.withdrawBridge();
      // The entry shim falls back to the legacy extension after this throws.
      // A generation this Host already started must not keep running beside
      // it (two runtimes, two custody owners): stop it first, and say so if
      // that is impossible.
      if (!(await this.abandon())) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          generationStillRunning: true,
        });
      }
      throw error;
    }
  }

  /** Stop whatever this Host started. True when no generation is left running. */
  async abandon(): Promise<boolean> {
    try {
      if (this.checkTimer) clearTimeout(this.checkTimer);
      await this.stopSourceWatch();
      this.unpublish();
      this.unpublishMaintenance();
      await this.host?.shutdown({ type: "session_shutdown", reason: "quit" }, undefined);
      return !this.host?.activeGeneration();
    } catch {
      return !this.host?.activeGeneration();
    }
  }

  /**
   * The seam the legacy `/update` command drives when Pi loaded the extension
   * from an installed runtime (no version-control metadata, so the checkout
   * fast-forward cannot apply). Ownership is the install's question to answer,
   * and it covers the generation snapshot the extension is actually imported
   * from — not just `versions/<id>`.
   *
   * Activation stays here: the bridge only forwards to this Host's UpdateManager,
   * which is the single owner of the pointer switch and the handover.
   */
  private updateBridge(): RuntimeUpdateBridge {
    return {
      owns: (dir: string) => this.layout.ownsRuntimeTree(dir),
      check: async () => {
        const check = await this.updates.check({});
        return {
          lines: [formatCheck(check)],
          pending: !check.upToDate && check.target !== null,
          ...(check.failure ? { failure: check.failure } : {}),
        };
      },
      apply: async (report) => {
        const lines: string[] = [];
        const outcome = await this.updates.update({}, (line) => {
          lines.push(line);
          report?.(line);
        });
        this.lastUpdateOutcome = outcome;
        if (outcome.status === "handover") {
          const from = outcome.check.current?.version;
          const to = outcome.check.target?.metadata.version;
          // An explicit `/update` waits for activation to settle: the operator
          // asked for it now, and the phases (fetch, stage, validate, activate)
          // are the slow part the status line already narrates.
          const settled = await outcome.done;
          if (settled.result.ok) void this.retain().catch(() => {});
          return {
            lines,
            outcome: formatHandover(settled.result, { from, to, action: "Updated" }).replace(/^Pi Engineering\n\n/, ""),
            ok: settled.result.ok,
          };
        }
        return { lines, outcome: formatOutcome(outcome), ok: outcome.status === "up_to_date" };
      },
    };
  }

  /** Publish the update seam for the legacy `/update` command. */
  private publishBridge(): void {
    this.bridgeRef = this.updateBridge();
    setRuntimeUpdateBridge(this.bridgeRef);
  }

  /** Withdraw it, but never a bridge a newer Host already published. */
  private withdrawBridge(): void {
    if (this.bridgeRef !== undefined && runtimeUpdateBridge() === this.bridgeRef) setRuntimeUpdateBridge(undefined);
    this.bridgeRef = undefined;
  }

  private async installSteps(pi: ExtensionAPI): Promise<void> {
    this.pi = pi;
    this.publishBridge();
    const host = new RuntimeHost({ pi, generationsDir: this.generationsDir, telemetry: this.telemetry });
    this.host = host;
    host.bridge.registerHostCommand("engineering", {
      description:
        "Pi Engineering runtime: reload | update | rollback [--yes] | version | cancel (and runtime subcommands)",
      handler: (args, ctx) => this.command(args, ctx as Ctx),
    });
    // `/pie <anything>`: one short name for everything pi-engineering
    // registers. Host subcommands first (`/pie update`, `/pie reload`), then
    // any command of the running generation (`/pie mission status` is
    // `/mission status`), then the runtime's own `/engineering` subcommands.
    host.bridge.registerHostCommand("pie", {
      description:
        "pi-engineering: update | reload | version | rollback | status | cancel, or any pi-engineering command (/pie mission …)",
      getArgumentCompletions: (prefix: string) => this.pieCompletions(prefix),
      handler: (args, ctx) => this.pie(args, ctx as Ctx),
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
    if (result.ok) this.unpublishMaintenance = publishHostMaintenance(this.maintenanceProvider());
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
    this.withdrawBridge();
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
    this.host?.pendingTask()?.cancel();
    this.unpublishMaintenance();
    await this.stopSourceWatch();
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
    this.startSourceWatch(ctx);
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

  /** The HEAD watcher behind automatic hot reload (one per session; see sourceWatch.ts). */
  sourceWatcher: SourceWatcher | undefined;

  /**
   * Watch the checkout Pi loads from and hand over to it when its HEAD moves.
   * A "true" hot reload: same process, same conversation, new code — the
   * `/pie reload` handover, triggered by the merge instead of by hand. The
   * baseline is the running generation's commit, so a checkout that moved
   * between process start and this session reloads on the first poll.
   */
  private startSourceWatch(ctx: Ctx): void {
    if (this.sourceWatcher || this.config.autoReload !== true || !this.host) return;
    const host = this.host;
    const source = this.reloadSource();
    // An installed version only changes through an update, which hands over
    // itself; only a live checkout can move underneath a running Pi.
    if (source.label.startsWith("installed:") || !existsSync(join(source.root, ".git"))) return;
    const root = source.root;
    // A checkout tracking a remote (a session on another host, cloned from
    // GitHub) is brought up to it first, every followRemoteIntervalMs; a
    // fast-forward moves HEAD and the poll below turns it into the reload.
    // Fetch failures are silence (checkForUpdate never throws), and the local
    // checkout the operator merges into is left alone: ahead of or diverged
    // from its upstream it is never touched.
    const followEvery = this.config.followRemoteIntervalMs ?? DEFAULT_FOLLOW_REMOTE_INTERVAL_MS;
    let lastFollowAt = Number.NEGATIVE_INFINITY;
    // The commit a dirty-tree warning was given for, so it is said once per
    // commit rather than every poll until the tree is clean.
    let dirtyWarnedFor: string | undefined;
    const fingerprint = async (): Promise<string | null> => {
      // Not while a handover runs: its snapshot must not see the tree move.
      if (this.config.followRemote === true && !host.pendingTask() && Date.now() - lastFollowAt >= followEvery) {
        lastFollowAt = Date.now();
        const result = await followRemote(root);
        if (result.applied) {
          const latest = (host.latestContext() as Ctx | undefined) ?? ctx;
          notify(
            latest,
            `Pi Engineering checkout fast-forwarded to ${short(result.head)} (${result.decision.reason}).`,
          );
        }
      }
      return gitHead(root);
    };
    this.sourceWatcher = new SourceWatcher({
      intervalMs: this.config.autoReloadIntervalMs ?? DEFAULT_AUTO_RELOAD_INTERVAL_MS,
      baseline: host.activeGeneration()?.source.commit ?? source.commit ?? null,
      fingerprint,
      onChange: async (next, previous) => {
        // Another handover is in flight, or the session is on its way out:
        // leave the baseline and look again (never, once disposed).
        if (host.pendingTask() || !this.sourceWatcher?.active) return false;
        if (host.activeGeneration()?.source.commit === next) return true;
        const latest = (host.latestContext() as Ctx | undefined) ?? ctx;
        // A handover snapshots the working tree, so a tracked file mid-edit
        // would run under the new commit's name. Wait for a clean tree (or
        // an explicit /pie reload, which is the operator's call), telling
        // them once per commit; the baseline stays put so the commit is
        // picked up the poll after the tree is clean.
        const dirty = await trackedChanges(root);
        if (dirty === null || !this.sourceWatcher?.active) return false;
        if (dirty.length > 0) {
          if (dirtyWarnedFor !== next) {
            dirtyWarnedFor = next;
            const listed = dirty.slice(0, 3).join(", ") + (dirty.length > 3 ? `, +${dirty.length - 3}` : "");
            notify(
              latest,
              `Pi Engineering source moved to ${short(next)} but ${listed} ${dirty.length === 1 ? "has" : "have"} uncommitted changes — not hot-reloading until the tree is clean (or /pie reload).`,
              "warning",
            );
          }
          return false;
        }
        dirtyWarnedFor = undefined;
        // Acceptance means the selected commit passed the full handover.
        // Failed or deferred activation leaves the baseline available for retry.
        const result = await this.reloadForMaintenance({ expectedCommit: next });
        if (result.ok)
          notify(latest, `Pi Engineering source moved ${short(previous)} → ${short(next)} — hot-reloaded.`);
        return result.ok;
      },
      onError: (error) => {
        this.telemetry.emit("runtime.health.failed", {
          failure_reason: `auto-reload watcher: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    });
    this.sourceWatcher.start();
  }

  /** Resolves once a poll in flight (and its git child) has finished. */
  private stopSourceWatch(): Promise<void> {
    const watcher = this.sourceWatcher;
    this.sourceWatcher = undefined;
    return watcher?.dispose() ?? Promise.resolve();
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
        const target = (ctx ?? (this.host?.latestContext() as Ctx | undefined)) as Ctx | undefined;
        if (check.failure) {
          // A check that cannot run has to be seen: silently leaving automatic
          // updates off is how a runtime goes stale without anyone noticing.
          notify(target, `Pi Engineering update check failed: ${check.failure}`, "warning");
        }
        if (check.target && !check.upToDate && !check.failure) {
          try {
            target?.ui?.setStatus?.(
              UPDATE_STATUS_KEY,
              `Pi Engineering ${check.current?.version ?? ""} · ${check.target.metadata.version} available`,
            );
          } catch {
            // A stale ctx cannot show a status; the panel still does.
          }
          if (prefs.autoInstall && check.pi.ok) {
            const to = check.target.metadata.version;
            notify(
              target,
              `Pi Engineering ${check.current?.version ?? "?"} → ${to}: updating automatically (progress in the status line).`,
            );
            const outcome = await this.updates.update({}, updateProgressReporter(target?.ui));
            this.lastUpdateOutcome = outcome;
            if (outcome.status === "handover") {
              void outcome.done.then(({ result }) => {
                clearUpdateStatus(target);
                notify(
                  target,
                  result.ok
                    ? `Pi Engineering ${to} activated.`
                    : `Pi Engineering ${to} did not activate (${result.failure ?? result.phase}): the running runtime was not touched.`,
                  result.ok ? "info" : "warning",
                );
              });
              await outcome.done;
            } else {
              clearUpdateStatus(target);
              notify(target, formatOutcome(outcome), "warning");
            }
          }
        }
        return check;
      } catch (error) {
        // Unexpected here means the operator gets no check at all: say so.
        notify(
          (ctx ?? (this.host?.latestContext() as Ctx | undefined)) as Ctx | undefined,
          `Pi Engineering update check failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
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
  protected lockFor(operation: string, ctx: Ctx, quiet = false): MutationLockHandle | undefined {
    try {
      return this.lock.acquire(operation);
    } catch (error) {
      if (error instanceof MutationLockBusyError) {
        if (!quiet) notify(ctx, error.message, "warning");
        return undefined;
      }
      throw error;
    }
  }

  /** `.pi-eng` of the repository the session works in (git toplevel, else cwd). */
  stateDir(cwd?: string): string | null {
    const dir = cwd ?? (this.host?.latestContext() as Ctx | undefined)?.cwd;
    if (!dir) return null;
    const root = probed("toplevel", dir, null, () => {
      try {
        return safeGitSyncOut(["rev-parse", "--show-toplevel"], { cwd: dir, timeoutMs: 2000 }).trim();
      } catch {
        return dir;
      }
    });
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
    const meta = await describeSourceAsync(root);
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
  protected async repairPointersAfterStart(running: RuntimeSource | undefined): Promise<void> {
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
      commit: meta.commit,
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

  /** Names `/pie <name>` resolves right now: Host subcommands plus the running generation's commands. */
  pieNames(): string[] {
    const generation = this.host?.activeGeneration()?.generation;
    const runtime = generation === undefined ? [] : (this.host?.bridge.generationCommandNames(generation) ?? []);
    return [
      ...HOST_SUBCOMMANDS,
      ...runtime.filter((n) => !HOST_SUBCOMMANDS.has(n) && n !== "pie" && n !== "engineering"),
    ];
  }

  private pieCompletions(prefix: string): AutocompleteItem[] | null {
    const head = (prefix ?? "").trimStart();
    if (/\s/.test(head)) return null;
    const names = this.pieNames().filter((n) => n.startsWith(head));
    return toAutocompleteItems(names.sort());
  }

  /**
   * `/pie <sub> [args]`. Host subcommands and the runtime's `/engineering`
   * subcommands go through `command`; any other name is a pi-engineering
   * command of the running generation, called with the rest of the line.
   */
  async pie(args: string, ctx: Ctx): Promise<void> {
    const host = this.host;
    if (!host) return;
    const trimmed = (args ?? "").trim();
    const [sub = "", ...rest] = trimmed.split(/\s+/).filter(Boolean);
    if (!sub) {
      return notify(
        ctx,
        [
          "usage: /pie <command> [args]",
          `runtime: ${[...HOST_SUBCOMMANDS].join(" | ")}`,
          `commands: ${this.pieNames()
            .filter((n) => !HOST_SUBCOMMANDS.has(n))
            .sort()
            .join(", ")}`,
        ].join("\n"),
      );
    }
    if (HOST_SUBCOMMANDS.has(sub)) return this.command(trimmed, ctx);
    // `/pie engineering <x>` is `/engineering <x>` — the Host's own, which
    // forwards the runtime's subcommands itself.
    if (sub === "engineering") return this.command(rest.join(" "), ctx);
    const generation = host.activeGeneration()?.generation;
    if (generation !== undefined && host.bridge.generationCommand(generation, sub)) {
      // Through the bridge, exactly like `/<sub>` itself: held while a
      // handover's gate is closed, and tracked as an operation so a handover
      // cannot start underneath it.
      host.noteContext(ctx);
      await host.bridge.runCommand(sub, rest.join(" "), ctx);
      return;
    }
    // Not a command of its own: perhaps a subcommand of the runtime's /engineering.
    return this.command(trimmed, ctx);
  }

  async command(args: string, ctx: Ctx): Promise<void> {
    const host = this.host;
    if (!host) return;
    host.noteContext(ctx);
    const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = argv[0] ?? "version";
    switch (sub) {
      case "reload":
        await this.reload(ctx);
        return;
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

  /** Snapshot under the shared install lock; wait and switch under the Host's local mutex. */
  private beginReload(source: RuntimeSource, timeoutMs?: number): HandoverTask {
    const lock = this.lock.acquire("reload");
    try {
      const task = (this.host as RuntimeHost).begin({
        kind: "reload",
        source,
        safePointTimeoutMs: timeoutMs ?? this.config.safePointTimeoutMs ?? DEFAULT_SAFE_POINT_TIMEOUT_MS,
        hooks: {
          onPhase: (phase) => {
            if (phase === "waiting_safe_point") lock.release();
          },
        },
      });
      void task.promise.finally(() => lock.release());
      return task;
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  private maintenanceProvider(): HostMaintenanceProvider {
    return {
      describe: async () => {
        const active = this.host?.activeGeneration();
        return {
          hostCommit: this.hostCommit,
          commit: active?.source.commit ?? null,
          generation: active?.generation ?? null,
          capabilities: ["runtime.describe", "runtime.reload"],
          pending: this.host?.pendingTask() != null,
        };
      },
      reload: (request) => this.reloadForMaintenance(request),
    };
  }

  private async reloadForMaintenance(request: HostMaintenanceReloadRequest): Promise<HostMaintenanceReloadResult> {
    const outcome = (ok: boolean, error?: string): HostMaintenanceReloadResult => ({
      ok,
      commit: this.host?.activeGeneration()?.source.commit ?? null,
      generation: this.host?.activeGeneration()?.generation ?? null,
      ...(error ? { error } : {}),
    });
    let rebindWatcher = false;
    try {
      if (!/^[0-9a-f]{40}$/.test(request.expectedCommit))
        return outcome(false, "expectedCommit must be a full lowercase commit SHA");
      if (
        request.timeoutMs !== undefined &&
        (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 300_000)
      ) {
        return outcome(false, "timeoutMs must be between 1 and 300000");
      }
      if (request.sourceRoot !== undefined && !isAbsolute(request.sourceRoot))
        return outcome(false, "sourceRoot must be absolute");
      const source = request.sourceRoot
        ? {
            root: request.sourceRoot,
            entry: declaredEntry(request.sourceRoot) ?? this.config.entry,
            ...describeSource(request.sourceRoot),
            label: "package",
          }
        : this.reloadSource();
      if (source.commit !== request.expectedCommit)
        return outcome(false, "source commit does not match expectedCommit");
      if (!existsSync(join(source.root, ".git"))) return outcome(false, "exact activation requires a Git checkout");
      const dirty = await trackedChanges(source.root);
      if (dirty === null || dirty.length) return outcome(false, "source checkout must be readable and clean");
      if (this.host?.pendingTask()) return outcome(false, "runtime handover already in progress");
      if (request.sourceRoot && source.root !== this.host?.activeGeneration()?.source.root) {
        rebindWatcher = true;
        await this.stopSourceWatch();
      }
      const task = this.beginReload({ ...source, snapshotCommit: request.expectedCommit }, request.timeoutMs);
      const result = await task.promise;
      if (!result.ok || !result.health?.healthy)
        return outcome(false, result.failure ?? "runtime handover did not pass health");
      if (this.host?.activeGeneration()?.source.commit !== request.expectedCommit)
        return outcome(false, "loaded commit does not match expectedCommit");
      if (typeof this.pi?.sendMessage === "function") {
        this.pi.sendMessage(
          {
            customType: "pi-engineering-maintenance",
            content: `Pi Engineering has loaded verified runtime ${request.expectedCommit}. Existing mission IDs and preserved work remain authoritative. If this update belongs to a fleet rollout, let its coordinator resume eligible stopped missions and monitor status instead of issuing competing resume/cancel requests. Otherwise continue recovery using the existing mission ID. Never create duplicate missions or override operator pauses.`,
            display: true,
            details: {
              kind: "runtime-activated",
              commit: request.expectedCommit,
              generation: this.host.activeGeneration()?.generation ?? null,
            },
          },
          { triggerTurn: false },
        );
      }
      return outcome(true);
    } catch (error) {
      return outcome(false, error instanceof Error ? error.message : String(error));
    } finally {
      if (rebindWatcher) this.startSourceWatch((this.host?.latestContext() as Ctx | undefined) ?? {});
    }
  }

  /** Interactive reload reports waits immediately; completion remains the task's result. */
  protected async reload(ctx: Ctx): Promise<boolean> {
    const host = this.host as RuntimeHost;
    const source = this.reloadSource();
    let task: HandoverTask;
    try {
      task = this.beginReload(source);
    } catch (error) {
      if (error instanceof RuntimeBusyError || error instanceof MutationLockBusyError) {
        notify(ctx, error.message);
        return false;
      }
      throw error;
    }
    const from = host.activeGeneration()?.source.version;
    const result = await this.awaitOrBackground(task, ctx, `Reloading Pi Engineering ${source.version}.`, (r) =>
      formatHandover(r, { from, to: source.version, action: "Reloaded" }),
    );
    if (result) notify(ctx, formatHandover(result, { from, to: source.version, action: "Reloaded" }), level(result));
    return result?.ok === true;
  }

  /**
   * Running from a checkout whose HEAD is no longer the running generation's
   * commit: the update the operator wants is a reload of that checkout, not
   * an install from the remote. Null when the running code is current.
   */
  checkoutMoved(): { root: string; from: string | null; to: string } | null {
    const active = this.host?.activeGeneration();
    if (!active || active.source.label.startsWith("installed:")) return null;
    const source = this.reloadSource();
    if (!existsSync(join(source.root, ".git")) || !source.commit) return null;
    if (source.commit === active.source.commit) return null;
    return { root: source.root, from: active.source.commit, to: source.commit };
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
    // The local-checkout workflow: a merge landed on the branch Pi loads
    // from. That IS the update; hand over to it (the watcher would within
    // one poll, this does it now) instead of asking the remote.
    const moved = this.checkoutMoved();
    const movedLine = moved ? `Checkout moved ${short(moved.from)} → ${short(moved.to)}` : null;
    if (parsed.check) {
      // --check still asks the remote; a local move is reported alongside.
      const check = await this.updates.check(parsed.request);
      const lines = [...(movedLine ? [`${movedLine}; /pie update reloads it (remote not consulted then).`] : [])];
      return notify(ctx, [...lines, formatCheck(check)].join("\n"), check.failure ? "warning" : "info");
    }
    if (moved && !parsed.request.commit && !parsed.request.channel) {
      notify(
        ctx,
        `${movedLine} — hot-reloading the local checkout (remote not consulted; --channel/--commit for that).`,
      );
      await this.reload(ctx);
      return;
    }
    const progress: string[] = [];
    const report = updateProgressReporter(ctx.ui);
    const outcome = await this.updates.update(parsed.request, (line) => {
      progress.push(line);
      report(line);
    });
    this.lastUpdateOutcome = outcome;
    const steps = progress.length > 0 ? ["", ...progress] : [];
    if (outcome.status !== "handover") {
      clearUpdateStatus(ctx);
      return notify(
        ctx,
        [...(movedLine ? [movedLine, ""] : []), ...steps, formatOutcome(outcome)].join("\n"),
        "warning",
      );
    }
    const from = outcome.check.current?.version;
    const to = outcome.check.target?.metadata.version;
    const header = [`Pi Engineering ${from ?? "?"} → ${to ?? "?"}`, "", ...progress];
    const format = (r: HandoverResult) =>
      [...header, formatHandover(r, { from, to, action: "Updated" }).replace(/^Pi Engineering\n\n/, "")].join("\n");
    // The status line keeps saying what it is waiting for until activation ends.
    void outcome.done.then(({ result: r }) => {
      clearUpdateStatus(ctx);
      if (r.ok) void this.retain().catch(() => {});
    });
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
        const list = (paths: string[]) => [
          ...paths.slice(0, 20).map((p) => `  ${p}`),
          ...(paths.length > 20 ? [`  … and ${paths.length - 20} more`] : []),
        ];
        const newer = new Set(plan.loss.paths);
        const older = plan.loss.replaced.filter((p) => !newer.has(p));
        return notify(
          ctx,
          [
            `Rolling back to ${plan.target.version} restores the state checkpoint taken before schema ${plan.migration.from} and discards these files written since the update (${plan.loss.since}):`,
            ...list(plan.loss.paths),
            ...(older.length > 0
              ? [
                  "",
                  "It also returns these files (written by the update itself) to their pre-update content:",
                  ...list(older),
                ]
              : []),
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

/** Status line key for live update progress (automatic check included). */
const UPDATE_STATUS_KEY = "pi-engineering-update";

/**
 * Live update progress: every step the updater reports goes on the status line
 * as it happens, so a fetch -> stage -> validate -> activate run that takes
 * tens of seconds is visible while it runs instead of arriving only in the
 * final message (or, for the automatic run, not at all).
 */
export function updateProgressReporter(ui: Ctx["ui"]): (line: string) => void {
  return (line: string) => {
    try {
      ui?.setStatus?.(UPDATE_STATUS_KEY, `Pi Engineering update · ${line}`);
    } catch {
      // A stale ctx cannot show a status; the final notification still says it.
    }
  };
}

/** Take the update status line back once a run is over. */
export function clearUpdateStatus(ctx: Ctx | undefined): void {
  try {
    ctx?.ui?.setStatus?.(UPDATE_STATUS_KEY, undefined);
  } catch {
    // A stale ctx cannot clear a status.
  }
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
