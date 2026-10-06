import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const execFileAsync = promisify(execFile);
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveMemoryEnvironment } from "../src/blackhole/connectionSetup.ts";
import { openVikingBlackholeOption } from "../src/blackhole/envConfig.ts";
import { registerInteractiveMemory } from "../src/blackhole/interactiveMemory.ts";
import { registerAutoCompaction } from "../src/compaction/autoTune.ts";
import { type InferweaveProvider, createInferweaveProvider, inferweaveConfigFromEnv } from "../src/context/provider.ts";
import { contextReading, planModelSwitch } from "../src/context/usage.ts";
import { AfterOutputRetry } from "../src/gateway/afterOutputRetry.ts";
import { sharedAdmissionController, sharedGatewayConfig } from "../src/gateway/config.ts";
import {
  type FallbackApplyDeps,
  type FallbackContext,
  FallbackCoordinator,
  applyPendingFallback,
} from "../src/gateway/fallbackLifecycle.ts";
import {
  installGatewayStreamRetry,
  installedGatewayStreamRetries,
  isGatewayStreamRetryLive,
} from "../src/gateway/installStreamRetry.ts";
import {
  describeGatewayWait,
  gatewayHoldScope,
  isAccountWideRefusal,
  parseGatewayWait,
} from "../src/gateway/signals.ts";
import { renderGatewayReport } from "../src/gateway/statusReport.ts";
import { GitRepo } from "../src/git/GitRepo.ts";
import { GenerationGuard } from "../src/guard/GenerationGuard.ts";
import { RECOVERY_PROMPT, TOOL_TRANSITION_RULE, buildDegenerationEvent } from "../src/guard/RecoveryController.ts";
import { resolveGuardConfig } from "../src/guard/config.ts";
import { guardFeedFor } from "../src/guard/streamText.ts";
import { registerToolCallGuard } from "../src/guard/toolCallGuard.ts";
import { ModelHealthProvider } from "../src/models/health.ts";
import { defaultModelsPath, providerBaseUrl, readModelsConfig } from "../src/models/modelsConfig.ts";
import { refreshConfiguredProviders } from "../src/models/refresh.ts";
import { decideAutoInvoke, missionToolReportedUnavailable } from "../src/orchestration/autoInvoke.ts";
import { PanelController } from "../src/panel/PanelController.ts";
import { PanelState } from "../src/panel/PanelState.ts";
import { readCommitContent, readDiffContent, readFileContent } from "../src/panel/content.ts";
import { LedgerFeeder } from "../src/panel/feeders/LedgerFeeder.ts";
import { MemoryFeeder } from "../src/panel/feeders/MemoryFeeder.ts";
import { DEFAULT_WORKSPACE_TTL_MS, WorkspaceFeeder } from "../src/panel/feeders/WorkspaceFeeder.ts";
import { type PanelLayout, type PanelLayoutPatch, PanelLayoutStore } from "../src/panel/layout.ts";
import { Narrator } from "../src/panel/narrator/Narrator.ts";
import { createSummarize } from "../src/panel/narrator/summarize.ts";
import { PanelRefreshLoop } from "../src/panel/refreshLoop.ts";
import { registerPlannerWorker } from "../src/plannerWorker/extension.ts";
import { redactSecrets } from "../src/platform/redact.ts";
import { resolveRequestBodyBudgetConfig } from "../src/request/bodyBudget.ts";
import { resolveThinkingOffConfig } from "../src/request/thinkingPolicy.ts";
import { RoadmapEngine } from "../src/roadmap/RoadmapEngine.ts";
import { EngineeringRuntime, type RuntimeMissionActivityEvent } from "../src/runtime/EngineeringRuntime.ts";
import { sessionBindingInfo } from "../src/runtime/isolation/RuntimeBinding.ts";
import { RuntimeSession } from "../src/runtime/isolation/RuntimeSession.ts";
import { effectiveWorkspace, workspaceForPath } from "../src/runtime/isolation/WorkspaceResolver.ts";
import { formatDoctorReport, runDoctor } from "../src/runtime/isolation/doctor.ts";
import { emitRuntimeEvent } from "../src/runtime/isolation/runtimeEvents.ts";
import { formatRuntimeStatus, runtimeStatus } from "../src/runtime/isolation/status.ts";
import {
  type MissionBrief,
  type SessionControlServer,
  startSessionControl,
} from "../src/sessionControl/SessionControl.ts";
import { resolveStatusBarConfig } from "../src/status/config.ts";
import { FooterController } from "../src/status/footer.ts";
import { renderStatus } from "../src/status/layout.ts";
import { type TelemetryNotice, emitTelemetry, setTelemetrySink } from "../src/telemetry/sink.ts";
import { createRepeatThrottle } from "../src/telemetry/throttle.ts";
import { type CoreServices, buildCoreTools } from "../src/tools/coreTools.ts";
import { checkForUpdate, shouldCheck } from "../src/update/selfUpdate.ts";
import { describeUpdate } from "../src/update/versionCheck.ts";
import { CommandVerifier } from "../src/verify/Verifier.ts";
import { PiWorkerExecutor } from "../src/workers/PiWorkerExecutor.ts";

/**
 * pi-engineering-runtime — extension entry point.
 *
 * Registers the explicit interactive command surface (`/engineer`, `/review`,
 * `/challenge`, `/verify`, `/ledger`, `/context`) and the semantic tools
 * (`ledger_read`, `ledger_claim`, `artifact_read`, `repo_search`, `symbol`,
 * `tests_for`). Normal Pi coding needs no command; `/engineer` runs the full
 * adaptive workflow on demand.
 *
 * All state lives on disk (ledger + artifacts), so nothing depends on a
 * transcript surviving (INV-001).
 */

const runtimes = new Map<string, { runtime: EngineeringRuntime; memoryIdentity: string }>();
interface RuntimeOpen {
  generation: number;
  promise: Promise<{ runtime: EngineeringRuntime; memoryIdentity: string }>;
}
const runtimeOpens = new Map<string, RuntimeOpen>();
let runtimeShutdownGeneration = 0;
let runtimeShutdownFlight: Promise<void> | null = null;
const allowRuntimeDiagnostic = createRepeatThrottle();

// Live status bar: the harness owns the Pi footer through a single composable
// controller (src/status/). One active controller per session.
const statusBarConfig = resolveStatusBarConfig();
let activeFooter: FooterController | null = null;
/** Subscriptions bound to the session's lifetime (drained on shutdown). */
const sessionUnsubscribes: Array<() => void> = [];

// The engineering panel: one state + feeders per repository (keyed like the
// runtime cache), and one controller per interactive session.
interface PanelPlumbing {
  state: PanelState;
  ledger: LedgerFeeder;
  workspace: WorkspaceFeeder;
  memory: MemoryFeeder;
}
const panels = new Map<string, PanelPlumbing>();

/**
 * The panel state the footer's ambient row reads, with the repository it
 * belongs to.
 *
 * Tracked separately from `panels` because the footer is built at session start
 * and has no repository key yet — the key arrives from an async lookup that
 * finishes later.
 *
 * The key is carried alongside because `panels` is process-wide: without it a
 * footer opened in one repository would keep summarising whichever repository
 * most recently built plumbing, and a summary attributed to the wrong tree is
 * worse than none.
 */
let ambientPanel: { key: string; state: PanelState } | undefined;
let activePanel: PanelController | null = null;

/** Removes this session's telemetry sink. */
let telemetryUninstall: (() => void) | undefined;
/** Layout is an operator preference, so one store for the whole process. */
const panelLayoutStore = new PanelLayoutStore();

/**
 * Periodic refresh while the panel is visible.
 *
 * Paced at the workspace feeder's own TTL: faster would re-run git only to get
 * the cached answer back, slower would leave the TTL unreachable. The loop
 * itself lives in src/panel/refreshLoop.ts so its start/stop/restart behaviour
 * is testable without counting the process's timers.
 */
let panelRefresh: PanelRefreshLoop | null = null;

function startPanelRefresh(plumbing: PanelPlumbing): void {
  // A new loop each time, so a new session never inherits the previous
  // session's repository.
  panelRefresh?.stop();
  panelRefresh = new PanelRefreshLoop({
    intervalMs: DEFAULT_WORKSPACE_TTL_MS,
    tick: () => {
      plumbing.workspace.invalidate();
      void plumbing.workspace.refresh();
      plumbing.ledger.refresh();
      // Memory counters went stale for as long as the panel stayed open, which
      // is now the whole session.
      plumbing.memory.refresh();
    },
  });
  panelRefresh.start();
}

function stopPanelRefresh(): void {
  panelRefresh?.stop();
  panelRefresh = null;
}
/**
 * Panel input subscriptions, kept separate from `sessionUnsubscribes` on
 * purpose: the footer's `session_start` drains its own array, and a shared
 * array would make "does the hotkey still work?" depend on the order two
 * independent handlers happen to be registered in.
 */
const panelUnsubscribes: Array<() => void> = [];

/** Panel plumbing for a repo, created on first use. */
function panelFor(key: string, rt: EngineeringRuntime): PanelPlumbing {
  const existing = panels.get(key);
  if (existing) {
    ambientPanel = { key, state: existing.state };
    return existing;
  }
  const state = new PanelState();
  const created: PanelPlumbing = {
    state,
    ledger: new LedgerFeeder({ ledger: rt.ledger, state }),
    workspace: new WorkspaceFeeder({ state, repo: rt.git }),
    memory: new MemoryFeeder({ state, blackhole: rt.blackhole }),
  };
  panels.set(key, created);
  ambientPanel = { key, state };
  return created;
}

// InferWeave capability integration (docs/specs/dynamic-context-capabilities).
// One provider + one capability client per process: a fan-out of subagents must
// not become a stampede on the gateway's /v1/models. Disabled unless
// INFERWEAVE_BASE_URL is set, so the harness stays inert without a gateway.
const inferweaveConfig = inferweaveConfigFromEnv();
const inferweave: InferweaveProvider | null = inferweaveConfig.enabled
  ? createInferweaveProvider(inferweaveConfig)
  : null;

async function getRuntime(ctx: ExtensionCommandContext, worker?: EngineeringRuntime): Promise<EngineeringRuntime> {
  return getRuntimeByCwd(worker ? worker.cwd : runtimeCwd(ctx.cwd), ctx.model);
}

/**
 * The directory whose runtime serves a launch cwd. After a parent-directory
 * launch rebinds to a nested worktree (spec §2/§3), the launch cwd resolves to
 * that worktree; otherwise to itself.
 */
function runtimeCwd(cwd: string): string {
  return effectiveWorkspace(cwd, RuntimeSession.current().binding?.worktreePath);
}

