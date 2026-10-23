import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { MissionAttentionReporter } from "../src/runtime/herdr/MissionAttentionReporter.ts";
import { createIngestFromEnv } from "../src/runtime/herdr/ingestFromEnv.ts";
import { formatMissionInspection, missionActivityAge } from "../src/tools/missionReport.ts";

import type { Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveMemoryEnvironment } from "../src/blackhole/connectionSetup.ts";
import { openVikingBlackholeOption } from "../src/blackhole/envConfig.ts";
import { registerInteractiveMemory } from "../src/blackhole/interactiveMemory.ts";
import { registerAutoCompaction } from "../src/compaction/autoTune.ts";
import { type InferweaveProvider, createInferweaveProvider, inferweaveConfigFromEnv } from "../src/context/provider.ts";
import { contextReading, planModelSwitch } from "../src/context/usage.ts";
import { gatewayWaitLabel } from "../src/gateway/admissionNotice.ts";
import { AdvisedModelSwitch } from "../src/gateway/advisedSwitch.ts";
import { AfterOutputRetry } from "../src/gateway/afterOutputRetry.ts";
import { sharedAdmissionController, sharedGatewayConfig } from "../src/gateway/config.ts";
import {
  type FallbackApplyDeps,
  type FallbackContext,
  FallbackCoordinator,
  type PendingFallback,
  applyPendingFallback,
  previewFallback,
} from "../src/gateway/fallbackLifecycle.ts";
import {
  installGatewayStreamRetry,
  installedGatewayStreamRetries,
  isGatewayStreamRetryLive,
} from "../src/gateway/installStreamRetry.ts";
import { SettleRecovery, describeDecision, settleRecoveryEnabled } from "../src/gateway/settleRecovery.ts";
import {
  advisesAlternateModel,
  describeGatewayWait,
  gatewayHoldScope,
  isAccountWideRefusal,
  parseGatewayWait,
} from "../src/gateway/signals.ts";
import { renderGatewayReport } from "../src/gateway/statusReport.ts";
import { registerTerminalRefusalGuard } from "../src/gateway/terminalRefusalGuard.ts";
import { GitRepo } from "../src/git/GitRepo.ts";
import { GenerationGuard } from "../src/guard/GenerationGuard.ts";
import { RECOVERY_PROMPT, TOOL_TRANSITION_RULE, buildDegenerationEvent } from "../src/guard/RecoveryController.ts";
import { resolveGuardConfig } from "../src/guard/config.ts";
import { registerPrimaryWorktreeGuard } from "../src/guard/primaryWorktreeGuard.ts";
import { guardFeedFor } from "../src/guard/streamText.ts";
import { registerToolCallGuard } from "../src/guard/toolCallGuard.ts";
import { admissionIdentityHeaders } from "../src/inference/admissionTransport.ts";
import { ModelHealthProvider } from "../src/models/health.ts";
import { defaultModelsPath, providerBaseUrl, readModelsConfig, writeModelsConfig } from "../src/models/modelsConfig.ts";
import { describeProviderSync, parseCanonicalProviders, planProviderSync } from "../src/models/providerSync.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, refreshConfiguredProviders } from "../src/models/refresh.ts";
import { registerModelTabs } from "../src/models/registerModelTabs.ts";
import {
  fetchCanonicalText,
  parseSyncSource,
  readCheckOnStart,
  readSyncSourceSetting,
} from "../src/models/syncSource.ts";
import {
  MISSION_UNAVAILABLE_RETRY_TURNS,
  decideAutoInvoke,
  missionToolReportedUnavailable,
} from "../src/orchestration/autoInvoke.ts";
import { MISSION_FLAGS_USAGE, parseMissionFlags } from "../src/orchestration/missionFlags.ts";
import { assertRootMissionAllowed, chooseMode, readAutospecFlags } from "../src/orchestration/missionMode.ts";
import {
  buildModelErrorRollups,
  explainMission,
  formatMissionWhy,
  formatModelErrors,
} from "../src/orchestration/missionWhy.ts";
import { PanelState } from "../src/panel/PanelState.ts";
import { LedgerFeeder } from "../src/panel/feeders/LedgerFeeder.ts";
import { DEFAULT_WORKSPACE_TTL_MS, WorkspaceFeeder } from "../src/panel/feeders/WorkspaceFeeder.ts";
import { PanelRefreshLoop } from "../src/panel/refreshLoop.ts";
import { registerPlannerWorker } from "../src/plannerWorker/extension.ts";
import { redactSecrets } from "../src/platform/redact.ts";
import { resolveRequestBodyBudgetConfig } from "../src/request/bodyBudget.ts";
import {
  type ThinkingContext,
  isSummarizationRequest,
  resolveThinkingOffConfig,
} from "../src/request/thinkingPolicy.ts";
import { RoadmapEngine } from "../src/roadmap/RoadmapEngine.ts";
import { EngineeringRuntime, type RuntimeMissionActivityEvent } from "../src/runtime/EngineeringRuntime.ts";
import { attachInspectorWhenReady, createInspectorSlot } from "../src/runtime/herdr/attachInspector.ts";
import { getHostMaintenance } from "../src/runtime/host/maintenance.ts";
import { gitRunner } from "../src/runtime/host/sourceWatch.ts";
import { sessionBindingInfo } from "../src/runtime/isolation/RuntimeBinding.ts";
import { RuntimeSession } from "../src/runtime/isolation/RuntimeSession.ts";
import { effectiveWorkspace, workspaceForPath } from "../src/runtime/isolation/WorkspaceResolver.ts";
import { formatDoctorReport, runDoctor } from "../src/runtime/isolation/doctor.ts";
import { emitRuntimeEvent } from "../src/runtime/isolation/runtimeEvents.ts";
import { formatRuntimeStatus, runtimeStatus } from "../src/runtime/isolation/status.ts";
import { describeHousekeeping, housekeepingMode, runHousekeeping } from "../src/runtime/janitor.ts";
import {
  clearOperatorModelPin,
  describeMissionControl,
  describeModelChoice,
  onOperatorModelSelect,
  resetSessionModelChoice,
  sessionModelChoice,
} from "../src/runtime/operatorModelPin.ts";
import {
  type MissionBrief,
  type SessionControlServer,
  startSessionControl,
} from "../src/sessionControl/SessionControl.ts";
import { maintenanceHandler } from "../src/sessionControl/runtimeMaintenance.ts";
import { resolveStatusBarConfig } from "../src/status/config.ts";
import { FooterController } from "../src/status/footer.ts";
import { renderStatus } from "../src/status/layout.ts";
import { WorkingStatusController } from "../src/status/working.ts";
import { type TelemetryNotice, emitTelemetry, setTelemetrySink } from "../src/telemetry/sink.ts";
import { createRepeatThrottle } from "../src/telemetry/throttle.ts";
import { type CoreServices, buildCoreTools, notInitializedText } from "../src/tools/coreTools.ts";
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

/** Removes this session's telemetry sink. */
let telemetryUninstall: (() => void) | undefined;