const workspaceRebinds = new Map<string, Promise<void>>();

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Rebind the session when activity (a tool's `path`) shows work moving into a
 * different git worktree beneath the launch directory. The destination runtime
 * is opened (resolved, registered, migrated) BEFORE the session pointer moves,
 * and the move itself is one registry transaction; any failure leaves the
 * current binding in force.
 */
function observeWorkspaceActivity(cwd: string, args: unknown): Promise<void> {
  const path = args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || !path.trim()) return Promise.resolve();
  const flight = (async () => {
    const session = RuntimeSession.current();
    const launchKey = canonicalPath(await repoCacheKey(cwd).catch(() => cwd));
    const target = await workspaceForPath(cwd, path, session.binding?.worktreePath ?? null);
    // Never rebind back onto the launch directory's own worktree: in a parent
    // launch that worktree is the container, not the project being worked on.
    if (!target || target.worktreeRoot === launchKey) return;
    const existing = workspaceRebinds.get(target.worktreeId);
    if (existing) return existing;
    const rebind = (async () => {
      // Destination first: resolved, registered, migrated and open.
      const runtime = await getRuntimeByCwd(target.worktreeRoot);
      // Flush the current binding's pending writes so nothing is in flight
      // across the switch.
      const previous = session.binding?.worktreeId;
      for (const entry of runtimes.values()) {
        if (previous && entry.runtime.runtimeBinding?.identity.worktreeId === previous) {
          await entry.runtime.missionStore?.flush();
        }
      }
      if (runtime.runtimeBinding) session.bindTo(sessionBindingInfo(runtime.runtimeBinding));
    })().finally(() => workspaceRebinds.delete(target.worktreeId));
    workspaceRebinds.set(target.worktreeId, rebind);
    return rebind;
  })().catch((error: unknown) => {
    emitRuntimeEvent("runtime.rebind_failed", {
      session_id: RuntimeSession.current().sessionId,
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  });
  workspaceActivity.add(flight);
  void flight.finally(() => workspaceActivity.delete(flight));
  return flight;
}

const workspaceActivity = new Set<Promise<void>>();

/** Wait for in-flight workspace rebinding (tests and orderly shutdown). */
export async function settleWorkspaceActivity(): Promise<void> {
  while (workspaceActivity.size > 0) await Promise.allSettled([...workspaceActivity]);
}

/**
 * Open (or reuse) the runtime for a working directory, lazily.
 *
 * The cache is keyed by the repository ROOT (git toplevel), not the raw cwd:
 * two cwd strings that point into the same repo (e.g. `<repo>` and
 * `<repo>/src`) must share ONE runtime/ledger view, otherwise each holds a
 * stale in-memory ledger over the same shared `.pi-eng/ledger.jsonl` file.
 */
async function getRuntimeByCwd(cwd: string, model?: Model<any>): Promise<EngineeringRuntime> {
  if (runtimeShutdownFlight) await runtimeShutdownFlight;
  const openGeneration = runtimeShutdownGeneration;
  const key = await repoCacheKey(cwd);
  if (runtimeShutdownFlight) await runtimeShutdownFlight;
  if (openGeneration !== runtimeShutdownGeneration) {
    throw new Error("Runtime request was superseded by session shutdown");
  }
  const blackhole = openVikingBlackholeOption(resolveMemoryEnvironment());
  const memoryIdentity = createHash("sha256")
    .update(JSON.stringify(blackhole ?? null))
    .digest("hex");
  const existing = runtimes.get(key);
  if (existing?.memoryIdentity === memoryIdentity) return existing.runtime;
  const pending = runtimeOpens.get(`${key}\0${memoryIdentity}`);
  if (pending) {
    const opened = await pending.promise;
    if (pending.generation !== runtimeShutdownGeneration) {
      throw new Error("Runtime open was superseded by session shutdown");
    }
    return opened.runtime;
  }
  // OpenViking connection from the environment. If PI_OPENVIKING_BASE_URL is
  // set, blackhole is enabled with the openviking durable store for EVERY repo
  // this extension runs in — set it once per install and all repos share the
  // deployed durable memory. Absent the env, blackhole stays off (unchanged).
  const opening = EngineeringRuntime.open({
    cwd,
    verifier: new CommandVerifier(),
    model,
    // Autonomous stop (roadmap spec §13, §33): when this repository's Roadmap
    // 1.0 is complete, /engineer refuses to invent new work. The gate is derived
    // from the roadmap engine (completion is never declared). If the repo has no
    // roadmap, the gate is open.
    roadmapComplete: roadmapCompleteFor(key),
    onMissionSnapshotError: (message) => {
      const notice: TelemetryNotice = {
        level: "warning",
        text: message,
        key: `mission-snapshot-write:${key}`,
      };
      if (allowRuntimeDiagnostic(notice)) emitTelemetry(notice);
    },
    onMissionActivity: (event) => publishMissionActivity(key, event),
    // Pipeline progress -> status footer. Best-effort and read-only: the
    // runtime swallows anything thrown here, and the footer is the only
    // consumer today (the panel will subscribe to the same events).
    onPhase: (event) => {
      // One event source, two surfaces: the footer summarises, the panel details.
      panels.get(key)?.ledger.onPhase(event);
      const footer = activeFooter;
      if (!footer) return;
      if (event.phase === "settled") {
        // Guarded: concurrent runs (tournament legs, DAG waves) each settle.
        footer.clearTask(event.workItemId);
        footer.setProducingModel(undefined);
        return;
      }
      footer.setTask({
        workItemId: event.workItemId,
        phase: event.phase,
        ...(event.goal ? { label: event.goal } : {}),
      });
      if (event.model) footer.setProducingModel(event.model);
    },
    ...(blackhole ? { blackhole } : {}),
  }).then((runtime) => ({ runtime, memoryIdentity }));
  const openKey = `${key}\0${memoryIdentity}`;
  const entry: RuntimeOpen = { generation: openGeneration, promise: opening };
  runtimeOpens.set(openKey, entry);
  try {
    const opened = await opening;
    if (openGeneration !== runtimeShutdownGeneration) {
      throw new Error("Runtime open was superseded by session shutdown");
    }
    runtimes.set(key, opened);
    panelFor(key, opened.runtime);
    return opened.runtime;
  } finally {
    if (runtimeOpens.get(openKey) === entry && openGeneration === runtimeShutdownGeneration) {
      runtimeOpens.delete(openKey);
    }
  }
}

/** Feed live mission detail into persistent surfaces without creating notices. */
export function formatMissionActivity(event: RuntimeMissionActivityEvent): {
  phase: string;
  detail: string;
  missionStatus: { token: string; reason: string; next: string };
} {
  const heartbeat = event.lastHeartbeatAt ? ` · hb ${new Date(event.lastHeartbeatAt).toISOString().slice(11, 19)}` : "";
  const workers = ` · workers ${event.activeWorkers} active/${event.waitingWorkers} waiting/${event.failedWorkers} failed`;
  const lastProgress = event.lastMeaningfulProgressAt ?? "none";
  const compact = (value: string | null, fallback: string, length = 80) => (value ?? fallback).slice(0, length);
  const scope =
    `repo ${compact(event.repository, "unknown")} · task ${compact(event.task, "none")} · ` +
    `owner ${compact(event.owner, "unowned")}`;
  const recovery = `recovery ${event.recovery.attempt}/${event.recovery.maxAttempts}`;
  const next = `next ${event.nextAction.slice(0, 120)}${event.nextActionAt ? ` at ${event.nextActionAt}` : ""}`;
  const preserved =
    event.preservedWork.length > 0 ? ` · preserved ${event.preservedWork.join(", ").slice(0, 120)}` : "";
  const nextVerb = event.nextAction.trim().split(/\s+/)[0]?.slice(0, 12) || "monitor";
  const recoveryToken =
    event.recovery.maxAttempts > 0 ? `R${event.recovery.attempt}/${event.recovery.maxAttempts}` : "R–";
  const token = `${recoveryToken} ${event.action.slice(0, 12).toUpperCase()}→${nextVerb}`;
  return {
    phase:
      `acceptance ${event.acceptanceCoverage.completed}/${event.acceptanceCoverage.total} ` +
      `(${event.acceptanceCoverage.approximatePercent}%) · workflow ${event.workflowProgress.completed}/` +
      `${event.workflowProgress.total} (${event.workflowProgress.approximatePercent}%) · ${event.health}`,
    detail:
      `${event.summary.slice(0, 120)}${workers}${heartbeat} · ${scope} · last progress ${lastProgress} · ` +
      `${recovery}${preserved} · ${event.action}: ${event.reason.slice(0, 120)} · ${next}`,
    missionStatus: {
      token,
      reason: event.reason.slice(0, 160),
      next: `${event.nextAction.slice(0, 160)}${event.nextActionAt ? ` at ${event.nextActionAt}` : ""}`,
    },
  };
}

/** Feed live mission detail into persistent surfaces without creating notices. */
function publishMissionActivity(key: string, event: RuntimeMissionActivityEvent): void {
  const rendered = formatMissionActivity(event);
  const detail = rendered.detail.slice(0, 640);
  const plumbing = panels.get(key);
  if (plumbing) {
    const previous = plumbing.state.snapshot.run;
    const sameMission = previous?.workItemId === event.missionId;
    plumbing.state.set({
      run: {
        workItemId: event.missionId,
        goal: detail,
        phase: rendered.phase,
        risk: "mission",
        files: sameMission ? previous.files : [],
        findings: sameMission ? previous.findings : [],
        spend: sameMission ? previous.spend : [],
        missionStatus: rendered.missionStatus,
      },
      updatedAt: Date.now(),
    });
  }
  if (ambientPanel?.key !== key) return;
  activeFooter?.setTask({
    workItemId: event.missionId,
    phase: rendered.phase,
    label: detail,
    missionStatus: rendered.missionStatus,
  });
}

function shutdownCachedRuntimes(): Promise<void> {
  if (runtimeShutdownFlight) return runtimeShutdownFlight;
  runtimeShutdownGeneration++;
  const openedEntries = [...runtimes.entries()];
  const pendingEntries = [...runtimeOpens.entries()];
  const shutdown = (async () => {
    const opened = openedEntries.map(([, entry]) => entry.runtime);
    const failures: unknown[] = [];
    const pendingResults = await Promise.allSettled(pendingEntries.map(([, entry]) => entry.promise));
    for (const result of pendingResults) {
      if (result.status === "fulfilled") opened.push(result.value.runtime);
      else failures.push(result.reason);
    }
    const unique = [...new Set(opened)];
    const closeResults = await Promise.allSettled(unique.map((runtime) => runtime.close()));
    for (const [index, result] of closeResults.entries()) {
      const runtime = unique[index];
      if (!runtime) continue;
      if (result.status === "rejected") {
        failures.push(result.reason);
        continue;
      }
      for (const [key, entry] of openedEntries) {
        if (entry.runtime === runtime && runtimes.get(key) === entry) runtimes.delete(key);
      }
      for (const [pendingIndex, [key, entry]] of pendingEntries.entries()) {
        const pending = pendingResults[pendingIndex];
        if (pending?.status === "fulfilled" && pending.value.runtime === runtime && runtimeOpens.get(key) === entry) {
          runtimeOpens.delete(key);
        }
      }
    }
    for (const [index, [key, entry]] of pendingEntries.entries()) {
      if (pendingResults[index]?.status === "rejected" && runtimeOpens.get(key) === entry) runtimeOpens.delete(key);
    }
    if (failures.length > 0) {
      const detail = failures.map((error) => (error instanceof Error ? error.message : String(error))).join("; ");
      throw new AggregateError(failures, `Failed to shut down cached engineering runtimes: ${detail}`);
    }
  })();
  const flight = shutdown.finally(() => {
    if (runtimeShutdownFlight === flight) runtimeShutdownFlight = null;
  });
  runtimeShutdownFlight = flight;
  return flight;
}

/**
 * Returns a callback reporting whether the repository's Roadmap 1.0 is complete.
 * Returns false (gate open) when the repo has no roadmap definition or the engine
 * cannot be built (so normal engineering is never blocked by a broken setup).
 */
function roadmapCompleteFor(repoRoot: string): () => Promise<boolean> {
  const roadmapPath = resolve(repoRoot, "docs/roadmap/roadmap.yaml");
  const manualEvidencePath = resolve(repoRoot, "docs/roadmap/evidence.yaml");
  const evidenceFile = resolve(repoRoot, ".pi-eng/roadmap/evidence.jsonl");
  return async () => {
    try {
      const engine = await RoadmapEngine.open({ repoRoot, roadmapPath, manualEvidencePath, evidenceFile });
      const detail = await engine.evaluate();
      return detail.complete;
    } catch {
      // No/invalid roadmap: gate open (do not block engineering).
      return false;
    }
  };
}

/**
 * Resolved repository keys by cwd.
 *
 * Kept so the footer can ask "which repository is this session?" on the RENDER
 * path, where running git is forbidden. A cwd that has not been resolved yet
 * simply has no answer, and the ambient row stays absent until it does —
 * strictly better than answering with another session's repository.
 */
const repoKeyCache = new Map<string, string>();

/** The resolved key for a cwd, if one has been resolved. Never does IO. */
function cachedRepoKey(cwd: string): string | undefined {
  return repoKeyCache.get(cwd);
}

async function repoCacheKey(cwd: string): Promise<string> {
  const repo = await GitRepo.open(cwd).catch(() => null);
  const key = repo ? repo.root : cwd;
  repoKeyCache.set(cwd, key);
  return key;
}

/** The real reason the runtime did not open, by cwd, for tool results. */
const runtimeOpenFailures = new Map<string, string>();

/**
 * Resolve tools to the runtime for the calling cwd, opening it lazily so the
 * semantic tools work in the interactive session without a prior command.
 */
async function resolveServices(cwd: string): Promise<CoreServices | null> {
  let rt: EngineeringRuntime;
  const effective = runtimeCwd(cwd);
  try {
    rt = await getRuntimeByCwd(effective);
    runtimeOpenFailures.delete(cwd);
  } catch (error) {
    // Concurrency is not a failure mode any more (per-session event streams,
    // automatic stale-owner recovery), so what reaches here is a genuine
    // filesystem/permission problem. Surface the REAL reason — in the tool
    // result too — and never ask the operator to tune internal coordination.
    const message = error instanceof Error ? error.message : String(error);
    runtimeOpenFailures.set(cwd, message);
    const notice: TelemetryNotice = {
      level: "warning",
      text: `Engineering runtime did not open for ${cwd}: ${message}`,
      key: `runtime-open:${cwd}`,
    };
    if (allowRuntimeDiagnostic(notice)) emitTelemetry(notice);
    return null;
  }
  return {
    ledger: rt.ledger,
    artifacts: rt.artifacts,
    broker: rt.broker,
    orchestrator: rt.orchestrator,
    baseRef: () => rt.git?.headCommit().catch(() => "") ?? "",
    currentWorkItemId: () => {
      const w = rt.ledger.listWorkItems().at(-1);
      return w ? w.id : null;
    },
    actor: () => ({ type: "user" }),
    // A rebound parent launch targets the bound worktree by default.
    ...(effective !== cwd ? { repositoryRoot: rt.git?.root ?? effective } : {}),
  };
}

function formatWorkItems(rt: EngineeringRuntime): string {
  const w = rt.ledger.listWorkItems();
  if (w.length === 0) return "No work items yet.";
  const lines = w.map((wi) => {
    const candidates = rt.ledger.listCandidates(wi.id);
    const incumbent = wi.incumbent_candidate_id ? rt.ledger.getCandidate(wi.incumbent_candidate_id) : undefined;
    return `- ${wi.id} [${wi.status}] risk=${wi.risk}\n    goal: ${wi.goal}\n    candidates: ${candidates.length}, incumbent: ${incumbent ? incumbent.id : "none"}`;
  });
  return lines.join("\n");
}

function formatEntities(rt: EngineeringRuntime, kind?: string): string {
  const entities = rt.ledger.listEntities(kind as never);
  if (entities.length === 0) return "No ledger entities yet.";
  return entities
    .slice(-30)
    .map((e) => `- ${e.kind} ${e.id} [${e.status}]${e.severity ? ` (${e.severity})` : ""}: ${e.claim.slice(0, 160)}`)
    .join("\n");
}

export default function (pi: ExtensionAPI) {
  registerInteractiveMemory(pi);
  // One control socket per live PI session. The socket answers directly while
  // a mission tool is awaiting a worker; another PI process never opens this
  // session's transcript or writes its event store to ask for status.
  let activeControl: SessionControlServer | null = null;
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      await activeControl?.close();
      activeControl = null;
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;
      try {
        activeControl = await startSessionControl({
          cwd: ctx.cwd,
          sessionId,
          onNote: ctx.hasUI ? (note) => ctx.ui.notify(`[PI session note] ${redactSecrets(note)}`, "info") : undefined,
          getMissions: async (missionIds) => {
            const runtime = await getRuntimeByCwd(ctx.cwd).catch(() => null);
            if (!runtime?.missionStore) return null;
            return missionIds.flatMap((id): MissionBrief[] => {
              const mission = runtime.missionStore?.getMission(id);
              if (!mission) return [];
              const tasks = runtime.missionStore!.listTasks(id);
              const summary = runtime.missionObservability?.summary(id);
              const failedTask = tasks.filter((task) => task.status === "FAILED").at(-1);
              const reason = failedTask?.failure_reason ?? mission.failure_reason;
              return [
                {
                  id,
                  status: mission.status,
                  health: summary?.health ?? null,
                  lastHeartbeatAt: summary?.lastHeartbeatAt ?? null,
                  lastMeaningfulProgressAt: summary?.lastMeaningfulProgressAt ?? null,
                  tasks: tasks.slice(-40).map((task) => ({ id: task.task_id, status: task.status })),
                  lastError: reason ? redactSecrets(reason).slice(0, 200) : null,
                },
              ];
            });
          },
        });
      } catch (error) {
        ctx.ui.notify(
          `Session status socket unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
          "warning",
        );
      }
    });
    pi.on("tool_execution_start", (event) => activeControl?.toolStarted(event.toolName, event.toolCallId));
    // Parent-directory launches follow the work: a touched path inside a nested
    // worktree rebinds the session there (fire-and-forget; never blocks a tool).
    pi.on("tool_execution_start", (event, ctx) => {
      void observeWorkspaceActivity(ctx.cwd, event.args);
    });
    pi.on("tool_execution_update", (event) => {
      const content = event.toolName === "mission" ? event.partialResult?.content : null;
      const progress = Array.isArray(content) && typeof content[0]?.text === "string" ? content[0].text : undefined;
      activeControl?.toolUpdated(event.toolName, progress, event.toolCallId);
    });
    pi.on("tool_execution_end", (event) => activeControl?.toolEnded(event.toolName, event.toolCallId));
    pi.on("session_shutdown", async () => {
      const previous = activeControl;
      activeControl = null;
      await previous?.close();
    });
  }
  // Semantic tools resolved against the runtime for the calling cwd.
  for (const tool of buildCoreTools(resolveServices, {
    unavailableReason: (cwd) => runtimeOpenFailures.get(cwd) ?? null,
  })) {
    pi.registerTool(tool);
  }

  // ─── Automatic engineering/review workflow invocation (spec 06) ─────────
  // Normal-language intent must auto-invoke the orchestration pipeline without
  // a slash command. We classify the user's prompt with the deterministic
  // IntentRouter and, when it expresses engineering/review intent, inject a
  // message directing the model to use the `mission` semantic tool — the
  // parent session stays the long-lived orchestrator, and the mission tool
  // does the heavy lifting. This is a directive, not enforcement: the runtime
  // completion gate is what actually enforces validation/review/completion.
  // The decision (bare retry/continue, questions, short chat, --print mode, a
  // mission tool that already reported unavailable, low confidence) lives in
  // decideAutoInvoke so it is testable without a pi session.
  let lastAutoInvoked: { prompt: string; at: number } | null = null;
  let missionToolUnavailable = false;
  // The auto-invoke handler uses pi.on(), which is only available in a real pi
  // session (not in the smoke-test stub). Guard accordingly.
  if (typeof pi.on === "function") {
    // Identical-tool-call loops and unbounded bash test/build runs
    // (src/guard/toolCallGuard.ts); PI_TOOL_CALL_GUARD=0 turns it off.
    registerToolCallGuard(pi as never);
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "mission") return;
      const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      if (missionToolReportedUnavailable(text)) missionToolUnavailable = true;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const prompt = (event.prompt ?? "").trim();
      const decision = decideAutoInvoke({
        prompt,
        mode: ctx?.mode,
        missionToolUnavailable,
        lastAutoInvoked,
        now: Date.now(),
      });
      if (!decision.invoke) return;
      lastAutoInvoked = { prompt, at: Date.now() };
      return {
        message: {
          customType: "pi-engineering:auto-invoke",
          content: `[pi-engineering] This request expresses engineering intent (workflow: ${decision.workflow}). Act as the long-lived orchestrator: call the \`mission\` tool with this request as the mission request so the runtime plans, executes, validates, reviews, and completes the work as a mission. Do not implement the change directly in this session; delegate it through the mission pipeline.`,
          display: true,
        },
      };
    });
  }

  // ─── Generation Guard: interactive session (spec §6, §12) ────────────────
  // Monitors streaming output in the main pi session for degeneration loops.
  // On detection, aborts the current turn. The recovery prompt is injected
  // via the next before_agent_start (the user re-submits or the harness
  // auto-retries).
  // The interactive profile drops the pre-action narration budget: in this
  // session the final answer IS prose, and nothing in the stream separates a
  // long answer from narration until the turn is over.
  const interactiveGuardConfig = resolveGuardConfig(undefined, "interactive");
  // The interactive guard uses pi.on() which is only available in a real pi
  // session (not in the smoke-test stub). Guard accordingly.
  if (interactiveGuardConfig.enabled && typeof pi.on === "function") {
    let interactiveGuard: GenerationGuard | null = null;
    let interactiveGuardAborted = false;

    // Reset the guard at the start of each agent turn.
    pi.on("agent_start", async () => {
      interactiveGuard = new GenerationGuard(interactiveGuardConfig);
      interactiveGuardAborted = false;
    });

    // Feed streaming text to the guard.
    pi.on("message_update", async (event, ctx) => {
      if (!interactiveGuard || interactiveGuardAborted) return;
      const msg = event.message as { role?: string; content?: unknown } | undefined;
      if (msg?.role !== "assistant") return;

      // `event.message` is the ACCUMULATED partial message, so feeding it
      // would charge every token once per streaming event. Charge the delta
      // the stream event carries instead (snapshot accounting is the fallback,
      // and diffs internally).
      const feed = guardFeedFor(event, msg.content);
      if (!feed) return;
      const decision =
        feed.kind === "delta" ? interactiveGuard.feed(feed.text) : interactiveGuard.feedSnapshot(feed.text);
      if (decision.abort) {
        interactiveGuardAborted = true;
        // Abort the current generation.
        ctx.abort();
        // Notify the user.
        // Structured telemetry.
        const model = ctx.model
          ? `${(ctx.model as { provider?: string }).provider ?? ""}/${(ctx.model as { id?: string }).id ?? "unknown"}`
          : "unknown";
        const telemetryEvent = buildDegenerationEvent(
          decision.reason!,
          (ctx.model as { id?: string })?.id ?? "unknown",
          "interactive",
          0,
          (decision.diagnostics?.tokens_since_progress as number) ?? 0,
          0,
          decision.diagnostics ?? {},
        );
        // One path, not two. The operator used to get a notify AND a line of
        // raw JSON on stderr saying the same thing — and the stderr line is
        // what tore the frame. The sink installed at session start turns this
        // into the notify; headless it is still a line on stderr.
        emitTelemetry({
          level: "error",
          text: `GenerationGuard: aborted (${decision.reason}). The degenerate output was discarded. Re-submit your prompt to retry with recovery.`,
          ...(process.env.PI_GUARD_TELEMETRY !== "false" ? { detail: telemetryEvent } : {}),
        });
      }
    });

    // Progress events reset the guard counters.
    pi.on("tool_execution_start", async (event) => {
      if (!interactiveGuard || interactiveGuardAborted) return;
      if (event.toolName !== "worker_result") {
        interactiveGuard.onProgress("tool_call");
      }
    });

    // Inject the recovery prompt + Tool Transition Rule after an abort.
    pi.on("before_agent_start", async (event, ctx) => {
      let modified = event.systemPrompt;
      // Always append the Tool Transition Rule to the system prompt (spec §15).
      if (!modified.includes("Tool Transition Rule")) {
        modified = `${modified}

${TOOL_TRANSITION_RULE}`;
      }
      // After an abort, inject the recovery prompt.
      if (interactiveGuardAborted) {
        modified = `${modified}

${RECOVERY_PROMPT}`;
        interactiveGuardAborted = false; // Only inject once.
      }
      if (modified !== event.systemPrompt) {
        return { systemPrompt: modified };
      }
    });
  }

  // ─── Model-gateway backpressure (honour reported waits) ──────────────────
  // Gateways in front of the model report exactly how long to stay away
  // (`retry_after_ms`) and how many concurrent requests they will admit
  // (`active_limit`). Pi's own auto-retry ignores both and backs off
  // exponentially, so the runtime observes the refusals itself and parks every
  // model caller in this process — the worker sessions AND this interactive
  // turn — behind one shared cooldown until the reported wait has elapsed.
  const gatewayConfig = sharedGatewayConfig();

  // ─── Staying current ────────────────────────────────────────────────────
  // An operator hit the exact failure this package had just fixed, and the
  // giveaway was a notice in their session that the fix had DELETED — their Pi
  // was loading a checkout from before the merge, and nothing said so. A fix
  // that is installed but not loaded is worse than an unfixed bug: the evidence
  // the operator reports comes from code that no longer exists.
  //
  // Auto-apply is on by default (PI_SELF_UPDATE=0 disables; PI_SELF_UPDATE=check
  // reports without applying), but only ever as a strict fast-forward on a clean
  // tracking branch — see src/update/versionCheck.ts for what it refuses.
  const selfUpdateMode = (process.env.PI_SELF_UPDATE ?? "auto").toLowerCase();
  const selfUpdateEnabled = selfUpdateMode !== "0" && selfUpdateMode !== "false" && selfUpdateMode !== "off";
  const extensionRoot = resolve(new URL("..", import.meta.url).pathname);
  let lastUpdateCheckAt: number | undefined;

  const runGit = async (args: string[]) => {
    const r = await execFileAsync("git", ["-C", extensionRoot, ...args], { timeout: 30_000 }).catch(
      (err: { code?: number; stdout?: string; stderr?: string; message?: string }) => ({
        code: typeof err.code === "number" ? err.code : 1,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "",
      }),
    );
    return { code: (r as { code?: number }).code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  const runSelfUpdate = async (apply: boolean) => {
    lastUpdateCheckAt = Date.now();
    return checkForUpdate({ cwd: extensionRoot, git: runGit, apply });
  };

  // ─── A clean terminal on the way out ─────────────────────────────────────
  // Pi leaves its last frame on screen at exit, so the shell prompt returns
  // underneath a half-session of transcript. Clearing the visible screen hands
  // the terminal back the way it was found.
  //
  // The SCROLLBACK is deliberately left alone (no `3J`): erasing what the
  // operator did is not tidying, it is destroying the record of a session they
  // may still want to scroll back through or copy from.
  if (typeof pi.on === "function") {
    pi.on("session_shutdown", () => {
      if ((process.env.PI_CLEAR_ON_EXIT ?? "1").toLowerCase() === "0") return;
      // Only a real terminal: writing escape codes into a pipe or a log puts
      // control characters in someone's file.
      if (!process.stdout.isTTY) return;
      try {
        process.stdout.write("\u001b[2J\u001b[H");
      } catch {
        // A cosmetic write is never worth failing a shutdown for.
      }
    });
  }

  // Registered on its own, NOT inside the gateway-admission block: staying
  // current has nothing to do with backpressure, and nesting it there meant
  // PI_GATEWAY_ADMISSION_ENABLED=0 silently switched off update checking too.
  // Found by a fresh-context review.
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      if (!selfUpdateEnabled || !shouldCheck(lastUpdateCheckAt, Date.now())) return;
      // Deliberately not awaited: a session must never wait on a network call
      // to start, and a failed check is silence rather than a notice.
      void runSelfUpdate(selfUpdateMode !== "check")
        .then((result) => {
          if (result.unavailable) return;
          // Only speak when there is something to act on. "You are up to date"
          // every few hours is noise that trains the operator to ignore the one
          // notice that matters.
          if (result.decision.action === "current" || result.decision.action === "skip") return;
          ctx.ui.notify(describeUpdate(result.decision, { applied: result.applied }), "info");
        })
        .catch(() => {});
    });
  }

  pi.registerCommand("update", {
    description: "Check for and apply extension updates (fast-forward only, never over uncommitted work).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      // Tokenised, not a substring test: `includes("--check")` would fire on
      // any argument that merely contains the text.
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const check = argv.includes("--check");
      const result = await runSelfUpdate(!check);
      if (result.unavailable) {
        ctx.ui.notify(`Update check unavailable: ${result.unavailable}`, "info");
        return;
      }
      const lines = [describeUpdate(result.decision, { applied: result.applied })];
      if (result.observation?.upstream) {
        const dirtyNote = result.observation.dirty ? " · uncommitted changes present" : "";
        lines.push(
          `branch ${result.observation.branch} tracking ${result.observation.upstream} · ${result.observation.ahead} ahead, ${result.observation.behind} behind${dirtyNote}`,
        );
      }
      if (result.head) lines.push(`now at ${result.head.slice(0, 12)}`);
      ctx.ui.notify(lines.join("\n"), result.decision.action === "report" ? "warning" : "info");
    },
  });

  // Gateway-reported per-model readiness (`slots`, `x_state`). Built lazily and
  // cached per provider: this is consulted on every hold, and holds arrive in
  // bursts exactly when the gateway can least afford extra requests.
  const healthProviders = new Map<string, ModelHealthProvider>();
  const healthFor = async (ctx: { model?: Model<any>; modelRegistry?: unknown }): Promise<
    ModelHealthProvider | undefined
  > => {
    const model = ctx.model;
    if (!model) return undefined;
    let provider = healthProviders.get(model.provider);
    if (!provider) {
      const baseUrl = model.baseUrl ?? providerBaseUrl(safeModelsConfig(), model.provider);
      if (!baseUrl) return undefined;
      let apiKey: string | undefined;
      try {
        const registry = ctx.modelRegistry as
          | { getApiKeyAndHeaders?: (m: Model<any>) => Promise<{ ok: boolean; apiKey?: string }> }
          | undefined;
        const resolved = await registry?.getApiKeyAndHeaders?.(model);
        if (resolved?.ok) apiKey = resolved.apiKey;
      } catch {
        // Unauthenticated probe; the gateway decides whether that is allowed.
      }
      provider = new ModelHealthProvider({ baseUrl, ...(apiKey ? { apiKey } : {}) });
      healthProviders.set(model.provider, provider);
    }
    await provider.refresh();
    return provider;
  };

  /** Read models.json without letting a malformed file break a command. */
  function safeModelsConfig(): ReturnType<typeof readModelsConfig> {
    try {
      return readModelsConfig(defaultModelsPath());
    } catch {
      return {};
    }
  }

  // ─── /refresh-models: make the configured catalogue match the gateway ────
  // Model configuration drifts silently and expensively. Measured against a
  // live gateway, a working models.json had one model configured at 1,048,576
  // tokens that the gateway caps at 262,144, another at 131,072 that actually
  // accepts 250,112, and a model missing entirely. The over-statement is the
  // damaging direction: Pi fills the context believing it fits, the request
  // fails, and because Pi computes usage from the configured window, compaction
  // fires far too late to save the turn.
  pi.registerCommand("refresh-models", {
    description: "Refresh models.json with inference-tested working models. --dry-run to preview.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const dryRun = argv.includes("--dry-run");
      const pruneMissing = argv.includes("--prune");
      const explicitProvider = argv.find((a) => !a.startsWith("--"));

      try {
        // Unlike status-only commands, refresh must surface malformed JSON:
        // treating it as an empty config could overwrite the operator's file.
        const configuredProviders = Object.keys(readModelsConfig(defaultModelsPath()).providers ?? {});
        const providerIds = explicitProvider
          ? [explicitProvider]
          : configuredProviders.length > 0
            ? configuredProviders
            : ctx.model?.provider
              ? [ctx.model.provider]
              : [];
        if (providerIds.length === 0) {
          ctx.ui.notify("No provider to refresh. Select a model first, or pass a provider name.", "warning");
          return;
        }

        const result = await refreshConfiguredProviders({
          modelsPath: defaultModelsPath(),
          providerIds,
          authForProvider: async (providerId) => {
            if (!ctx.modelRegistry) return {};
            const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
            const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
            if (!resolved) {
              if (status.configured) {
                throw new Error(`Authentication for ${providerId} is configured but could not be resolved`);
              }
              return {};
            }
            return {
              ...(resolved.auth.apiKey ? { apiKey: resolved.auth.apiKey } : {}),
              ...(resolved.auth.headers ? { headers: resolved.auth.headers } : {}),
              ...(resolved.auth.baseUrl ? { baseUrl: resolved.auth.baseUrl } : {}),
            };
          },
          ...(dryRun ? { dryRun: true } : {}),
          ...(pruneMissing ? { pruneMissing: true } : {}),
          probeModels: true,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (result.results.length === 0) {
          throw new Error(result.failures.map(({ providerId, error }) => `${providerId}: ${error.message}`).join("; "));
        }
        ctx.ui.notify(result.lines.join("\n"), result.failures.length > 0 ? "warning" : "info");
      } catch (err) {
        ctx.ui.notify(
          `refresh-models failed: ${err instanceof Error ? err.message : String(err)}. Your configuration was not changed.`,
          "error",
        );
      }
    },
  });

  // Registered outside the `pi.on` guard below: a command needs only
  // `registerCommand`, and burying it in there meant it never appeared in a
  // session without event support — nor in the package smoke test, which is
  // how a missing command surface goes unnoticed.
  // ─── /gateway: why are we waiting, and how badly ───────────────────────
  pi.registerCommand("gateway", {
    description: "Show model-gateway admission state: holds, queue position, concurrency clamp.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const usage = ctx.getContextUsage?.();
      const lines = renderGatewayReport({
        status: sharedAdmissionController().status(),
        config: {
          enabled: gatewayConfig.enabled,
          maxConcurrency: gatewayConfig.maxConcurrency,
          reservedSlots: gatewayConfig.reservedSlots,
          maxWaitMs: gatewayConfig.maxWaitMs,
          maxRetries: gatewayConfig.maxRetries,
          maxElapsedMs: gatewayConfig.maxElapsedMs,
        },
        installs: installedGatewayStreamRetries(),
        model: ctx.model
          ? {
              id: ctx.model.id,
              provider: ctx.model.provider,
              api: ctx.model.api,
              contextWindow: ctx.model.contextWindow,
            }
          : undefined,
        contextTokens: usage?.tokens ?? null,
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
  // Per-model compaction tuning (src/compaction/autoTune.ts): Pi's own
  // compaction, triggered and cut for the active model's window and output
  // allowance, without ever writing the user's settings. PI_AUTO_COMPACTION=0
  // turns it off; a value the user set in Pi's settings always wins.
  if (typeof pi.on === "function") {
    registerAutoCompaction(pi as never, {
      enabled: !/^(0|false|off|no)$/i.test(process.env.PI_AUTO_COMPACTION ?? ""),
    });
  }

  if (gatewayConfig.enabled && typeof pi.on === "function") {
    const admission = sharedAdmissionController();

    // The interactive wrapper captures headers on each attempt's own
    // `onResponse` callback. This hook deliberately does not cache them by
    // provider/model: that pair is shared by concurrent calls and is therefore
    // not a safe correlation key.
    pi.on("after_provider_response", async () => {});

    // Pi's own session retry stops after `retry.maxRetries` (default 3),
    // ignores the wait the gateway advertised, and has no accessor on the
    // extension API. The interactive turn used to die there — "Retry failed
    // after 3 attempts" — while every worker waited happily. That budget is now
    // bypassed by wrapping the provider's `streamSimple` (see below), so the
    // advice notice that used to point operators at .pi/settings.json is gone.

    // Terminal assistant error: the only place `retry_after_ms` appears, since
    // it lives in the response BODY.
    //
    // Scoped through `isAccountWideRefusal`, the same predicate the wrapper and
    // `after_provider_response` use. Two fresh-context reviews caught this
    // family of paths disagreeing with each other; a rule stated in one place
    // and broken in another is not a rule, so all three now ask one function.
    pi.on("message_end", async (event, ctx) => {
      const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
      if (msg?.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) return;
      const signal = parseGatewayWait({ text: msg.errorMessage });
      if (!signal?.retryable) return;
      const waitMs = isAccountWideRefusal(signal) ? admission.noteWait(signal) : admission.noteObservedWait(signal);
      // The status bar owns this now: a spinner, the countdown and the queue
      // position say everything the 429 body did, without a wall of warnings
      // every 30 seconds. Notify only when there is no status bar to read.
      if (!statusBarConfig.enabled) {
        ctx.ui.notify(
          `Model gateway is saturated — holding ${Math.round(waitMs / 1000)}s. ${describeGatewayWait(signal)}`,
          "warning",
        );
      }
    });

    // Hold the next provider request until the shared cooldown expires, so a
    // re-submit (manual or automatic) does not walk straight back into the
    // queue the gateway just asked us to leave alone.
    //
    // This fires for EVERY provider call, compaction and summarization
    // included, so a hold must be visible: a silent multi-second stall in the
    // user's own session would be worse than the 429 it prevents. The status
    // bar carries that (spinner + countdown + queue position); the notify path
    // is the fallback for a session running without one.
    //
    // The wait is tied to the turn's own abort signal: escape ends the hold for
    // this caller and leaves any wider cooldown standing for other callers.
    let noticeSilentUntil = 0;
    pi.on("before_provider_request", async (_event, ctx) => {
      const identity = ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {};
      const remaining = admission.cooldownRemainingMs(identity);
      if (remaining <= 0) return;
      if (!statusBarConfig.enabled) {
        const now = Date.now();
        if (now >= noticeSilentUntil) {
          noticeSilentUntil = now + remaining;
          ctx.ui.notify(
            `Waiting ${Math.ceil(remaining / 1000)}s for the model gateway — ${admission.describe()}`,
            "warning",
          );
        }
      }
      const signal = ctx.signal;
      await admission.awaitCooldown({ ...identity, ...(signal ? { signal } : {}) });
    });

    // ─── Bounded waiting for the interactive turn ──────────────────────────
    // Everything above holds the turn BEFORE a request and records the wait
    // after one fails, but it cannot stop Pi from giving up: `retryAssistantCall`
    // (pi-ai utils/retry.js) retries a failed assistant message `maxRetries`
    // times — 3 by default — with its own exponential backoff, then surfaces
    // "Retry failed after 3 attempts".
    //
    // `registerProvider(id, { api, streamSimple })` is the one seam that gets
    // underneath that: `composeModelProvider` dispatches the agent's own
    // provider call to the handler we supply (provider-composer.js:315-323), so
    // a wait taken in there costs Pi nothing from its retry budget. Saturation
    // becomes what it actually is — a slow request, not a failed one.
    // When explicitly enabled, consecutive waits on the current model trigger
    // consideration of a stand-in. Reset whenever a stream actually produces
    // output or the model changes.
    // Plain-data state machine for the hold-driven fallback (see
    // src/gateway/fallbackLifecycle.ts). It holds a count and a pending flag —
    // never a Pi context — so an async gateway callback can update it safely
    // even after the session that raised the hold has been replaced or reloaded.
    // Its own default is also off, keeping the safety boundary fail-closed.
    const fallbackCoordinator = new FallbackCoordinator({ enabled: gatewayConfig.modelFallbackEnabled });

    // Retry a turn whose stream was cut AFTER partial output (link cut,
    // "terminated"): omit the partial answer and continue, with long-wait
    // backoff (no attempt cap; 12h horizon by default). Pi's own retry, when the
    // user enabled it, still goes first. PI_AFTER_OUTPUT_RETRY=0 turns it off.
    const afterOutputRetry = new AfterOutputRetry();
    if (!/^(0|false|off|no)$/i.test(process.env.PI_AFTER_OUTPUT_RETRY ?? "")) afterOutputRetry.register(pi as never);

    const installStreamRetry = (ctx: { modelRegistry?: unknown; signal?: AbortSignal }, model?: Model<any>): void => {
      const registry = ctx.modelRegistry as Parameters<typeof installGatewayStreamRetry>[0] | undefined;
      if (!registry || typeof registry.registerProvider !== "function") return;
      if (!model?.provider || !model?.api) return;
      installGatewayStreamRetry(
        registry,
        { provider: model.provider, api: model.api },
        {
          createStream: () => createAssistantMessageEventStream() as never,
          // Scope decides which gate, keyed on what the refusal is ABOUT. A
          // 429 or an admission envelope speaks for the account — a shared
          // queue, a concurrency ceiling — so it parks every caller behind one
          // cooldown. A `503 no worker for model` speaks for one model, and
          // parking workers on healthy models behind it would turn one model's
          // outage into a runtime-wide stall. Either way the wait is emitted,
          // so the footer keeps its spinner and countdown.
          hold: async (waitSignal, _attempt, abort, actualModel) => {
            const callModel = actualModel as Model<any>;
            const scopedSignal = { ...waitSignal, provider: callModel.provider, model: callModel.id };
            const opts = {
              provider: callModel.provider,
              model: callModel.id,
              ...(abort ? { signal: abort } : {}),
            };
            // A link cut is always the caller's own: its retry is routed afresh.
            if (gatewayHoldScope(scopedSignal) === "shared") await admission.noteWaitAndSleep(scopedSignal, opts);
            else await admission.noteCallerWaitAndSleep(scopedSignal, opts);
          },
          // "Consecutive" has to mean consecutive: without this the counter
          // accumulated across a whole session and would eventually trip a
          // fallback on unrelated, widely separated holds.
          onProgress: () => {
            fallbackCoordinator.onProgress();
          },
          onHold: (info, actualModel) => {
            // Checked on a hold rather than on failure: by the time a turn
            // fails the operator has already spent the wait this avoids. The
            // in-flight request is left alone — a switch applies to the next
            // one.
            //
            // PLAIN DATA ONLY. This callback is asynchronous with respect to
            // the Pi session lifecycle: it can fire after the session that
            // raised the hold has been replaced, reloaded, forked, or shut
            // down. Reaching for a captured ctx here (as `considerFallback` used
            // to) is what crashed Pi via `assertActive`. So a hold only updates
            // the coordinator's count and pending flag; the fallback itself is
            // applied later from a fresh lifecycle callback.
            const callModel = actualModel as Model<any>;
            fallbackCoordinator.onGatewayHold({
              modelId: callModel.id,
              provider: callModel.provider,
              source: info.signal.source,
              accountWide: isAccountWideRefusal(info.signal),
            });
          },
          maxElapsedMs: gatewayConfig.maxElapsedMs,
          // Fit every request body to the gateway's cap (advertised, else
          // 10 MiB) before it is sent; a 413 is permanent and ends the turn.
          requestBodyBudget: resolveRequestBodyBudgetConfig(),
          // A stream cut after partial output is replayed by afterOutputRetry
          // (agent_before_settle); the wait it owes is taken here, against the
          // request's own abort signal, so Esc ends it at once.
          beforeSend: (model, signal, context) => afterOutputRetry.beforeSend(model as never, signal, context as never),
          // Thinking off for Pi's summaries (compaction) and near-full turns on
          // the metabolomics gateway, whose models think by default and would
          // otherwise spend the whole output budget on hidden reasoning.
          thinkingPolicy: resolveThinkingOffConfig(),
          signalOf: (options) => (options as { signal?: AbortSignal } | undefined)?.signal,
          errorMessage: (m, error) => ({
            role: "assistant",
            content: [],
            api: (m as Model<any>).api,
            provider: (m as Model<any>).provider,
            model: (m as Model<any>).id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          }),
        },
      );
    };

    // Apply a pending hold-driven fallback using the FRESH ctx this callback
    // supplies. This is the only place the session is touched for a fallback:
    // it reads `ctx.model`/`ctx.modelRegistry`, resolves readiness, and calls
    // `pi.setModel` — all against a currently-valid context. A failure here is
    // caught and logged (by the caller), so a fallback problem degrades the
    // feature rather than terminating Pi.
    const applyPendingFallbackWithFreshCtx = async (ctx: FallbackContext): Promise<void> => {
      const pending = fallbackCoordinator.claimPending();
      if (!pending) return;
      const result = await applyPendingFallback(
        {
          setModel: (m) => pi.setModel(m),
          healthFor: (c) => healthFor(c as { model?: Model<any>; modelRegistry?: unknown }),
          log: (message) => console.error(message),
        } satisfies FallbackApplyDeps,
        ctx,
        pending,
      );
      // A successful switch means the new model gets a clean ledger; the
      // stand-in's own outage must start its own count, not inherit the one
      // that triggered this switch. A "stay" keeps the count so the next hold
      // re-arms the pending flag and the choice is reconsidered.
      if (result.switched) fallbackCoordinator.onProgress();
    };

    // Per (provider, api): `composeModelProvider` only dispatches to our
    // handler when the model's api matches the one registered, so a switch to a
    // model on a different api needs its own installation.
    //
    // Installing is idempotent, so all three hooks are belt-and-braces rather
    // than redundancy: `session_start` is the normal path, `before_agent_start`
    // covers a session whose `ctx.model` was not resolved yet (the type admits
    // undefined), and `model_select` covers a mid-session switch. It has to
    // land before the first provider call — `before_provider_request` fires
    // from inside the provider's own stream call, which is already too late for
    // that request.
    pi.on("session_start", (_event, ctx) => {
      installStreamRetry(ctx, ctx.model);
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      installStreamRetry(ctx, ctx.model);
      // The fallback (if any) runs against THIS callback's live ctx — never a
      // stale one captured from an earlier session. It is awaited so a switch
      // (if the decision is one) lands before this turn's first provider call
      // rather than racing it, and it is caught so a fallback failure degrades
      // the feature instead of breaking the agent start or escaping as an
      // uncaught rejection that exits Pi. When nothing is pending this returns
      // immediately, so the normal path pays no latency.
      try {
        await applyPendingFallbackWithFreshCtx(ctx as FallbackContext);
      } catch (error) {
        console.error("[pi-engineering] fallback application failed", error);
      }
    });
    pi.on("model_select", (event, ctx) => {
      // A switch — ours or the operator's — supersedes any stale fallback
      // intent and the hold ledger; otherwise one model's outage would switch
      // away from the model the operator just chose.
      fallbackCoordinator.onModelSelect();
      installStreamRetry(ctx, event.model);
    });

    // ─── Model fallback when one model has no workers ──────────────────────
    // Waiting already keeps the turn alive; this is about not waiting longer
    // than necessary when the same gateway is serving a healthy model.
    //
    // The decision is mostly a refusal (src/gateway/fallback.ts): moving a
    // session to a model it no longer fits in does not degrade it, it ends it
    // with a context overflow — trading a survivable wait for an unsurvivable
    // error. So a switch needs a measured context size, and `getContextUsage()`
    // reports null right after compaction, which is a refusal rather than a
    // reason to guess.
    //
    // Lifecycle safety (INV: session-bound Pi objects MUST NOT be retained for
    // later asynchronous use): the hold that arms a fallback is observed in a
    // gateway callback, which is async with respect to the session. It updates
    // only the coordinator's plain state; the pending flag is then applied in
    // `before_agent_start` against the fresh ctx that callback supplies. A
    // stale captured ctx is what crashed Pi (`assertActive`) before this
    // change — the plain flag has no such hazard.
    pi.on("session_shutdown", () => {
      // Ephemeral fallback state must not leak across a session boundary.
      fallbackCoordinator.onSessionShutdown();
    });
  }

  // ─── Live status bar: harness-owned Pi footer (spec §status-bar) ─────────
  // The footer consumes structured harness telemetry state and streams live
  // output TPS. It never runs git/network during render (git context is cached
  // and invalidated on branch/cwd/model changes). `pi.on()` only exists in a
  // real pi session, so guard like the Generation Guard block above.
  /** Publish the session's context usage against the model's resolved window. */
  const publishContext = (ctx: ExtensionCommandContext): void => {
    if (!activeFooter) return;
    const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
    const modelId = ctx.model?.id;
    const resolved = inferweave?.windowFor(modelId);
    if (resolved) activeFooter.setCapabilityWindow(resolved.windowTokens, resolved.note);
    if (usage && typeof usage.tokens === "number") activeFooter.setContextUsage(usage.tokens);
  };

  if (statusBarConfig.enabled && typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      for (const un of sessionUnsubscribes.splice(0)) un();
      activeFooter?.dispose();
      // The ambient row summarises the same engineering state the panel shows,
      // in a surface that is always readable without stepping into the panel.
      //
      // Scoped to THIS session's repository: `panels` is process-wide, so a
      // resolver that just returned the latest state would let a footer here
      // summarise a repository someone else's session had opened. A summary
      // attributed to the wrong tree is worse than no summary.
      const sessionCwd = ctx.cwd;
      const footer = new FooterController({
        ctx,
        config: statusBarConfig,
        panelState: () => {
          if (!ambientPanel) return undefined;
          return ambientPanel.key === cachedRepoKey(sessionCwd) ? ambientPanel.state : undefined;
        },
        capabilityWindow: (modelId) => inferweave?.windowFor(modelId),
      });
      activeFooter = footer;
      // The footer is a second consumer of admission events (telemetry owns the
      // constructor hook), so it subscribes and gives the wait a countdown.
      if (gatewayConfig.enabled) {
        sessionUnsubscribes.push(sharedAdmissionController().subscribe((event) => footer.onGatewayEvent(event)));
      }
      publishContext(ctx as unknown as ExtensionCommandContext);
    });

    pi.on("message_start", () => activeFooter?.onMessageStart());
    pi.on("message_update", (event) => activeFooter?.onMessageUpdate(event));
    pi.on("message_end", (event) => activeFooter?.onMessageEnd(event));
    pi.on("model_select", (event) => activeFooter?.onModelSelect(event.model));
    // Usage moves with every turn, and the window must move with the model.
    pi.on("agent_settled", (_event, ctx) => publishContext(ctx as unknown as ExtensionCommandContext));
    pi.on("session_shutdown", () => {
      for (const un of sessionUnsubscribes.splice(0)) un();
      activeFooter?.dispose();
      activeFooter = null;
    });
  }

  // ─── Model switch guard (spec 02 §switching models) ───────────────────
  // A switch to a narrower window must be made safe BEFORE the next request is
  // dispatched. Pi's native compaction engine does the work; this only decides
  // when it is required, and refuses to pretend a request that cannot fit will
  // succeed. Pi's overflow recovery stays intact — this runs earlier.
  if (inferweave && typeof pi.on === "function") {
    pi.on("model_select", async (event, ctx) => {
      const modelId = event.model?.id;
      const target = inferweave.windowFor(modelId);
      if (!target) return;
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      const used = usage && typeof usage.tokens === "number" ? usage.tokens : 0;
      // The previous window comes from the event's previousModel — the
      // capability resolution for it if the layer knows it, else Pi's own
      // registry window for that model. Footer state must not be the source:
      // with the status bar disabled there is none, and this guard is the
      // safety path, so it must stand on its own.
      const previousModel = event.previousModel;
      const previous =
        (previousModel?.id ? inferweave.windowFor(previousModel.id) : undefined)?.windowTokens ??
        previousModel?.contextWindow ??
        target.windowTokens;
      const decision = planModelSwitch(used, previous, target.windowTokens, {
        reserveOutputTokens: inferweave.resolved(modelId)?.maxTokens ?? 0,
      });
      if (decision.action === "none") return;
      if (decision.action === "reject") {
        ctx.ui.notify(
          `cannot switch to ${modelId}: ${decision.reason} — pick a model whose window fits or compact first`,
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `${modelId} window is ${contextReading(used, target.windowTokens).windowTokens} tokens; compacting ${decision.overflowTokens} before the next request`,
        "info",
      );
      ctx.compact({ customInstructions: "Preserve task state, decisions, and open files; compress the rest." });
    });
  }

  // ─── InferWeave capability provider (spec 02 / 07) ───────────────────
  // Dynamic discovery through Pi's supported `refreshModels` hook: the gateway's
  // guaranteed routable context becomes Pi's contextWindow, its advertised
  // output maximum becomes maxTokens. No Pi core patch, no competing compaction.
  if (inferweave) {
    pi.registerProvider(inferweave.registration.name, inferweave.registration as never);
  }

  pi.registerCommand("iw-context", {
    description: "Show model context capability: resolved window, provenance, leases, staleness.",
    handler: async (args, ctx) => {
      const modelId = args.trim() || ctx.model?.id;
      const lines = inferweave
        ? inferweave.diagnostics(modelId)
        : [
            "InferWeave integration is off. Set INFERWEAVE_BASE_URL (e.g. http://gw:8787/v1) to enable capability discovery.",
            `Active model: ${ctx.model?.id ?? "unknown"}`,
          ];
      const usage = typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      // `tokens` is null right after compaction, before the next LLM response;
      // Pi's own `contextWindow` is the window it is enforcing, which is exactly
      // what a capability discrepancy check wants to see.
      const windowTokens =
        inferweave?.windowFor(modelId)?.windowTokens ??
        usage?.contextWindow ??
        activeFooter?.state.context?.windowTokens ??
        0;
      if (typeof usage?.tokens === "number" && windowTokens > 0) {
        lines.unshift(
          `session: ${contextReading(usage.tokens, windowTokens).label} (Pi window ${usage.contextWindow})`,
        );
      } else if (windowTokens > 0) {
        lines.unshift(`session: usage unknown; Pi window ${usage?.contextWindow ?? windowTokens}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ─── Engineering panel ───────────────────────────────────────────────────
  // `/panel` (or the configured chord) toggles a right-anchored overlay over
  // the ledger's record of the run, falling back to the working tree when idle.
  // Pi registers commands but not keybindings, so the chord is a raw input
  // handler that consumes only its own key.
  // Two chords: `ctrl+p` steps the keyboard into and out of the panel for
  // navigation; `ctrl+b` collapses and uncollapses the whole panel (the same
  // thing `/panel` does). Both are raw input handlers that consume only their
  // own key. `ctrl+b` is deliberately not one of pi's default keybindings.
  const panelChord = process.env.PI_PANEL_CHORD ?? "ctrl+p";
  const panelToggleChord = process.env.PI_PANEL_TOGGLE_CHORD ?? "ctrl+b";

  /** The slice of Pi's session UI the panel needs. */
  interface PanelSessionUi {
    custom?: unknown;
    onTerminalInput?: (handler: (data: string) => { consume: true } | undefined) => () => void;
    notify: (message: string, kind?: "info" | "warning" | "error") => void;
  }

  async function openPanel(ctx: {
    cwd: string;
    ui: { notify: (m: string, t?: "info" | "warning" | "error") => void };
  }) {
    const key = await repoCacheKey(ctx.cwd);
    const rt = await getRuntimeByCwd(ctx.cwd).catch(() => null);
    if (!rt) {
      ctx.ui.notify("Panel unavailable: no engineering runtime for this directory.", "error");
      return null;
    }
    // No refresh here: opening the overlay invalidates the cache and refreshes,
    // so a second read would only race the first.
    return { plumbing: panelFor(key, rt), rt };
  }

  /**
   * Start the session narrator for a repo, at most once.
   *
   * On by default now that the panel gives the summary a permanent home;
   * `PI_PANEL_NARRATOR=0` turns it off. It is the only part of the panel that
   * spends money, and it is the operator's money, so the gate stays and the
   * cost is bounded rather than hidden: one call at most every two minutes,
   * only when the observed state has actually changed, never while a gateway
   * cooldown is standing, and nothing at all in a session that never opens the
   * panel. It observes the panel's own state —
   * the run view the ledger feeder already publishes — rather than reaching
   * into the runtime for a second source of truth, and it is gated on the SAME
   * admission controller as every other model call in this process.
   */
  const narrators = new Map<string, Narrator>();
  function startNarrator(plumbing: PanelPlumbing, _rt: EngineeringRuntime): void {
    const mode = (process.env.PI_PANEL_NARRATOR ?? "1").toLowerCase();
    if (mode === "0" || mode === "false" || mode === "off") return;
    const key = [...panels.entries()].find(([, value]) => value === plumbing)?.[0];
    if (!key || narrators.has(key)) return;

    const admission = sharedAdmissionController();
    const narrator = new Narrator({
      state: plumbing.state,
      summarize: createSummarize(),
      cooldownRemainingMs: () => admission.cooldownRemainingMs(),
      acquire: () => admission.acquire(),
    });
    narrators.set(key, narrator);

    // Deltas come from panel state, which the ledger feeder already keeps
    // current. No transcript, no second pipeline.
    //
    // The whole session is narrated, run and idle alike: while a run is
    // underway the run's files drive the arc; when idle (no run, or one that
    // has settled) the working tree's changed files do. The run view is kept
    // after settle (see LedgerFeeder), so we switch on phase rather than the
    // mere presence of a run.
    const unsubscribe = plumbing.state.subscribe((snapshot) => {
      // Narrate the WHOLE session, not just engineering runs: while a run is
      // underway we summarise the run; when idle (no run, or one that has
      // settled) we summarise the working tree's changed files, so edits and
      // commands outside /engineer are part of the arc too.
      const run = snapshot.run;
      const activeRun = run && run.phase !== "settled" ? run : undefined;
      const files = activeRun
        ? activeRun.files.map((file) => file.path)
        : (snapshot.workspace?.files ?? []).map((file) => file.path);
      // Nothing happening: no deltas to summarise, no model call to spend.
      if (!activeRun && files.length === 0) return;
      void narrator.observe({
        ...(activeRun?.workItemId ? { workItemId: activeRun.workItemId } : {}),
        ...(activeRun?.goal ? { goal: activeRun.goal } : {}),
        ...(activeRun?.phase ? { phase: activeRun.phase } : {}),
        files,
      });
    });
    // The panel cache is process-wide and outlives a session, so without this
    // a narrator opted into once would keep observing — and spending — in every
    // later session, with no way to stop it.
    panelUnsubscribes.push(() => {
      unsubscribe();
      narrator.dispose();
      narrators.delete(key);
    });
  }

  /** Resolve a selected row into a bounded content view. */
  function openRowFor(rt: EngineeringRuntime, state: PanelState) {
    return async (payload: { kind: string; path?: string; source?: string; sha?: string; subject?: string }) => {
      if (payload.kind === "commit" && payload.sha) {
        // No repository means no history to read; the rows that produce this
        // payload only exist when there is one, so this is belt and braces.
        if (!rt.git) return { title: payload.sha, lines: [], truncated: false, error: "not a git checkout" };
        return readCommitContent(rt.git, payload.sha, payload.subject);
      }
      if (payload.kind !== "file" || !payload.path) return undefined;
      // A run's file is shown as the candidate diff when one was captured;
      // the artifact URI travels, the body is fetched only to display it.
      const candidateId = state.snapshot.run?.candidateId;
      if (payload.source === "run" && candidateId) {
        const candidate = rt.ledger.getCandidate(candidateId);
        if (candidate?.diff_artifact_uri) {
          return readDiffContent(rt.artifacts, candidate.diff_artifact_uri, payload.path);
        }
      }
      return readFileContent(resolve(rt.cwd, payload.path), payload.path);
    };
  }

  /**
   * Route diagnostics through Pi's own notifications.
   *
   * The bug this closes: subsystems wrote `[gateway-admission] {…}` straight to
   * stderr. Inside a TUI that lands under a frame the TUI drew, does not wrap,
   * runs through the side panel, and scrolls the screen by a row the TUI does
   * not know about — after which every composited row beneath is off by one
   * character. Through `notify` the line is wrapped, coloured by severity from
   * the operator's own theme, and drawn as part of the frame.
   *
   * Repeats are throttled: a gateway that keeps a session waiting emits the
   * same sentence every thirty seconds, and the footer already carries the live
   * countdown. The notification is there to explain the silence once, not to
   * narrate it.
   */
  /**
   * Route diagnostics through Pi's own notifications.
   *
   * The bug this closes: subsystems wrote `[gateway-admission] {…}` straight to
   * stderr. Inside a TUI that lands under a frame the TUI drew, does not wrap,
   * and runs through the side panel. Through `notify` the line is wrapped and
   * coloured by severity from the operator's own theme, and drawn as part of
   * the frame rather than under it.
   */
  function installTelemetrySink(ui: { notify(text: string, level: string): void }): () => void {
    const allow = createRepeatThrottle();
    return setTelemetrySink((notice: TelemetryNotice) => {
      if (!allow(notice)) return;
      try {
        ui.notify(notice.text, notice.level);
      } catch {
        /* A session tearing down is not a reason to fail the work reporting. */
      }
    });
  }

  /**
   * Build the session's controller and bind the chord.
   *
   * Called from `session_start` so the hotkey works without `/panel` first, and
   * from `/panel` itself so a session whose `session_start` found no runtime
   * (or has not finished its async lookup) still opens rather than reporting a
   * UI problem that is not the real cause.
   */
  function createPanelController(
    ctx: { ui: PanelSessionUi },
    plumbing: PanelPlumbing,
    rt: EngineeringRuntime,
  ): PanelController {
    const controller = new PanelController({
      state: plumbing.state,
      ui: ctx.ui as never,
      chord: panelChord,
      toggleChord: panelToggleChord,
      layout: panelLayoutStore.load(),
      // The patch carries width/tab/expansion; open/closed is the controller's,
      // and is persisted separately when the panel is opened or closed.
      onLayoutChange: (patch: PanelLayoutPatch) =>
        panelLayoutStore.save({ ...patch, open: panelLayoutStore.load().open }),
      onVisibilityChange: (open: boolean) => panelLayoutStore.save({ ...panelLayoutStore.load(), open }),
      onOpen: () => {
        plumbing.workspace.invalidate();
        void plumbing.workspace.refresh();
        plumbing.ledger.refresh();
        plumbing.memory.refresh();
        // Keep refreshing while it is on screen. `onOpen` alone was enough when
        // the panel was a toggle you opened to look at something; now that it
        // stays open for the whole session, a view refreshed once at start-up
        // is a working tree from hours ago presented as current — worse than no
        // panel, because it looks authoritative. Found by a fresh-context
        // review, and made materially worse by the auto-open change.
        startPanelRefresh(plumbing);
        // The narrator costs money, so it does not start until the panel has
        // been opened at least once: a session that never opens /panel must
        // not pay for summaries nobody reads.
        startNarrator(plumbing, rt);
      },
      // Releasing what the panel was driving. A fresh-context review found this
      // missing: `stopPanelRefresh` existed and was never called, so the timer
      // outlived every panel that started it — and because `startPanelRefresh`
      // returns early when a timer is already set, the first session's timer
      // permanently blocked every later one while still running git against the
      // first session's repository.
      onHidden: () => stopPanelRefresh(),
      openRow: openRowFor(rt, plumbing.state),
    });
    if (typeof ctx.ui.onTerminalInput === "function") {
      panelUnsubscribes.push(ctx.ui.onTerminalInput((data) => controller.handleTerminalInput(data)));
    }
    return controller;
  }

  // The overlay and the chord need a live session UI, which only exists in a
  // real Pi run (the smoke-test stub has no pi.on).
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      // First, before anything can report: until a sink is installed every
      // diagnostic goes to raw stderr, which is what tears the frame.
      //
      // The previous session's sink is removed rather than left stacked
      // beneath this one. A review flagged that as a hazard for overlapping
      // sessions, and it would be — but this extension already treats sessions
      // as serial: the line below disposes `activePanel`, and the panel's
      // refresh timer is stopped the same way. One live session per process is
      // the assumption throughout, and a sink left behind by a session that
      // will never shut down is a slow leak pointed at a dead UI.
      telemetryUninstall?.();
      telemetryUninstall = installTelemetrySink(ctx.ui as { notify(text: string, level: string): void });
      for (const un of panelUnsubscribes.splice(0)) un();
      activePanel?.dispose();
      activePanel = null;
      // A new session inherits no timer from the last one.
      stopPanelRefresh();
      const key = await repoCacheKey(ctx.cwd);
      const rt = await getRuntimeByCwd(ctx.cwd).catch(() => null);
      // Not fatal: `/panel` retries the lookup and builds the controller then.
      if (!rt) return;
      activePanel = createPanelController(ctx as { ui: PanelSessionUi }, panelFor(key, rt), rt);

      // ── The panel is shown by default, and does not take the keyboard ────
      // It is registered `nonCapturing` (pi-tui OverlayOptions), so it is on
      // screen without owning input. `ctrl+p` steps into it and back out;
      // `ctrl+b` (or `/panel`) collapses and uncollapses it.
      //
      // The first attempt at this shipped without `nonCapturing` and made pi
      // accept no typing at all, because `ui.custom()`'s own doc comment says
      // "with keyboard focus" and never mentions the option that turns that
      // off. The flag remains as an escape hatch for anyone who wants no panel
      // at all without hiding it every session.
      //
      // `restore()` rather than `toggle()`: restoring a remembered choice is
      // not the operator making a new one, and recording it as one would write
      // the preference back every session whether they touched it or not.
      const autoOpen = (process.env.PI_PANEL_AUTO_OPEN ?? "1").toLowerCase();
      const autoOpenEnabled = autoOpen !== "0" && autoOpen !== "false" && autoOpen !== "off";
      if (autoOpenEnabled && panelLayoutStore.load().open) {
        const ui = ctx.ui as PanelSessionUi;
        // An overlay needs somewhere to draw. A session without interactive UI
        // gets nothing rather than an error it cannot act on.
        if (typeof ui.custom === "function") activePanel.restore();
      }
    });

    pi.on("session_shutdown", async () => {
      // A sink pointing at a torn-down session's UI is worse than none.
      telemetryUninstall?.();
      telemetryUninstall = undefined;
      for (const un of panelUnsubscribes.splice(0)) un();
      activePanel?.dispose();
      activePanel = null;
      // Belt and braces alongside `onHidden`: a timer that survives a session
      // both wastes git on a repository nobody is looking at and, because
      // `startPanelRefresh` returns early when one is already set, stops the
      // NEXT session from ever refreshing.
      stopPanelRefresh();
      await shutdownCachedRuntimes();
    });
  }

  pi.registerCommand("panel", {
    description: "Toggle the engineering panel: changed files, reviews, models, and token spend.",
    handler: async (_args, ctx) => {
      const opened = await openPanel(ctx);
      if (!opened) return;
      if (!activePanel) {
        const ui = ctx.ui as PanelSessionUi;
        if (typeof ui.custom !== "function") {
          ctx.ui.notify("Panel unavailable: this session has no interactive UI.", "error");
          return;
        }
        activePanel = createPanelController({ ui }, opened.plumbing, opened.rt);
      }
      activePanel.toggle();
    },
  });

  // ─── Mission orchestration (spec pi-engineering-orchestration) ─────────
  // Normal-language intent auto-invokes the engineering workflow through the
  // Orchestrator. `/mission` is an optional power-user control; correctness
  // never depends on it (the semantic tool + runtime gate enforce policy).
  // Planner/worker execution mode (docs/specs/planner-worker-hot-model-routing.md):
  // /engineering-* commands, and the mode `/mission` consults before orchestrating.
  const plannerWorker = registerPlannerWorker(pi, {
    host: async (ctx) => {
      const rt = await getRuntime(ctx);
      return { repoRoot: rt.git?.root ?? rt.cwd, worker: rt.worker };
    },
    sessionGuardActive: inferweave !== null,
  });

  pi.registerCommand("mission", {
    description: "Run an orchestration mission, or resume one with /mission resume <missionId>.",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("/mission <normal-language request> | /mission resume <missionId>", "error");
        return;
      }
      const resumePrefix = /^resume(?:\b|[:=])/i.test(request);
      const resume = /^resume\s+(\S+)\s*$/i.exec(request);
      if (resumePrefix && !resume) {
        ctx.ui.notify("/mission resume <missionId>", "error");
        return;
      }
      const rt = await getRuntime(ctx);
      if (!rt.orchestrator) {
        ctx.ui.notify("Orchestrator not initialized for this directory.", "error");
        return;
      }
      if (resume) {
        const missionId = resume[1];
        if (!missionId) {
          ctx.ui.notify("/mission resume <missionId>", "error");
          return;
        }
        if (await plannerWorker.resumeIfOwned(missionId, ctx)) return;
        try {
          activeControl?.missionProgress(`[mission ${missionId}] resuming`);
          await rt.resumeBlockedMission(missionId, ctx.signal);
          const mission = rt.missionStore?.getMission(missionId);
          if (!mission) throw new Error(`unknown mission ${missionId}`);
          ctx.ui.notify(`Recovery ${mission.mission_id} — ${mission.title} [${mission.status}]`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (await plannerWorker.runIfSelected(request, ctx)) return;
      const baseRef = (await rt.git?.headCommit().catch(() => "")) ?? "";
      ctx.ui.notify("Routing intent and running orchestration mission...", "info");
      // Stream live mission/task progress to the operator instead of blocking
      // silently for the whole worker budget (a long mission used to show one
      // line, then nothing for 30+ minutes). Each task/phase transition is
      // surfaced as a compact progress line as it happens.
      let lastLine = "";
      const result = await rt.orchestrator.orchestrate(request, {
        repository: rt.cwd,
        baseRef,
        mutationRequested: true,
        signal: ctx.signal,
        onProgress: (line) => {
          // De-duplicate the trailing completion lines (phase transitions and
          // task settlements can fire within the same tick).
          if (line === lastLine) return;
          lastLine = line;
          activeControl?.missionProgress(line);
          ctx.ui.notify(line, "info");
        },
      });
      const m = result.mission;
      const completion = result.paused
        ? "PAUSED — infrastructure retry window exhausted (auto-resumes on recovery; not a failure)"
        : result.completed
          ? "PASSED"
          : `BLOCKED — ${result.failureReason ?? ""}`;
      const lines = [
        `Mission ${m.mission_id} [${m.status}] workflow=${m.workflow_class} risk=${m.risk_profile}`,
        `Intent: ${result.intent.intent.join(", ")} (confidence ${result.intent.confidence.toFixed(2)})`,
        `Required gates: ${m.required_gates.join(", ") || "none"}`,
        `Tasks: ${rt.missionStore?.listTasks(m.mission_id).length ?? 0}`,
        `Completion: ${completion}`,
      ];
      // A paused mission is not a failure: notify as info, not error.
      ctx.ui.notify(lines.join("\n"), result.completed || result.paused ? "info" : "error");
    },
  });

  pi.registerCommand("mission-status", {
    description: "Show orchestration mission/task/execution status.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      const store = rt.missionStore;
      if (!store) {
        ctx.ui.notify("No orchestration store.", "error");
        return;
      }
      const missions = store.listMissions();
      if (missions.length === 0) {
        ctx.ui.notify("No missions yet. Run /mission <request>.", "info");
        return;
      }
      const lines = missions.slice(-10).map((m) => {
        const tasks = store.listTasks(m.mission_id);
        const summary = rt.missionObservability?.summary(m.mission_id);
        const currentGeneration = store.listMissionResumptions(m.mission_id).at(-1)?.generation ?? 0;
        const stop = store
          .listMissionStops(m.mission_id)
          .filter((candidate) => candidate.resumptionGeneration === currentGeneration)
          .at(-1);
        const acceptance = summary?.acceptanceCoverage;
        const acceptanceText =
          (acceptance?.total ?? m.acceptance_criteria.length) === 0
            ? `acceptance unavailable (${summary && tasks.length === 0 ? "no material criteria" : "legacy"})`
            : `acceptance ${acceptance?.completed ?? 0}/${acceptance?.total ?? m.acceptance_criteria.length} (${acceptance?.approximatePercent ?? 0}%)`;
        const derivedWorkflow = {
          completed: tasks.filter((task) => task.status === "SUCCEEDED").length,
          total: tasks.length,
        };
        const workflow =
          summary?.workflowProgress.total || derivedWorkflow.total === 0
            ? (summary?.workflowProgress ?? { ...derivedWorkflow, approximatePercent: 0 })
            : {
                ...derivedWorkflow,
                approximatePercent: Math.round((derivedWorkflow.completed / derivedWorkflow.total) * 100),
              };
        const recovery = summary?.recovery ?? { attempt: 0, maxAttempts: 0 };
        const preserved = stop?.preservedWork ?? summary?.preservedWork ?? [];
        return [
          `- ${m.mission_id} [${m.status}] rev ${m.revision} ${m.workflow_class} — ${m.title}`,
          `  ${acceptanceText} · workflow ${workflow.completed}/${workflow.total} (${workflow.approximatePercent}%) · health ${summary?.health ?? "unknown"}`,
          `  repo ${summary?.repository ?? m.repository} · task ${summary?.task ?? "none"} · owner ${summary?.owner ?? "unowned"} · last progress ${summary?.lastMeaningfulProgressAt ?? "none"}`,
          `  recovery ${recovery.attempt}/${recovery.maxAttempts}; attempted ${stop?.attemptedRecoveries.length ?? 0} · next: ${stop?.resumeCondition ?? summary?.nextAction ?? "No further action is scheduled"}${summary?.nextActionAt ? ` at ${summary.nextActionAt}` : ""}`,
          `  ${stop ? `stop: ${stop.reason}` : `action: ${summary?.action ?? m.status} — ${summary?.reason ?? "No additional reason recorded"}`} · preserved: ${preserved.join(", ") || "none"}`,
        ].join("\n");
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("engineer", {
    description: "Run the adaptive engineering workflow for a goal (scout -> implement -> verify -> review).",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/engineer <goal>", "error");
        return;
      }
      const rt = await getRuntime(ctx);
      ctx.ui.notify("Running engineering workflow (fresh scouts/implementer/reviewer)...", "info");
      const report = await rt.engineer(args.trim());
      const lines = [
        `Work item ${report.work_item.id} [${report.work_item.status}] risk=${report.risk}`,
        report.scout_summary ? `Scout: ${report.scout_summary.slice(0, 300)}` : "Scout: skipped (low risk)",
        report.review_summary ? `Review: ${report.review_summary.slice(0, 300)}` : "Review: none",
        `Incumbent: ${report.incumbent_candidate?.id ?? "none"} (outcome: ${report.outcome}, ${report.rounds} round(s))`,
        `Evidence: ${report.evidence_ids.join(", ") || "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), report.outcome === "promoted" ? "info" : "error");
    },
  });

  pi.registerCommand("tournament", {
    description:
      "Run a candidate tournament: N independent implementations, verify+review each, promote the deterministic winner.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/tournament <goal> [n]", "error");
        return;
      }
      const parts = args.trim().split(/\s+/);
      // Only a leading --parallel flag is treated as a flag; a goal that merely
      // contains the token elsewhere is left intact.
      const parallel = parts[0] === "--parallel";
      const cleaned = parallel ? parts.slice(1) : parts;
      const n = /\.\d+$/.test(cleaned[cleaned.length - 1]!) ? undefined : Number(cleaned.at(-1));
      const nCandidates = Number.isInteger(n) && n! >= 2 ? n! : 3;
      const goal = Number.isInteger(n) ? cleaned.slice(0, -1).join(" ") : cleaned.join(" ");
      const rt = await getRuntime(ctx);
      ctx.ui.notify(
        `Running candidate tournament (${nCandidates} independent candidates${parallel ? ", parallel" : ""})...`,
        "info",
      );
      const report = await rt.tournament(goal, { n: nCandidates, parallel });
      const winner = report.entries.find((e) => e.winner);
      const lines = [
        `Work item ${report.work_item.id} [${report.work_item.status}] risk=${report.risk}`,
        `Candidates: ${report.entries.map((e) => `${e.candidate.id}:${e.outcome.passed ? "pass" : "FAIL"}(${e.findings.length})`).join(" ")}`,
        `Winner: ${winner?.candidate.id ?? "none"} (outcome: ${report.outcome})`,
        `Evidence: ${report.evidence_ids.join(", ") || "none"}`,
      ];
      ctx.ui.notify(lines.join("\n"), report.outcome === "promoted" ? "info" : "error");
    },
  });

  pi.registerCommand("plan", {
    description:
      "Decompose a goal into a dependency-aware task DAG (recorded in the ledger), then run /execute to execute it.",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("/plan <goal>", "error");
        return;
      }
      const rt = await getRuntime(ctx);
      ctx.ui.notify("Planning task DAG (planner worker)...", "info");
      const report = await rt.plan(args.trim());
      const lines = [
        `Plan work item ${report.plan_work_item.id} [${report.plan_work_item.status}] outcome=${report.outcome}`,
        report.tasks.length
          ? report.tasks
              .map(
                (t) =>
                  `- ${t.id} [${t.risk}] ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(", ")})` : ""}`,
              )
              .join("\n")
          : "No tasks produced.",
        report.summary ? `Planner: ${report.summary.slice(0, 300)}` : "",
        `Run /execute ${report.plan_work_item.id} to execute this DAG.`,
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), report.outcome === "planned" ? "info" : "error");
    },
  });

  pi.registerCommand("execute", {
    description:
      "Execute a planned task DAG (from /plan) in dependency order, running each task through the engineer pipeline.",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const planId = args.trim() || rt.ledger.listWorkItems().at(-1)?.id;
      if (!planId) {
        ctx.ui.notify("/execute <plan-work-item-id>  (or run /plan first)", "error");
        return;
      }
      ctx.ui.notify("Executing task DAG (each task through scout->implement->verify->review)...", "info");
      let report;
      try {
        report = await rt.executePlan(planId);
      } catch (err) {
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        return;
      }
      const lines = [
        `Plan ${report.plan_work_item.id} [${report.plan_work_item.status}] outcome=${report.outcome}`,
        report.order.length
          ? report.order.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n")
          : "No tasks in DAG.",
        report.summary ? report.summary.split("\n").slice(0, 20).join("\n") : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), report.outcome === "completed" ? "info" : "error");
    },
  });

  pi.registerCommand("ledger", {
    description: "Show compact engineering state (work items, candidates, entities).",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const kind = args.trim();
      const sections = [
        "=== Work items ===",
        formatWorkItems(rt),
        "",
        kind ? `=== Entities: ${kind} ===` : "=== Entities ===",
        formatEntities(rt, kind || undefined),
      ];
      ctx.ui.notify(sections.join("\n"), "info");
    },
  });

  pi.registerCommand("context", {
    description: "Show current context budget, sources, and worker usage.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      const usage = ctx.getContextUsage?.();
      const lines = [
        "=== Context ===",
        usage?.tokens != null ? `Active session tokens: ${usage.tokens}` : "Active session tokens: unavailable",
        `Ledger events: ${rt.ledger.count()}`,
        `Artifacts: ${rt.artifacts.list().length}`,
        `Repo indexed: ${rt.broker ? "yes" : "no"}`,
        `Role budgets (target/hard): scout 10k/24k, implementer 16k/40k, reviewer 10k/24k`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("verify", {
    description:
      "Run risk-appropriate verification and record deterministic evidence. Use '/verify full' for a broader suite (lint + test:full).",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const full = /\bfull\b/.test(args.trim());
      ctx.ui.notify(
        full ? "Detecting FULL verification profile (lint + test:full)..." : "Detecting verification profile...",
        "info",
      );
      const profile = await rt.verifier.detect(rt.cwd, { full });
      const outcome = await rt.verifier.run(rt.cwd, profile, rt.artifacts);
      // Record deterministic evidence into the ledger (linked to the latest
      // work item / candidate so it is not discarded).
      const wi = rt.ledger.listWorkItems().at(-1);
      const actor = { type: "user" as const };
      const evidenceIds: string[] = [];
      for (const ev of outcome.evidence) {
        const recorded = await rt.ledger.recordEvidence(
          wi?.current_candidate_id ?? null,
          ev.type,
          ev.tool,
          ev.command,
          ev.exit_code,
          ev.status,
          ev.summary,
          ev.artifacts,
          ev.trust,
          wi?.id ?? null,
          actor,
        );
        evidenceIds.push(recorded.id);
      }
      const lines = [
        evidenceIds.length ? `Evidence recorded: ${evidenceIds.join(", ")}` : "No evidence recorded.",
        `Profile: ${profile.name} (${profile.stages.map((s) => s.name).join(", ") || "none"})`,
        `Result: ${outcome.passed ? "PASSED" : "FAILED"}${outcome.failedStage ? ` at ${outcome.failedStage}` : ""}`,
        ...outcome.stages.map(
          (s) => `- ${s.stage.name}: ${s.passed ? "pass" : "FAIL"} (exit ${s.exitCode}) log: ${s.artifactUri}`,
        ),
      ];
      ctx.ui.notify(lines.join("\n"), outcome.passed ? "info" : "error");
    },
  });

  pi.registerCommand("review", {
    description: "Launch a fresh-context independent review of the current work item's candidate.",
    handler: async (_args, ctx) => {
      const rt = await getRuntime(ctx);
      const wi = rt.ledger.listWorkItems().at(-1);
      if (!wi) {
        ctx.ui.notify("No work item to review. Run /engineer <goal> first.", "error");
        return;
      }
      const candidate = wi.current_candidate_id ? rt.ledger.getCandidate(wi.current_candidate_id) : undefined;
      if (!candidate) {
        ctx.ui.notify("No candidate to review.", "error");
        return;
      }
      ctx.ui.notify(`Spawning fresh-context reviewer for ${candidate.id}...`, "info");
      const rev = await rt.review(wi, candidate, wi.goal);
      ctx.ui.notify(rev.summary.slice(0, 600) || "Review complete.", "info");
    },
  });

  pi.registerCommand("challenge", {
    description: "Run a clean-room challenge of the current approach.",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      const goal = args.trim() || rt.ledger.listWorkItems().at(-1)?.goal;
      if (!goal) {
        ctx.ui.notify("No goal to challenge.", "error");
        return;
      }
      ctx.ui.notify("Spawning clean-room challenger (no prior reasoning)...", "info");
      const result = await rt.challenge(
        rt.ledger.listWorkItems().at(-1) ??
          (await rt.ledger.createWorkItem(goal, "medium", [rt.cwd], { type: "user" })),
        goal,
        "",
      );
      ctx.ui.notify(`Challenger: ${result?.summary.slice(0, 600) ?? "no challenge produced"}`, "info");
    },
  });

  pi.registerCommand("blackhole", {
    description: "Show Blackhole session-memory status for this runtime (disabled by default).",
    handler: async (args, ctx) => {
      const rt = await getRuntime(ctx);
      if (!rt.blackhole) {
        ctx.ui.notify("Blackhole is not configured for this runtime (optional adapter).", "info");
        return;
      }
      const { formatBlackholeTelemetry, blackholeTelemetry } = await import("../src/blackhole/telemetry.ts");
      const { panelHealth, panelPromotion, panelDurable, panelEntries } = await import("../src/blackhole/dashboard.ts");
      const t = blackholeTelemetry(rt.blackhole.state());
      const durable = await rt.blackhole.durable.recallAll();
      const panels = [panelHealth(t), panelPromotion(t), panelDurable(durable)];
      const head = formatBlackholeTelemetry(t);
      if (args.includes("--dashboard")) {
        ctx.ui.notify(`${head}\n\n${panels.map((p) => `${p.title}: ${p.rows.length} row(s)`).join("\n")}`, "info");
      } else {
        ctx.ui.notify(head, "info");
      }
    },
  });

  pi.registerCommand("roadmap-status", {
    description: "Show derived Roadmap 1.0 completion status for this repository.",
    handler: async (args, ctx) => {
      const repo = await GitRepo.open(ctx.cwd).catch(() => null);
      if (!repo) {
        ctx.ui.notify("Not inside a git work tree.", "error");
        return;
      }
      const root = repo.root;
      const roadmapPath = resolve(root, "docs/roadmap/roadmap.yaml");
      const manualEvidencePath = resolve(root, "docs/roadmap/evidence.yaml");
      const evidenceFile = resolve(root, ".pi-eng/roadmap/evidence.jsonl");
      try {
        const engine = await RoadmapEngine.open({
          repoRoot: root,
          roadmapPath,
          manualEvidencePath,
          evidenceFile,
        });
        const detail = await engine.evaluate();
        const lines = [
          `Roadmap ${detail.roadmapId}@${detail.version}`,
          `complete: ${detail.complete}`,
          `release gate: ${detail.releaseGate.pass ? "PASS" : "FAIL"}`,
        ];
        for (const m of detail.milestones) {
          lines.push(`- ${m.milestone.id} ${m.milestone.name}: ${m.state}`);
          for (const b of m.blockers.slice(0, 3)) lines.push(`    • ${b}`);
        }
        ctx.ui.notify(lines.join("\n").slice(0, 1800), "info");
      } catch (err) {
        ctx.ui.notify(`roadmap error: ${String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("harness-status", {
    description: "Show the fully resolved live status-bar state (cwd, repo, worktree, branch, model, TPS).",
    handler: async (_args, ctx) => {
      const footer = activeFooter;
      if (!footer) {
        ctx.ui.notify("Status bar disabled or not active in this session.", "info");
        return;
      }
      const s = footer.state;
      const t = footer.throughputSnapshot();
      const lines = [
        `cwd: ${s.cwd}`,
        `repository: ${s.repository ?? "—"}`,
        `repository root: ${s.repositoryRoot ?? "—"}`,
        `worktree: ${s.worktree ?? "—"}`,
        `branch/ref: ${s.branch ?? (s.detachedHead ? `@${s.detachedHead}` : "—")}`,
        `provider: ${s.provider ?? "—"}`,
        `model: ${s.model ?? "—"}`,
        `TPS state: ${t.phase}`,
        `TPS current: ${t.currentTokensPerSecond != null ? t.currentTokensPerSecond.toFixed(1) : "—"}`,
        `TPS last completed: ${t.lastCompletedTokensPerSecond != null ? t.lastCompletedTokensPerSecond.toFixed(1) : "—"}`,
        `output tokens: ${t.outputTokens ?? "—"}`,
        `render: ${renderStatus(s, 120, statusBarConfig)}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("pi-engineering", {
    description:
      "Engineering runtime introspection: `status` (default), `events` (recent runtime decisions), `doctor [--repair]`.",
    handler: async (args, ctx) => {
      const words = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = words[0] ?? "status";
      if (sub === "status" || sub === "events") {
        // Opening the runtime for this cwd binds an unbound session first.
        await resolveServices(ctx.cwd);
        const report = runtimeStatus({ events: sub === "events" ? 25 : 0 });
        ctx.ui.notify(formatRuntimeStatus(report), "info");
        return;
      }
      if (sub === "doctor") {
        const report = await runDoctor({ cwd: runtimeCwd(ctx.cwd), repair: words.includes("--repair") });
        ctx.ui.notify(formatDoctorReport(report), report.fatal ? "error" : "info");
        return;
      }
      ctx.ui.notify("/pi-engineering [status | events | doctor [--repair]]", "error");
    },
  });

  // The runtime and ledger are opened lazily on first command or tool use, so
  // no durable state is created until engineering work actually begins.
}