/**
 * Periodic refresh of the data the footer's ambient row summarises, for the
 * life of the session.
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
    },
  });
  panelRefresh.start();
}

function stopPanelRefresh(): void {
  panelRefresh?.stop();
  panelRefresh = null;
}

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
  const attentionIngest = createIngestFromEnv(process.env);
  const attention = attentionIngest ? new MissionAttentionReporter(attentionIngest) : null;
  let attentionReady = false;
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
    onMissionActivity: (event) => {
      publishMissionActivity(key, event);
      if (attentionReady) void attention?.update(event).catch(() => {});
    },
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
  }).then((runtime) => {
    // Reconnect establishes a baseline; old terminal/stalled missions must not alert again.
    for (const mission of runtime.missionStore?.listMissions() ?? []) {
      const summary = runtime.missionObservability?.summary(mission.mission_id);
      if (summary) attention?.seed({ ...summary, operatorPausedAt: mission.operator_paused_at });
    }
    attentionReady = true;
    return { runtime, memoryIdentity };
  });
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
  missionStatus: { token: string; reason: string; next: string; live?: string };
} {
  const now = event.observedAt ? Date.parse(event.observedAt) : Date.now();
  const age = (at?: string | null) => missionActivityAge(at, now);
  const liveWorkers = event.workersDetail?.filter((entry) => entry.status === "running" || entry.status === "waiting");
  const worker =
    liveWorkers?.find((entry) => entry.health === "stalled") ??
    liveWorkers?.[0] ??
    event.workersDetail?.find((entry) => entry.status === "failed" || entry.status === "completed");
  const activity = (worker?.currentActivity ?? event.summary).replace(/\s+/g, " ").slice(0, 100);
  const duration = worker?.currentActivityStartedAt ? ` for ${age(worker.currentActivityStartedAt)}` : "";
  const lastHeartbeat = worker ? worker.lastHeartbeatAt : event.lastHeartbeatAt;
  const lastProgress = worker ? worker.lastMeaningfulProgressAt : event.lastMeaningfulProgressAt;
  const heartbeat = ` · heartbeat ${age(lastHeartbeat)}${lastHeartbeat ? " ago" : ""}`;
  const lastOutput = worker ? worker.lastOutputAt : event.lastOutputAt;
  const output = `output ${age(lastOutput)}${lastOutput ? " ago" : ""}`;
  const progress = `progress ${age(lastProgress)}${lastProgress ? " ago" : ""}`;
  const model = worker?.model ? ` · ${worker.route ? `${worker.route} → ` : ""}${worker.model}` : "";
  const waiting = event.waitingReason
    ? ` · wait ${event.waitingReason.replaceAll("_", " ")}${event.waitingSince ? ` for ${age(event.waitingSince)}` : ""}`
    : "";
  const live = `${event.health.toUpperCase()} · ${activity.slice(0, 36)}${duration} · ${output}`;
  const workers = ` · workers ${event.activeWorkers} active/${event.waitingWorkers} waiting/${event.failedWorkers} failed`;

  const compact = (value: string | null, fallback: string, length = 80) => (value ?? fallback).slice(0, length);
  const scope =
    `repo ${compact(event.repository, "unknown")} · task ${compact(worker?.taskId ?? event.task, "none")} · ` +
    `owner ${compact(event.owner, "unowned")}`;
  const recovery = `recovery ${event.recovery.attempt}/${event.recovery.maxAttempts}`;
  const next = `next ${event.nextAction.slice(0, 120)}${event.nextActionAt ? ` at ${event.nextActionAt}` : ""}`;
  const preserved =
    event.preservedWork.length > 0 ? ` · preserved ${event.preservedWork.join(", ").slice(0, 120)}` : "";
  const nextVerb = event.nextAction.trim().split(/\s+/)[0]?.slice(0, 12) || "monitor";
  const recoveryToken =
    event.recovery.maxAttempts > 0 ? `R${event.recovery.attempt}/${event.recovery.maxAttempts}` : "R–";
  const pausedByOperator = event.operatorPausedAt
    ? `PAUSED by operator at ${event.operatorPausedAt} — automatic repair is off; resume with /mission resume ${event.missionId} (add --model auto to release a model pin)`
    : null;
  const pin = event.operatorModelPin ? ` · model: ${event.operatorModelPin} (operator pin)` : "";
  const token = pausedByOperator
    ? `${recoveryToken} PAUSED (operator)`
    : `${recoveryToken} ${event.action.slice(0, 12).toUpperCase()}→${nextVerb}`;
  return {
    phase:
      `acceptance ${event.acceptanceCoverage.completed}/${event.acceptanceCoverage.total} ` +
      `(${event.acceptanceCoverage.approximatePercent}%) · workflow ${event.workflowProgress.completed}/` +
      `${event.workflowProgress.total} (${event.workflowProgress.approximatePercent}%) · ${event.health}`,
    detail:
      `Now: ${activity}${duration} · ${output}${heartbeat} · ${progress}${model}${waiting}${workers} · ${scope} · ` +
      `${recovery}${preserved} · ${event.action}: ${event.reason.slice(0, 120)} · ${next}${pin}`,
    missionStatus: pausedByOperator
      ? { token, reason: "paused by the operator (Esc); automatic repair is off", next: pausedByOperator }
      : {
          token,
          live,
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
    resumeMission: (id, s) => rt.resumeBlockedMission(id, s),
    cancelMission: (id) => rt.cancelMission(id),
    clearMissionModelPin: (id) => rt.clearMissionModelPin(id),
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
  let working: WorkingStatusController | undefined;
  let workingSignal: AbortSignal | undefined;
  if (typeof pi.on === "function") registerTerminalRefusalGuard(pi);
  registerModelTabs(pi);
  registerInteractiveMemory(pi);
  /** True while our own (opt-in) fallback switches the interactive model. */
  let automaticModelSwitch = false;
  // Agent-inspector feed to Herdr: OFF unless this host's central fleet config
  // (~/.config/herdr-engineering/host.json) sets inspector.enabled. Loaded in the
  // background with a short timeout so session start never waits on the network;
  // a missing config or unreachable control plane simply means no inspector.
  // Best-effort and bounded; see docs/split-view-and-inspector.md.
  const inspector = createInspectorSlot();
  void attachInspectorWhenReady(pi, {
    modelReason: () => (automaticModelSwitch ? "fallback" : undefined),
  })
    .then((handle) => {
      inspector.set(handle);
    })
    .catch(() => {});
  // Housekeeping: reclaim worktrees abandoned by crashed or killed runs and
  // expire unused Rust target caches. Live missions keep their worktrees, and
  // uncommitted work is committed to its branch before a checkout goes away,
  // so this is safe to run at session start and periodically while the
  // session stays open. Never awaited: a slow sweep must not delay a session.
  const housekeepingIntervalMs = Number(process.env.PI_HOUSEKEEPING_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  // Report-only until PI_HOUSEKEEPING=1: liveness of missions run by other
  // processes is not proven in production yet. `/gc` always acts.
  const hkMode = housekeepingMode(process.env);
  const housekeepingEnabled = hkMode !== "off";
  // First sweep waits this long so a session that reloads or exits at once
  // never starts git children; cancellable together with the interval.
  const housekeepingFirstRunMs = Number(process.env.PI_HOUSEKEEPING_FIRST_RUN_MS ?? 30_000);
  let housekeepingTimer: NodeJS.Timeout | null = null;
  let housekeepingFirstTimer: NodeJS.Timeout | null = null;
  let housekeepingAbort: AbortController | null = null;
  const stopHousekeeping = () => {
    if (housekeepingTimer) clearInterval(housekeepingTimer);
    if (housekeepingFirstTimer) clearTimeout(housekeepingFirstTimer);
    housekeepingTimer = null;
    housekeepingFirstTimer = null;
    housekeepingAbort?.abort();
    housekeepingAbort = null;
  };
  const housekeep = async (cwd: string, notify: (text: string, level: "info" | "warning") => void) => {
    const signal = housekeepingAbort?.signal;
    const runtime = await getRuntimeByCwd(cwd).catch(() => null);
    signal?.throwIfAborted();
    const result = await runHousekeeping({
      cwd,
      missions: runtime?.missionStore,
      dryRun: hkMode !== "on",
      signal,
    });
    const lines = describeHousekeeping(result);
    if (lines.length > 0)
      notify(`[housekeeping] ${lines.join("\n")}`, result.worktrees?.failed.length ? "warning" : "info");
  };
  if (housekeepingEnabled && typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      const notify = ctx.hasUI ? (text: string, level: "info" | "warning") => ctx.ui.notify(text, level) : () => {};
      stopHousekeeping();
      housekeepingAbort = new AbortController();
      housekeepingFirstTimer = setTimeout(
        () => void housekeep(ctx.cwd, notify).catch(() => {}),
        housekeepingFirstRunMs,
      );
      housekeepingFirstTimer.unref();
      if (housekeepingIntervalMs > 0) {
        housekeepingTimer = setInterval(() => void housekeep(ctx.cwd, notify).catch(() => {}), housekeepingIntervalMs);
        housekeepingTimer.unref();
      }
    });
    pi.on("session_shutdown", stopHousekeeping);
  }
  pi.registerCommand("gc", {
    description: "Reclaim abandoned candidate worktrees and expired Rust build caches (--dry-run to preview).",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const dryRun = argv.includes("--dry-run");
      const runtime = await getRuntimeByCwd(ctx.cwd).catch(() => null);
      const result = await runHousekeeping({ cwd: ctx.cwd, missions: runtime?.missionStore, dryRun });
      const lines = describeHousekeeping(result, { verbose: true });
      ctx.ui.notify(
        lines.length > 0 ? lines.join("\n") : "Nothing to reclaim.",
        result.worktrees?.failed.length ? "warning" : "info",
      );
    },
  });
  // One control socket per live PI session. The socket answers directly while
  // a mission tool is awaiting a worker; another PI process never opens this
  // session's transcript or writes its event store to ask for status.
  let activeControl: SessionControlServer | null = null;
  let maintenanceCompacting = false;
  if (typeof pi.on === "function") {
    pi.on("session_before_compact", () => {
      maintenanceCompacting = true;
    });
    pi.on("session_compact", () => {
      maintenanceCompacting = false;
    });
    pi.on("session_compact_failed", () => {
      maintenanceCompacting = false;
    });
    pi.on("session_start", async (_event, ctx) => {
      await activeControl?.close();
      activeControl = null;
      maintenanceCompacting = false;
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;
      try {
        const ownedMissions = async (): Promise<MissionBrief[]> => {
          await getRuntimeByCwd(runtimeCwd(ctx.cwd)).catch(() => null);
          return (
            await Promise.all(
              [...runtimes.values()].map(async ({ runtime }) => {
                const store = runtime.missionStore;
                if (!store) return [];
                store.syncExternal();
                const owned = new Set(await runtime.maintenanceOwnedMissionIds());
                return store
                  .listMissions((mission) => owned.has(mission.mission_id))
                  .map((mission) => {
                    const summary = runtime.missionObservability?.summary(mission.mission_id);
                    const generation = store.listMissionResumptions(mission.mission_id).at(-1)?.generation ?? 0;
                    const wait = store
                      .listRecoveryDecisions(mission.mission_id)
                      .filter(
                        (decision) =>
                          (decision.resumptionGeneration ?? 0) === generation &&
                          ["WAIT_FOR_REQUIREMENT", "PROBE_AND_BACKOFF", "PAUSE_FOR_PERSISTENCE"].includes(
                            decision.action,
                          ) &&
                          (decision.status === "planned" || decision.status === "started"),
                      )
                      .at(-1);
                    const humanWait = wait?.action === "WAIT_FOR_REQUIREMENT";
                    const operatorPaused = !!mission.operator_paused_at;
                    return {
                      id: mission.mission_id,
                      status: mission.status,
                      revision: mission.revision,
                      resumptionGeneration: generation,
                      operatorPaused,
                      resumeEligible:
                        !operatorPaused &&
                        !humanWait &&
                        ["BLOCKED", "PAUSED_INFRASTRUCTURE", "REPAIRING"].includes(mission.status),
                      health: summary?.health ?? null,
                      lastHeartbeatAt: summary?.lastHeartbeatAt ?? null,
                      lastMeaningfulProgressAt: summary?.lastMeaningfulProgressAt ?? null,
                      tasks: store
                        .listTasks(mission.mission_id)
                        .slice(-40)
                        .map((task) => ({ id: task.task_id, status: task.status })),
                      lastError: mission.failure_reason ? redactSecrets(mission.failure_reason).slice(0, 200) : null,
                      ...(wait
                        ? {
                            namedWait: {
                              action: wait.action,
                              nextActionAt: wait.nextActionAt,
                              deadline: wait.deadline,
                            },
                          }
                        : {}),
                    };
                  });
              }),
            )
          ).flat();
        };
        const isInteractiveIdle = () => !maintenanceCompacting && ctx.isIdle() && !ctx.hasPendingMessages?.();
        activeControl = await startSessionControl({
          cwd: ctx.cwd,
          sessionId,
          getOwnedMissions: ownedMissions,
          getRuntime: async () => {
            const host = getHostMaintenance();
            if (!host) return undefined;
            const description = await host.describe();
            return {
              ...description,
              interactiveIdle: isInteractiveIdle(),
              capabilities: [
                ...new Set([
                  ...description.capabilities,
                  "runtime.prepare",
                  "mission.resumeAfterMaintenance",
                  "mission.resume.selected-model.v1",
                ]),
              ],
            };
          },
          onMaintenance: maintenanceHandler({
            isInteractiveIdle,
            getHost: getHostMaintenance,
            getRuntime: async (missionId) => {
              const active = await getRuntimeByCwd(runtimeCwd(ctx.cwd)).catch(() => null);
              if (missionId) {
                const matches: EngineeringRuntime[] = [];
                for (const { runtime } of runtimes.values()) {
                  if ((await runtime.maintenanceOwnedMissionIds()).includes(missionId)) matches.push(runtime);
                }
                return matches.length === 1 ? matches[0]! : null;
              }
              if (!active) return null;
              return {
                endMaintenance: () => {
                  for (const { runtime } of runtimes.values()) runtime.endMaintenance();
                },
                prepareForMaintenance: async (options) => {
                  for (const { runtime } of runtimes.values()) {
                    const result = await runtime.prepareForMaintenance(options);
                    if (result.status !== "ready") return result;
                  }
                  return { status: "ready" };
                },
              };
            },
            ownedMissionIds: async () => (await ownedMissions()).map((mission) => mission.id),
          }),
          onNote: ctx.hasUI ? (note) => ctx.ui.notify(`[PI session note] ${redactSecrets(note)}`, "info") : undefined,
          getMissions: async (missionIds) => {
            const runtime = await getRuntimeByCwd(runtimeCwd(ctx.cwd)).catch(() => null);
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

  // ─── Operator model pin: missions follow an explicit /model switch ───────
  // The operator's switch becomes this session's operator pin; its missions
  // adopt it at their next worker dispatch (src/runtime/operatorModelPin.ts).
  // Automatic fallback of the interactive model stays opt-in and is not a pin.
  if (typeof pi.on === "function") {
    pi.on("session_start", (event, ctx) => {
      if (event.reason === "reload") return;
      const sessionId = RuntimeSession.current().sessionId;
      resetSessionModelChoice(sessionId, ctx.model);
      // The pin is process-wide; a fresh conversation (/new) explicitly
      // returns this process's missions to automatic routing.
      if (event.reason === "new") clearOperatorModelPin(sessionId);
    });
    pi.on("model_select", (event, ctx) => {
      const outcome = onOperatorModelSelect(RuntimeSession.current().sessionId, {
        model: event.model,
        source: event.source,
        automatic: automaticModelSwitch,
      });
      if (outcome.action === "pinned") {
        ctx.ui.notify(
          `Missions from this session now use ${outcome.pin.provider}/${outcome.pin.id} (operator pin) from their next worker dispatch. /engineering-model auto returns them to automatic routing.`,
          "info",
        );
      } else if (outcome.action === "cleared") {
        ctx.ui.notify(`Operator model pin cleared (${outcome.reason}); missions return to automatic routing.`, "info");
      }
    });
  }
  pi.registerCommand("engineering-model", {
    description: "Show the model this session's missions use, or `auto` to clear the operator pin set by /model.",
    handler: async (args, ctx) => {
      const sessionId = RuntimeSession.current().sessionId;
      const want = (args ?? "").trim();
      if (want === "auto") {
        clearOperatorModelPin(sessionId);
        // Also release the pins already stored on this session's missions.
        const released: string[] = [];
        for (const entry of runtimes.values()) {
          released.push(...(await entry.runtime.releaseSessionMissionPins().catch(() => [])));
        }
        ctx.ui.notify(
          `Operator model pin cleared; missions return to automatic routing at their next dispatch${released.length > 0 ? ` (released: ${released.join(", ")})` : ""}.`,
          "info",
        );
        return;
      }
      if (want) {
        ctx.ui.notify("/engineering-model [auto] — pin a model for missions by switching with /model", "error");
        return;
      }
      ctx.ui.notify(describeModelChoice(sessionModelChoice(sessionId)), "info");
    },
  });

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
  // User turns since the tool reported unavailable; after
  // MISSION_UNAVAILABLE_RETRY_TURNS auto-invoke tries the tool again.
  let turnsSinceMissionUnavailable = 0;
  // The auto-invoke handler uses pi.on(), which is only available in a real pi
  // session (not in the smoke-test stub). Guard accordingly.
  if (typeof pi.on === "function") {
    // Identical-tool-call loops and unbounded bash test/build runs
    // (src/guard/toolCallGuard.ts; knobs in docs/usage.md, "Tool-call guard").
    registerToolCallGuard(pi as never);
    // One agent, one worktree (AGENTS.md), enforced: block this session's own
    // mutating calls against a repository's PRIMARY checkout so concurrent
    // sessions cannot destroy each other's uncommitted work there. Production
    // ops sessions set PI_ENG_PRIMARY=1; PI_ENG_WORKTREE_GUARD=0 disables
    // (src/guard/primaryWorktreeGuard.ts; docs/usage.md, "Primary worktree guard").
    registerPrimaryWorktreeGuard(pi as never, () => process.cwd());
    pi.on("tool_result", async (event) => {
      if (event.toolName !== "mission") return;
      const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      // A later mission call that the runtime served clears a transient
      // not-initialized (e.g. the runtime opened after a lock was released).
      if (missionToolReportedUnavailable(text)) {
        missionToolUnavailable = true;
        turnsSinceMissionUnavailable = 0;
      } else if (!event.isError) missionToolUnavailable = false;
    });
    pi.on("before_agent_start", async (event, ctx) => {
      const prompt = (event.prompt ?? "").trim();
      if (missionToolUnavailable && ++turnsSinceMissionUnavailable > MISSION_UNAVAILABLE_RETRY_TURNS) {
        missionToolUnavailable = false;
      }
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

  // The same unattended, tty-less runner the auto-reload watcher uses.
  const runGit = gitRunner(extensionRoot);

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
  /**
   * The one place a provider's model list is edited. `/model-refresh` runs it
   * directly and `/model-sync` calls it after aligning provider settings, so
   * there is a single writer of models to reason about.
   */
  async function refreshModels(
    ctx: ExtensionCommandContext,
    opts: {
      providerIds?: string[];
      dryRun: boolean;
      pruneMissing: boolean;
      probeTimeoutMs?: number;
      useConfiguredBaseUrl?: boolean;
    },
  ): Promise<{ written: boolean; lines: string[]; failed: boolean }> {
    // Unlike status-only commands, refresh must surface malformed JSON:
    // treating it as an empty config could overwrite the operator's file.
    const configuredProviders = Object.keys(readModelsConfig(defaultModelsPath()).providers ?? {});
    const providerIds =
      opts.providerIds ??
      (configuredProviders.length > 0 ? configuredProviders : ctx.model?.provider ? [ctx.model.provider] : []);
    if (providerIds.length === 0) {
      throw new Error("No provider to refresh. Select a model first, or pass a provider name.");
    }

    const probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
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
          ...(resolved.auth.baseUrl && !opts.useConfiguredBaseUrl ? { baseUrl: resolved.auth.baseUrl } : {}),
        };
      },
      ...(opts.dryRun ? { dryRun: true } : {}),
      ...(opts.pruneMissing ? { pruneMissing: true } : {}),
      probeModels: true,
      probeTimeoutMs,
      onProgress: (progress) => {
        const percent = progress.total > 0 ? Math.floor((progress.completed * 100) / progress.total) : 0;
        const filled = Math.floor(percent / 10);
        const bar = `[${"#".repeat(filled)}${"-".repeat(10 - filled)}]`;
        const summary =
          progress.phase === "listing"
            ? `${progress.providerId}: discovering models…`
            : `${progress.providerId} ${bar} ${percent}% (${progress.completed}/${progress.total} probed)`;
        const timing = progress.attempt
          ? ` · attempt ${progress.attempt}/2 · ${Math.floor(progress.elapsedMs / 1000)}s / ${(progress.timeoutMs ?? probeTimeoutMs) / 1000}s`
          : "";
        const detail =
          progress.phase === "complete"
            ? "Probes finished; preparing results…"
            : progress.phase === "listing"
              ? "Fetching gateway catalogue…"
              : `Probing ${progress.modelId}${progress.backingModel ? ` → ${progress.backingModel} (alias)` : ""}${timing}`;
        ctx.ui.setStatus?.("model-refresh", summary);
        ctx.ui.setWidget?.("model-refresh", [summary, detail]);
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (result.results.length === 0) {
      throw new Error(result.failures.map(({ providerId, error }) => `${providerId}: ${error.message}`).join("; "));
    }
    return { written: result.written, lines: result.lines, failed: result.failures.length > 0 };
  }

  /** Pi caches models.json; without a reload a successful write changes nothing in the open session. */
  async function reloadAfterWrite(ctx: ExtensionCommandContext): Promise<string> {
    try {
      await ctx.reload();
      return "Reloaded.";
    } catch (err) {
      return `Reload failed (${err instanceof Error ? err.message : String(err)}); run /reload.`;
    }
  }

  // ─── /model-refresh: make the configured catalogue match the gateway ─────
  // Model configuration drifts silently and expensively. Measured against a
  // live gateway, a working models.json had one model configured at 1,048,576
  // tokens that the gateway caps at 262,144, another at 131,072 that actually
  // accepts 250,112, and a model missing entirely. The over-statement is the
  // damaging direction: Pi fills the context believing it fits, the request
  // fails, and because Pi computes usage from the configured window, compaction
  // fires far too late to save the turn.
  const modelRefreshHandler = (name: string) => async (args: string, ctx: ExtensionCommandContext) => {
    const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
    const dryRun = argv.includes("--dry-run");
    let explicitProvider: string | undefined;
    let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
    try {
      for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]!;
        if (arg === "--dry-run" || arg === "--prune") continue;
        if (arg === "--timeout") {
          const seconds = Number(argv[++i]);
          if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) {
            throw new Error("--timeout must be a number between 1 and 3600 seconds");
          }
          probeTimeoutMs = seconds * 1000;
        } else if (arg.startsWith("--") || explicitProvider) {
          throw new Error(`usage: /${name} [provider] [--timeout seconds] [--dry-run] [--prune]`);
        } else {
          explicitProvider = arg;
        }
      }
      const out = await refreshModels(ctx, {
        ...(explicitProvider ? { providerIds: [explicitProvider] } : {}),
        dryRun,
        pruneMissing: argv.includes("--prune"),
        probeTimeoutMs,
      });
      const lines = [...out.lines];
      if (name === "refresh-models") lines.push("(/refresh-models is now /model-refresh; the old name still works.)");
      if (out.written && !dryRun) lines.push(await reloadAfterWrite(ctx));
      ctx.ui.notify(lines.join("\n"), out.failed ? "warning" : "info");
    } catch (err) {
      ctx.ui.notify(
        `${name} failed: ${err instanceof Error ? err.message : String(err)}. Your configuration was not changed.`,
        "error",
      );
    } finally {
      ctx.ui.setStatus?.("model-refresh", undefined);
      ctx.ui.setWidget?.("model-refresh", undefined);
    }
  };
  pi.registerCommand("model-refresh", {
    description:
      "Refresh models with visible progress, then reload. [provider] [--timeout seconds] [--dry-run] [--prune].",
    handler: modelRefreshHandler("model-refresh"),
  });
  pi.registerCommand("refresh-models", {
    description: "Deprecated alias of /model-refresh.",
    handler: modelRefreshHandler("refresh-models"),
  });

  // ─── /model-sync: same providers on every machine ───────────────────────
  // Pulls one canonical, key-free definition, aligns provider settings (never
  // the host's own key), then hands the model lists to /model-refresh.
  pi.registerCommand("model-sync", {
    description:
      "Align providers with the canonical definition in model-sync.json, refresh models, reload. --check, --dry-run, --no-refresh.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const check = argv.includes("--check");
      const dryRun = check || argv.includes("--dry-run");
      const skipRefresh = argv.includes("--no-refresh");
      try {
        const source = parseSyncSource(readSyncSourceSetting());
        const canonical = parseCanonicalProviders(await fetchCanonicalText(source, ctx.signal));
        const current = readModelsConfig(defaultModelsPath());
        const plan = planProviderSync(
          current,
          canonical,
          (id) => ctx.modelRegistry?.getProviderAuthStatus(id).configured === true,
        );
        const lines = describeProviderSync(plan, dryRun);
        let written = false;
        if (plan.dirty && !dryRun) {
          const w = writeModelsConfig(defaultModelsPath(), plan.config, new Date(), "model-sync");
          written = true;
          if (w.backupPath) lines.push(`Backup: ${w.backupPath}`);
        }

        const ready = plan.entries.filter((e) => e.state !== "needs-key").map((e) => e.providerId);
        let failed = plan.entries.some((e) => e.state === "needs-key");
        if (check) {
          failed = plan.dirty || failed;
          lines.push(failed ? "Out of sync: run /model-sync." : "In sync.");
        } else if (dryRun) {
          lines.push("Dry run: nothing written, models not refreshed.");
        } else if (skipRefresh || ready.length === 0) {
          if (skipRefresh) lines.push("Models not refreshed (--no-refresh).");
        } else {
          try {
            const out = await refreshModels(ctx, {
              providerIds: ready,
              dryRun: false,
              pruneMissing: false,
              // The registry still holds pre-sync URLs until the final reload.
              useConfiguredBaseUrl: true,
            });
            lines.push(...out.lines);
            written ||= out.written;
            failed ||= out.failed;
          } catch (err) {
            failed = true;
            lines.push(`Model refresh failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (written) lines.push(await reloadAfterWrite(ctx));
        ctx.ui.notify(lines.join("\n"), failed ? "warning" : "info");
      } catch (err) {
        ctx.ui.notify(
          `model-sync failed: ${err instanceof Error ? err.message : String(err)}. Your configuration was not changed.`,
          "error",
        );
      } finally {
        ctx.ui.setStatus?.("model-refresh", undefined);
        ctx.ui.setWidget?.("model-refresh", undefined);
      }
    },
  });

  // Opt-in (`"checkOnStart": true` in model-sync.json): tell the operator when this
  // machine has drifted from the canonical providers. Read-only and silent when
  // in sync or when the source is unreachable, so an offline laptop starts quietly.
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.hasUI || !readCheckOnStart()) return;
      void (async () => {
        try {
          const source = parseSyncSource(readSyncSourceSetting());
          const canonical = parseCanonicalProviders(await fetchCanonicalText(source));
          const plan = planProviderSync(
            readModelsConfig(defaultModelsPath()),
            canonical,
            (id) => ctx.modelRegistry?.getProviderAuthStatus(id).configured === true,
          );
          if (!plan.dirty && plan.entries.every((e) => e.state !== "needs-key")) return;
          ctx.ui.notify(
            `Providers differ from the canonical set:\n${describeProviderSync(plan, true).join("\n")}\nRun /model-sync.`,
            "warning",
          );
        } catch {
          // unreachable source or unreadable config: stay quiet at startup
        }
      })();
    });
  }

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
      const msg = event.message as
        | { role?: string; stopReason?: string; errorMessage?: string; provider?: string; model?: string }
        | undefined;
      if (msg?.role !== "assistant" || msg.stopReason !== "error" || !msg.errorMessage) return;
      const signal = parseGatewayWait({ text: msg.errorMessage });
      if (!signal?.retryable) return;
      const waitMs = isAccountWideRefusal(signal) ? admission.noteWait(signal) : admission.noteObservedWait(signal);
      // The status bar owns this now: a spinner, the countdown and the queue
      // position say everything the 429 body did, without a wall of warnings
      // every 30 seconds. Notify only when there is no status bar to read.
      working?.onGatewayEvent({
        type: "wait",
        waitMs,
        concurrency: admission.status().concurrency,
        signal: { ...signal, provider: msg.provider, model: msg.model },
      });
      if (!working && !statusBarConfig.enabled) {
        ctx.ui.notify(
          `${gatewayWaitLabel(signal)} — holding ${Math.round(waitMs / 1000)}s. ${describeGatewayWait(signal)}`,
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
      if (!working && !statusBarConfig.enabled) {
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
    // The gateway's explicit IW-ACT-RETRY-ALTERNATE advice is a separate,
    // default-on trigger (src/gateway/advisedSwitch.ts): an instruction from
    // the gateway, not an inference of ours.
    const fallbackCoordinator = new FallbackCoordinator({
      enabled: gatewayConfig.modelFallbackEnabled,
      advisedSwitch: gatewayConfig.advisedModelSwitch,
    });
    // Which tool calls have no recorded outcome yet: a switch must not hand one
    // to a stand-in that could issue it a second time (autospec #158).
    pi.on("tool_execution_start", (event) => fallbackCoordinator.noteToolStarted(event.toolName, event.toolCallId));
    pi.on("tool_execution_end", (event) => fallbackCoordinator.noteToolEnded(event.toolCallId));

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
          // Tell the gateway who is asking (client, and this Pi session), so its
          // per-session admission buckets are not one shared "default" bucket.
          requestHeaders: (_model, options) =>
            admissionIdentityHeaders(undefined, (options as { sessionId?: string } | undefined)?.sessionId),
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
            // Only this interactive provider call owns the native working row.
            // Shared admission events also describe background requests on the
            // same route, so observing that bus would misattribute their waits.
            if (abort && abort === workingSignal)
              working?.onGatewayEvent({
                type: "wait",
                waitMs: scopedSignal.retryAfterMs,
                concurrency: admission.status().concurrency,
                signal: scopedSignal,
              });
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
          onProgress: (_model, signal) => {
            fallbackCoordinator.onProgress();
            if (signal && signal === workingSignal) working?.onModelProgress();
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
              advisesAlternate: advisesAlternateModel(info.signal),
              retryAfterMs: info.signal.retryAfterMs,
            });
          },
          // An advised hold with a switch armed is not waited out: the pump
          // settles with the advice and the settle boundary switches models and
          // continues the turn on the stand-in (AdvisedModelSwitch below).
          // The cooldown is still recorded (without sleeping): the model being
          // left is out of capacity, and workers or parallel sessions on it
          // must not walk straight back into the refusal this turn is leaving.
          // Plain data only, for the same lifecycle reason as `onHold`.
          // Only the agent turn: a summary or compaction call never reaches
          // the settle boundary, so abandoning it would fail the compaction
          // with nobody to continue it. Those wait the hold out as before.
          abandonForAlternate: (info, actualModel, context) => {
            if (!(fallbackCoordinator.willSwitchOnAdvice && fallbackCoordinator.hasPending)) return false;
            if (isSummarizationRequest(context as ThinkingContext)) return false;
            const callModel = actualModel as Model<any>;
            admission.noteWait({ ...info.signal, provider: callModel.provider, model: callModel.id });
            return true;
          },
          maxElapsedMs: gatewayConfig.maxElapsedMs,
          // Fit every request body to the gateway's cap (advertised, else
          // 10 MiB) before it is sent; a 413 is permanent and ends the turn.
          requestBodyBudget: resolveRequestBodyBudgetConfig(),
          // A stream cut after partial output is replayed by afterOutputRetry
          // (agent_before_settle); the wait it owes is taken here, against the
          // request's own abort signal, so Esc ends it at once.
          beforeSend: (model, signal, context) => {
            // before_provider_request may also be emitted by cache warming,
            // which exposes the foreground ctx.signal rather than its own.
            // This request callback retains the actual abort-signal identity.
            if (signal && signal === workingSignal) {
              const actual = model as Model<any>;
              const identity = { provider: actual.provider, model: actual.id };
              const remaining = admission.cooldownRemainingMs(identity);
              if (remaining > 0) {
                const observed = admission.status().lastSignal;
                const matching = observed?.provider === actual.provider && observed?.model === actual.id;
                working?.onGatewayEvent({
                  type: "wait",
                  waitMs: remaining,
                  concurrency: admission.status().concurrency,
                  signal: {
                    ...(matching
                      ? observed
                      : { source: "default", retryable: true, reason: "shared_gateway_cooldown" }),
                    retryAfterMs: remaining,
                    ...identity,
                  },
                });
              }
            }
            return afterOutputRetry.beforeSend(model as never, signal, context as never);
          },
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
    // Preview, against a FRESH ctx, whether a stand-in exists for the current
    // model, and record the answer as a plain boolean the hold path may read.
    // Without a stand-in on record an advised hold is waited out as before —
    // abandoning it would turn a slow turn into a failed one.
    const refreshStandIn = async (ctx: FallbackContext): Promise<void> => {
      let available = false;
      try {
        available = await previewFallback(ctx, { excludeIds: fallbackCoordinator.excludedModelIds });
      } catch {
        // Treated as "no stand-in": the hold is then waited out, never abandoned.
      }
      fallbackCoordinator.noteStandIn(available);
    };

    const applyClaimedFallback = async (ctx: FallbackContext, pending: PendingFallback) => {
      const result = await applyPendingFallback(
        {
          // Our own fallback switch is not an operator choice: missions must
          // not adopt it as an operator pin (see the model_select handler).
          setModel: async (m) => {
            automaticModelSwitch = true;
            try {
              return await pi.setModel(m);
            } finally {
              automaticModelSwitch = false;
            }
          },
          healthFor: (c) => healthFor(c as { model?: Model<any>; modelRegistry?: unknown }),
          log: (message) => console.error(message),
        } satisfies FallbackApplyDeps,
        ctx,
        pending,
      );
      // A successful switch means the new model gets a clean ledger; the
      // stand-in's own outage must start its own count, not inherit the one
      // that triggered this switch — while the model just left stays excluded
      // for SWITCHED_FROM_TTL_MS. A "stay" keeps the count so the next hold re-arms
      // the pending flag and the choice is reconsidered. The preview is redone
      // for the new model so a second advised hold knows where it could go.
      // A stay re-previews too: the record that armed this switch was wrong,
      // and the next advised hold must be waited out rather than abandoned on
      // the same stale answer.
      if (result.switched) fallbackCoordinator.onSwitched(result.currentId);
      await refreshStandIn(ctx);
      return result;
    };

    const applyPendingFallbackWithFreshCtx = async (ctx: FallbackContext): Promise<void> => {
      const pending = fallbackCoordinator.claimPending();
      if (!pending) return;
      await applyClaimedFallback(ctx, pending);
    };

    // The mid-turn half of the advised switch: at the settle boundary of a
    // turn the pump abandoned on IW-ACT-RETRY-ALTERNATE, switch models against
    // that callback's fresh ctx and continue the turn on the stand-in. Only
    // registered when the feature is on: with it off, a pending fallback from
    // the opt-in hold-count path must wait for before_agent_start as before,
    // not switch mid-turn through this door.
    if (gatewayConfig.advisedModelSwitch) {
      new AdvisedModelSwitch({
        claimPending: () => fallbackCoordinator.claimPending(),
        apply: applyClaimedFallback,
        // The wait the pump skipped, taken by the gateway wrapper before the
        // continued request (the same seam AfterOutputRetry uses).
        oweWait: (ctx, delayMs, attempt) => {
          const m = ctx.model;
          if (!m) return;
          afterOutputRetry.owe(
            { provider: m.provider, id: m.id },
            delayMs,
            attempt,
            "gateway capacity",
            `${m.id} is out of capacity and no other model fits this session`,
          );
        },
      }).register(pi as never);
    }

    // Last resort for a turn that failed before any output once the pump's
    // bounded budget and the advised switch are spent: wait on an escalating
    // schedule and continue, instead of leaving the session for the operator to
    // type "retry". Registered AFTER the other settle handlers on purpose.
    if (settleRecoveryEnabled()) {
      new SettleRecovery({
        onDecision: (decision) => inspector.note(describeDecision(decision)),
        owe: (ctx, delayMs, attempt, label) => {
          const m = ctx.model;
          if (!m) return;
          afterOutputRetry.owe({ provider: m.provider, id: m.id }, delayMs, attempt, "gateway failure", label);
        },
        isPaced: (ctx) => afterOutputRetry.isPaced({ provider: ctx.model?.provider, id: ctx.model?.id }),
        hasPendingWait: (ctx) => afterOutputRetry.hasPendingWait({ provider: ctx.model?.provider, id: ctx.model?.id }),
      }).register(pi as never);
    }

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
    pi.on("session_start", async (_event, ctx) => {
      installStreamRetry(ctx, ctx.model);
      await refreshStandIn(ctx as FallbackContext);
    });
    pi.on("before_agent_start", async (_event, ctx) => {
      fallbackCoordinator.onTurnStart();
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
      // Cheap and local (no readiness probe): the catalogue and the measured
      // context size, so the hold path knows whether an advised hold is worth
      // abandoning for a switch.
      await refreshStandIn(ctx as FallbackContext);
    });
    pi.on("model_select", async (event, ctx) => {
      // An operator's switch supersedes any stale fallback intent and the hold
      // ledger; otherwise one model's outage would switch away from the model
      // the operator just chose. Our own switch has already been accounted for
      // (`onSwitched`), and must keep the model it left excluded.
      installStreamRetry(ctx, event.model);
      // Our own switch previews again itself, after recording the model it
      // left; previewing here too would run without that exclusion.
      if (automaticModelSwitch) return;
      fallbackCoordinator.onModelSelect();
      await refreshStandIn(ctx as FallbackContext);
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

  // The native working indicator remains informative even with the custom
  // footer disabled. Split view retains Pi's native dock, so both layouts use
  // this same local-only activity surface.
  if (typeof pi.on === "function") {
    pi.on("session_start", (_event, ctx) => {
      workingSignal = undefined;
      working?.dispose();
      working = ctx.hasUI ? new WorkingStatusController(ctx.ui) : undefined;
      working?.onModelSelect(ctx.model);
    });
    pi.on("agent_start", (_event, ctx) => {
      workingSignal = ctx.signal;
      working?.onAgentStart();
    });
    pi.on("message_update", (event) => working?.onMessageUpdate(event));
    pi.on("tool_execution_start", (event) => working?.onToolEvent(event));
    pi.on("tool_execution_update", (event) => working?.onToolEvent(event));
    pi.on("tool_execution_end", (event) => working?.onToolEvent(event));
    pi.on("model_select", (event) => working?.onModelSelect(event.model));
    pi.on("agent_settled", () => {
      workingSignal = undefined;
      working?.onAgentEnd();
    });
    pi.on("session_shutdown", () => {
      workingSignal = undefined;
      working?.dispose();
      working = undefined;
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

  // Session lifecycle: diagnostics sink, and the data behind the footer's
  // ambient row (files, findings, tokens). Needs a live Pi run (the smoke-test
  // stub has no pi.on).
  if (typeof pi.on === "function") {
    pi.on("session_start", async (_event, ctx) => {
      // First, before anything can report: until a sink is installed every
      // diagnostic goes to raw stderr, which is what tears the frame.
      //
      // The previous session's sink is removed rather than left stacked
      // beneath this one: this extension treats sessions as serial.
      telemetryUninstall?.();
      telemetryUninstall = installTelemetrySink(ctx.ui as { notify(text: string, level: string): void });
      // A new session inherits no timer from the last one.
      stopPanelRefresh();
      const key = await repoCacheKey(ctx.cwd);
      const rt = await getRuntimeByCwd(ctx.cwd).catch(() => null);
      if (!rt) return;
      const plumbing = panelFor(key, rt);
      plumbing.workspace.invalidate();
      void plumbing.workspace.refresh();
      plumbing.ledger.refresh();
      startPanelRefresh(plumbing);
    });

    pi.on("session_shutdown", async () => {
      // A sink pointing at a torn-down session's UI is worse than none.
      telemetryUninstall?.();
      telemetryUninstall = undefined;
      // A timer that survives a session runs git against a repository nobody
      // is looking at and blocks the next session's refresh.
      stopPanelRefresh();
      await shutdownCachedRuntimes();
    });
  }

  // ─── Mission orchestration (spec pi-engineering-orchestration) ─────────
  // Normal-language intent auto-invokes the engineering workflow through the
  // Orchestrator. `/mission` is an optional power-user control; correctness
  // never depends on it (the semantic tool + runtime gate enforce policy).
  // Planner/worker execution mode (docs/specs/planner-worker-hot-model-routing.md):
  // /engineering-* commands, and the mode `/mission` consults before orchestrating.
  const plannerAttentionIngest = createIngestFromEnv(process.env);
  const plannerAttention = plannerAttentionIngest ? new MissionAttentionReporter(plannerAttentionIngest) : null;
  const plannerWorker = registerPlannerWorker(pi, {
    host: async (ctx) => {
      const rt = await getRuntime(ctx);
      return {
        repoRoot: rt.git?.root ?? rt.cwd,
        worker: rt.worker,
        reportAttention: (snapshot: Parameters<MissionAttentionReporter["update"]>[0]) => {
          void plannerAttention?.update(snapshot).catch(() => {});
        },
        // Live missions an operator paused or pinned, for /engineering-status.
        missionControlLines: () =>
          (rt.missionStore?.listMissions() ?? [])
            .filter((m) => !["COMPLETE", "FAILED", "CANCELED"].includes(m.status))
            .flatMap((m) => [
              ...describeMissionControl(m).map((line) => `${m.mission_id} [${m.status}] ${line}`),
              ...formatModelErrors(
                buildModelErrorRollups(
                  rt.missionStore?.listExecutions(m.mission_id) ?? [],
                  rt.missionStore?.listFailureClassifications(m.mission_id) ?? [],
                ),
              ).map((line) => `${m.mission_id} model errors:${line}`),
            ]),
      };
    },
    sessionGuardActive: inferweave !== null,
  });

  pi.registerCommand("mission", {
    description:
      "Run an orchestration mission (optional leading --mode/--backend/--budget/--max-workers); /mission inspect <missionId> [workerId] shows recent activity; /mission why <missionId> explains what blocks one; /mission resume <missionId> [--model auto] continues a stopped or paused one (optionally releasing its operator model pin), /mission cancel <missionId> ends one.",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("/mission <normal-language request> | /mission resume <missionId>", "error");
        return;
      }
      // A runtime that did not open (e.g. an ArtifactStore integrity refusal)
      // is reported with its reason instead of escaping the handler.
      const openRuntime = async (): Promise<EngineeringRuntime | null> => {
        try {
          return await getRuntime(ctx);
        } catch (error) {
          ctx.ui.notify(
            notInitializedText("Orchestrator", error instanceof Error ? error.message : String(error)),
            "error",
          );
          return null;
        }
      };
      const cancel = /^cancel\s+(MSN-\S+)\s*$/i.exec(request);
      if (cancel?.[1]) {
        const rt = await openRuntime();
        if (!rt) return;
        try {
          const canceled = await rt.cancelMission(cancel[1]);
          ctx.ui.notify(`Mission ${canceled.mission_id} — ${canceled.title} [${canceled.status}]`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const inspect = /^inspect\s+(\S+)(?:\s+(\S+))?\s*$/i.exec(request);
      if (/^inspect(?:\b|[:=])/i.test(request) && !inspect) {
        ctx.ui.notify("/mission inspect <missionId> [workerId]", "error");
        return;
      }
      if (inspect?.[1]) {
        const rt = await openRuntime();
        if (!rt) return;
        const projection = rt.missionObservability?.projection(inspect[1]);
        ctx.ui.notify(
          projection
            ? formatMissionInspection(projection, inspect[2])
            : `No recorded telemetry for mission ${inspect[1]}.`,
          projection ? "info" : "warning",
        );
        return;
      }
      const why = /^why\s+(\S+)\s*$/i.exec(request);
      if (why?.[1]) {
        const rt = await openRuntime();
        if (!rt?.missionStore) return;
        try {
          ctx.ui.notify(formatMissionWhy(explainMission(rt.missionStore, why[1])), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      const resumePrefix = /^resume(?:\b|[:=])/i.test(request);
      // `--model auto` releases the mission from a persisted operator pin first.
      const resume = /^resume\s+(\S+)(\s+--model\s+auto)?\s*$/i.exec(request);
      if (resumePrefix && !resume) {
        ctx.ui.notify("/mission resume <missionId>", "error");
        return;
      }
      // A new mission (not a resume) must be a root mission, and may carry
      // leading flags. Both are settled before the runtime opens, so a refusal
      // or a usage error creates nothing.
      let newRequest = request;
      if (!resume) {
        try {
          assertRootMissionAllowed(process.env);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }
        const autospecFlags = readAutospecFlags(process.env);
        const parsed = parseMissionFlags(request, autospecFlags, {
          maxWorkersCap: gatewayConfig.maxConcurrency,
        });
        if (parsed.error) {
          ctx.ui.notify(`${parsed.error}\n${MISSION_FLAGS_USAGE}`, "error");
          return;
        }
        newRequest = parsed.rest;
        for (const warning of parsed.warnings) ctx.ui.notify(warning, "warning");
        const mode = chooseMode(newRequest, autospecFlags, parsed.mode);
        const options = [
          parsed.mode ? `mode=${parsed.mode}` : "",
          parsed.backend ? `backend=${parsed.backend}` : "",
          parsed.budgetBytes !== undefined ? `budget=${parsed.budgetBytes}B` : "",
          parsed.maxWorkers !== undefined ? `max-workers=${parsed.maxWorkers}` : "",
        ].filter(Boolean);
        // No autospec adapter executes a mission yet: say so rather than imply it did.
        if (options.length > 0 || mode !== "local") {
          ctx.ui.notify(
            `[mission] options ${options.join(" ") || "(none)"} accepted; execution mode ${mode} runs as the local orchestrator (no autospec backend is wired yet)`,
            "info",
          );
        }
      }
      const rt = await openRuntime();
      if (!rt) return;
      if (!rt.orchestrator) {
        ctx.ui.notify(notInitializedText("Orchestrator", undefined), "error");
        return;
      }
      // The user reached an initialized orchestrator: the mission tool can
      // serve this session again, so auto-invoke may use it.
      missionToolUnavailable = false;
      if (resume) {
        const missionId = resume[1];
        if (!missionId) {
          ctx.ui.notify("/mission resume <missionId>", "error");
          return;
        }
        if (await plannerWorker.resumeIfOwned(missionId, ctx)) return;
        try {
          if (resume[2]) {
            await rt.clearMissionModelPin(missionId);
            ctx.ui.notify(
              `[mission ${missionId}] operator pin released; automatic routing from its next dispatch`,
              "info",
            );
          }
          activeControl?.missionProgress(`[mission ${missionId}] resuming`);
          await rt.resumeBlockedMission(missionId, ctx.signal);
          const mission = rt.missionStore?.getMission(missionId);
          if (!mission) throw new Error(`unknown mission ${missionId}`);
          inspector.associate({ mission_id: mission.mission_id });
          ctx.ui.notify(`Recovery ${mission.mission_id} — ${mission.title} [${mission.status}]`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (await plannerWorker.runIfSelected(newRequest, ctx)) return;
      const baseRef = (await rt.git?.headCommit().catch(() => "")) ?? "";
      ctx.ui.notify("Routing intent and running orchestration mission...", "info");
      // Persistent mission surfaces receive live activity separately. Keep the
      // session guard informed without creating a notice for each timer tick.
      let lastLine = "";
      const result = await rt.orchestrator.orchestrate(newRequest, {
        repository: rt.cwd,
        baseRef,
        mutationRequested: true,
        signal: ctx.signal,
        // Esc pauses the mission (resumable); only /mission cancel ends it.
        interrupt: "pause",
        ...(plannerWorker.lastDecision() ? { executionMode: plannerWorker.lastDecision()! } : {}),
        onProgress: (line) => {
          // De-duplicate the trailing completion lines (phase transitions and
          // task settlements can fire within the same tick).
          if (line === lastLine) return;
          lastLine = line;
          activeControl?.missionProgress(line);
        },
      });
      const m = result.mission;
      inspector.associate({ mission_id: m.mission_id });
      const completion =
        result.pausedBy === "operator" && result.mission.status !== "PAUSED_INFRASTRUCTURE"
          ? `interrupt noted — mission left ${result.mission.status} (not canceled); /mission resume ${result.mission.mission_id} continues it`
          : result.pausedBy === "operator"
            ? `PAUSED by interrupt — progress preserved; /mission resume ${result.mission.mission_id} continues it, /mission cancel ${result.mission.mission_id} ends it`
            : result.paused
              ? "PAUSED — infrastructure retry window exhausted (auto-resumes on recovery; not a failure)"
              : result.completed
                ? "PASSED"
                : `BLOCKED — ${result.failureReason ?? ""}`;
      const lines = [
        `Mission ${m.mission_id} [${m.status}] workflow=${m.workflow_class} risk=${m.risk_profile}`,
        `Intent: ${result.intent.intent.join(", ")} (confidence ${result.intent.confidence.toFixed(2)})`,
        ...(m.execution_mode ? [`Execution mode: ${m.execution_mode.mode} — ${m.execution_mode.reason}`] : []),
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
          ...(m.execution_mode ? [`  execution mode: ${m.execution_mode.mode} — ${m.execution_mode.reason}`] : []),
          `  now: ${summary?.currentActivity?.summary ?? summary?.reason ?? "no activity recorded"} · heartbeat ${missionActivityAge(summary?.lastHeartbeatAt)} · progress ${missionActivityAge(summary?.lastMeaningfulProgressAt)}`,
          `  inspect: /mission inspect ${m.mission_id} [workerId]`,
          `  ${acceptanceText} · workflow ${workflow.completed}/${workflow.total} (${workflow.approximatePercent}%) · health ${summary?.health ?? "unknown"}`,
          `  repo ${summary?.repository ?? m.repository} · task ${summary?.task ?? "none"} · owner ${summary?.owner ?? "unowned"} · last progress ${summary?.lastMeaningfulProgressAt ?? "none"}`,
          // P4: routing provenance — which model serves which task.
          ...(summary?.workersDetail?.some((w) => w.model)
            ? [
                `  models: ${summary.workersDetail
                  .map((w) => `${(w.taskId ?? w.workerId).replace(/^TSK-/, "")} → ${w.model ?? "default"}`)
                  .join(" · ")}`,
              ]
            : []),
          `  recovery ${recovery.attempt}/${recovery.maxAttempts}; attempted ${stop?.attemptedRecoveries.length ?? 0} · next: ${stop?.resumeCondition ?? summary?.nextAction ?? "No further action is scheduled"}${summary?.nextActionAt ? ` at ${summary.nextActionAt}` : ""}`,
          `  ${stop ? `stop: ${stop.reason}` : `action: ${summary?.action ?? m.status} — ${summary?.reason ?? "No additional reason recorded"}`} · preserved: ${preserved.join(", ") || "none"}`,
          ...describeMissionControl(m).map((line) => `  ${line}`),
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
