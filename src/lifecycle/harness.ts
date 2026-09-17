/**
 * Pi harness integration (spec §5, §22, §26).
 *
 * This is the only place the lifecycle touches a live session. Pi events become
 * lifecycle observations; when the agent settles the harness runs the automatic
 * gate and, if it fails, injects a harness-authored remediation follow-up. The
 * parent model never invokes a review or verification command to satisfy the
 * gate, and never reports completion — the harness does.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import {
  AgentModelsFileSource,
  CapacityEndpointSource,
  PiModelRuntimeSource,
  StaticModelSource,
} from "../capability/discovery.ts";
import type { StaticModelDefinition } from "../capability/discovery.ts";
import { ModelCapabilityRegistry } from "../capability/registry.ts";
import { RoleRouter } from "../capability/router.ts";
import {
  type AdmissionRetryConfig,
  DEFAULT_ADMISSION_RETRY_CONFIG,
  admissionConfigFromEnv,
  normalizeAdmissionConfig,
} from "../inference/admissionConfig.ts";
import { AdmissionEventBus, AdmissionMetrics, summarizeAdmissionMetrics } from "../inference/admissionEvents.ts";
import type { AdmissionInstallReport } from "../inference/admissionInstall.ts";
import { AdmissionStatusController } from "../inference/admissionStatus.ts";
import type { AdmissionSaturation } from "../inference/admissionTransport.ts";
import type { AdmissionBudgetLedger } from "../inference/admissionTransport.ts";
import { PiWorkerExecutor } from "../workers/PiWorkerExecutor.ts";
import { LifecycleController } from "./controller.ts";
import type { ApprovalRequest } from "./controller.ts";
import { loadPolicy } from "./policy.ts";
import type { EngineeringPolicy, PolicyIssue } from "./policy.ts";
import { admissionConfigFromPolicy } from "./policy.ts";
import { PiRoleRunner } from "./roleRunner.ts";
import { STAGE_ORDER } from "./stateMachine.ts";
import { LifecycleStore } from "./store.ts";
import { LifecycleTelemetry, bridgeAdmissionToTelemetry, summarizeMetrics } from "./telemetry.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { modelKey } from "./types.ts";
import type { LifecycleRun, ModelRef, RoutingDecision } from "./types.ts";
import { VisionCache } from "./vision.ts";

/** Map admission saturation counters onto a 0..1 load factor for the router. */
function admissionLoad(sat: AdmissionSaturation): number {
  const active = sat.activeLimit && sat.activeLimit > 0 ? (sat.active ?? 0) / sat.activeLimit : 0;
  const queued = sat.queueLimit && sat.queueLimit > 0 ? (sat.queued ?? 0) / sat.queueLimit : 0;
  return Math.max(0, Math.min(1, Math.max(active, queued)));
}

export interface HarnessOptions {
  agentDir?: string;
  /** Extra static model declarations merged into discovery. */
  staticModels?: StaticModelDefinition[];
  /** Optional capacity endpoint (InferWeave-style). */
  capacityEndpoint?: string;
  /** Override the loaded policy (tests / session pinning). */
  policyOverride?: unknown;
  /** Session identity override (tests). */
  sessionKey?: string;
  /** Mirror findings and decisions into the Engineering Ledger. */
  record?: (
    cwd: string,
    entry: { kind: "finding" | "decision" | "requirement"; text: string; severity?: string },
  ) => Promise<void>;
  /** Skip model discovery entirely (offline tests). */
  offline?: boolean;
}

const HARNESS_DIRECTIVE =
  "[engineering harness] An automatic engineering gate is active. Do not declare the task complete: when your turn ends the harness verifies, routes independent reviewers, and decides completion. " +
  "If you cannot finish, state exactly what is missing instead of summarising success.";

export class LifecycleHarness {
  private policy: EngineeringPolicy | undefined;
  private policyIssues: PolicyIssue[] = [];
  private policySources: string[] = [];
  private registry: ModelCapabilityRegistry | undefined;
  private router: RoleRouter | undefined;
  private store: LifecycleStore | undefined;
  private telemetry: LifecycleTelemetry = LifecycleTelemetry.memory(false);
  private artifacts: ArtifactStore | undefined;
  private visionCache: VisionCache | undefined;
  private controller: LifecycleController | undefined;
  private executor: PiWorkerExecutor | undefined;
  private currentCwd = "";
  private currentSessionKey = "";
  private harnessInjected = false;
  private busy = false;
  private ctx: ExtensionContext | undefined;
  private admissionBus = new AdmissionEventBus();
  private admissionMetrics = new AdmissionMetrics();
  private admissionBudget: AdmissionBudgetLedger | null = null;
  private admissionUnsubs: Array<() => void> = [];
  private admissionConfig: AdmissionRetryConfig = DEFAULT_ADMISSION_RETRY_CONFIG;

  private readonly opts: HarnessOptions;

  private constructor(opts: HarnessOptions) {
    this.opts = opts;
  }

  static create(opts: HarnessOptions = {}): LifecycleHarness {
    return new LifecycleHarness(opts);
  }

  // ------------------------------------------------------------------ wiring

  register(pi: ExtensionAPI): void {
    // A host may only expose command/tool registration (e.g. the package-load
    // proof stub). Event wiring is optional: without it the lifecycle is simply
    // not attached to live sessions.
    if (typeof (pi as { on?: unknown }).on !== "function") return;
    pi.on("before_agent_start", async (event, ctx) => {
      this.ctx = ctx;
      if (event.prompt.trim().startsWith("/")) return undefined;
      if (this.harnessInjected) {
        // A harness-authored remediation turn: never open a new run for it.
        this.harnessInjected = false;
        return undefined;
      }
      const controller = await this.bind(ctx, pi);
      if (!controller) return undefined;
      const images = (event.images ?? []).map((img) => ({ data: img.data, mimeType: img.mimeType }));
      const { run, planRequired } = await controller.noteRequest(event.prompt, images);
      if (planRequired) {
        this.say(
          ctx,
          `Plan required (${run.classification?.planTriggers.join(", ") || "policy"}); risk ${run.classification?.risk}. The harness will require a recorded plan before completion.`,
          "info",
        );
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${HARNESS_DIRECTIVE}` };
    });

    pi.on("tool_call", async (event, ctx) => {
      this.ctx = ctx;
      if (!this.controller) return undefined;
      return this.controller.observeToolCall(String(event.toolName), event.input as Record<string, unknown>);
    });

    pi.on("tool_result", async (event, ctx) => {
      this.ctx = ctx;
      if (!this.controller) return undefined;
      const images = ((event.content ?? []) as { type?: string; data?: string; mimeType?: string }[])
        .filter((c) => c?.type === "image" && c.data)
        .map((c) => ({ data: String(c.data), mimeType: String(c.mimeType ?? "image/png") }));
      this.controller.observeToolResult(String(event.toolName), !!event.isError, images);
      return undefined;
    });

    pi.on("agent_settled", async (_event, ctx) => {
      this.ctx = ctx;
      const controller = this.controller;
      if (!controller || controller.policy.lifecycle.automatic === false) return;
      if (this.busy) return;
      this.busy = true;
      try {
        ctx.ui.setStatus?.("engineering", "gate: verify → review → gate");
        const result = await controller.settle("turn_settled");
        if (result.action === "remediate" && result.message) {
          this.harnessInjected = true;
          pi.sendUserMessage(result.message, { deliverAs: "followUp" });
        }
      } catch (err) {
        this.say(ctx, `Lifecycle pass failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        this.busy = false;
        ctx.ui.setWidget?.("engineering", undefined);
        ctx.ui.setStatus?.("engineering", undefined);
      }
    });

    pi.on("model_select", (event, ctx) => {
      this.ctx = ctx;
      this.telemetry.emit("routing.decision", {
        kind: "session_model_select",
        provider: String(event.model?.provider ?? ""),
        model: String(event.model?.id ?? ""),
        previous: event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : undefined,
        source: String(event.source),
      });
    });
  }

  /** Bind policy + subsystems to the current working directory and session. */
  private async bind(ctx: ExtensionContext, pi?: ExtensionAPI): Promise<LifecycleController | undefined> {
    const sessionKey = this.opts.sessionKey ?? ctx.sessionManager.getSessionId?.() ?? "session";
    if (this.controller && this.currentCwd === ctx.cwd && this.currentSessionKey === sessionKey) return this.controller;
    this.currentCwd = ctx.cwd;
    this.currentSessionKey = sessionKey;

    try {
      const loaded = await loadPolicy({
        cwd: ctx.cwd,
        agentDir: this.opts.agentDir,
        sessionOverride: this.opts.policyOverride,
      });
      this.policy = loaded.policy;
      this.policyIssues = loaded.issues;
      this.policySources = loaded.sources;
    } catch (err) {
      this.say(ctx, `Engineering policy failed to load: ${err instanceof Error ? err.message : String(err)}`, "error");
      return undefined;
    }
    const policy = this.policy;
    this.admissionConfig = admissionConfigFromEnv(normalizeAdmissionConfig(admissionConfigFromPolicy(policy)));
    // Admission-retry is an optional InferWeave adapter: load its runtime pieces
    // lazily so the extension loads even when the adapter is unavailable.
    if (this.admissionConfig.enabled) {
      try {
        const { AdmissionBudgetLedger } = await import("../inference/admissionTransport.ts");
        this.admissionBudget = new AdmissionBudgetLedger();
      } catch (err) {
        this.say(
          ctx,
          `Inference admission retry unavailable: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }
    const persistDir = policy.lifecycle.persist_dir.startsWith("/")
      ? policy.lifecycle.persist_dir
      : `${ctx.cwd}/${policy.lifecycle.persist_dir}`;

    this.artifacts = await ArtifactStore.create(`${persistDir}/artifacts`);
    this.store = await LifecycleStore.open(persistDir);
    this.telemetry = LifecycleTelemetry.file(`${persistDir}/telemetry.jsonl`, policy.lifecycle.telemetry);
    this.visionCache = await VisionCache.open(`${persistDir}/vision-cache.json`, policy.vision.cache);

    this.executor = new PiWorkerExecutor({
      agentDir: this.opts.agentDir,
      ...(policy.inference?.retry?.admission
        ? {
            admission: {
              config: this.admissionConfig,
              events: this.admissionBus,
              budget: this.admissionBudget ?? undefined,
              onSaturation: (ref, saturation) => this.registry?.recordSaturation(ref, admissionLoad(saturation)),
            },
            admissionEvents: this.admissionBus,
          }
        : {}),
    });
    const modelRuntime = await this.executor.runtime();

    // Wire admission-retry: event bus -> telemetry + metrics + status UI, and
    // wrap the session's own provider registry so interactive inference also
    // survives admission waits.
    for (const u of this.admissionUnsubs) u();
    this.admissionUnsubs = [];
    this.admissionUnsubs.push(
      this.admissionBus.subscribe((event) => this.admissionMetrics.record(event)),
      bridgeAdmissionToTelemetry(this.admissionBus, this.telemetry),
    );

    const sources = [];
    if (!this.opts.offline) {
      sources.push(new PiModelRuntimeSource(modelRuntime));
      sources.push(new AgentModelsFileSource());
      if (this.opts.capacityEndpoint)
        sources.push(new CapacityEndpointSource({ endpoint: this.opts.capacityEndpoint }));
    }
    if (this.opts.staticModels?.length) sources.push(new StaticModelSource(this.opts.staticModels));

    this.registry = await ModelCapabilityRegistry.open({
      sources,
      context: { cwd: ctx.cwd, agentDir: this.opts.agentDir ?? "" },
      file: `${persistDir}/models.json`,
      ttlMs: policy.routing.discovery_ttl_ms,
      penaltyDecayMs: policy.routing.penalty_decay_seconds * 1000,
    });
    const refresh = await this.registry
      .refresh()
      .catch((err: Error) => ({ errors: [err.message], models: 0, sources: [], changed: false, at: "" }));
    this.telemetry.refresh({
      models: refresh.models,
      sources: refresh.sources?.join(",") ?? "",
      changed: !!refresh.changed,
      reason: "session_start",
      errors: refresh.errors?.join("; "),
    });

    const sessionModelRef = (): ModelRef | undefined => {
      const model = this.ctx?.model ?? ctx.model;
      return model ? { provider: String(model.provider), id: String(model.id) } : undefined;
    };

    this.router = new RoleRouter({
      registry: this.registry,
      policy,
      sessionModel: sessionModelRef,
      overrides: [{ source: "policy.routing.roles", roles: mapRoleOverrides(policy) }],
    });

    const roles = new PiRoleRunner({
      registry: this.registry,
      router: this.router,
      executor: this.executor,
      artifacts: this.artifacts,
      cwd: ctx.cwd,
      onInvocation: (args) =>
        this.telemetry.invocation({
          runId: this.controller?.activeRun?.()?.runId,
          role: args.role,
          model: args.model,
          ok: args.ok,
          durationMs: args.durationMs,
          error: args.error,
          ...args.usage,
        }),
    });

    // Visible waiting state + interactive-session provider wrapping. The session
    // registry is the operator's own provider registry; wrapping it means an
    // interactive Pi turn against a busy InferWeave node shows a countdown and
    // retries instead of dying with `Error: 429`.
    if (this.admissionConfig.enabled) {
      const controller = new AdmissionStatusController(
        {
          setStatus: (key, text) => ctx.ui.setStatus(key, text),
          setWidget: (key, lines) => ctx.ui.setWidget(key, lines),
          notify: (message, level) => this.say(this.ctx ?? ctx, message, level),
        },
        this.admissionBus,
      );
      this.admissionUnsubs.push(() => controller.dispose());
      try {
        const { installAdmissionRetry } = await import("../inference/admissionInstall.ts");
        const report: AdmissionInstallReport = installAdmissionRetry(
          {
            registerProvider: (id, config) => ctx.modelRegistry?.registerProvider(id, config as never),
            getRegisteredProviderConfig: (id) => ctx.modelRegistry?.getRegisteredProviderConfig(id),
            getRegisteredProviders: () => ctx.modelRegistry?.getRegisteredProviderIds?.() ?? [],
          },
          {
            config: this.admissionConfig,
            events: this.admissionBus,
            budget: this.admissionBudget ?? undefined,
            scope: { sessionId: sessionKey, agentId: sessionKey, role: "session" },
            onState: (state) => controller.handleState(state),
            onSaturation: (ref, saturation) => this.registry?.recordSaturation(ref, admissionLoad(saturation)),
          },
        );
        if (report.wrapped.length) {
          this.say(ctx, `Inference admission retry armed for ${report.wrapped.join(", ")}.`, "info");
        }
      } catch (err) {
        this.say(
          ctx,
          `Inference admission retry install failed: ${err instanceof Error ? err.message : String(err)}`,
          "warning",
        );
      }
    }

    this.controller = new LifecycleController({
      cwd: ctx.cwd,
      sessionKey,
      policy,
      registry: this.registry,
      roles,
      store: this.store,
      telemetry: this.telemetry,
      artifacts: this.artifacts,
      visionCache: this.visionCache,
      sessionModel: sessionModelRef,
      record: this.opts.record ? (entry) => this.opts.record!(ctx.cwd, entry) : undefined,
      notify: (message, level) => this.say(this.ctx ?? ctx, message, level),
      requestApproval: (request) => this.askApproval(ctx, request),
    });

    void pi;
    const errors = this.policyIssues.filter((i) => i.severity === "error");
    if (errors.length)
      this.say(ctx, `Engineering policy errors: ${errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`, "error");
    return this.controller;
  }

  private async askApproval(ctx: ExtensionContext, request: ApprovalRequest): Promise<boolean> {
    if (!ctx.hasUI) return this.policy?.policies.risk.unattended === "allow_with_log";
    const label = request.capability ? ` (${request.capability} capability)` : "";
    try {
      return await ctx.ui.confirm(
        "Engineering gate — allow this operation?",
        `Risk ${request.risk}${label}: ${request.reason}\n\nCommand:\n${request.command.slice(0, 800)}`,
      );
    } catch {
      return false;
    }
  }

  private say(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info"): void {
    try {
      ctx?.ui.notify?.(`[engineering] ${message}`, level);
    } catch {
      // A UI-less host simply doesn't see the notification.
    }
  }

  /** Surface admission/retry events (saturation, exhaustion, fallback) to the user. */
  private onAdmissionEvent(
    ctx: ExtensionContext,
    event: { name: string; provider: string; model: string; attempt: number; reason?: string },
  ): void {
    if (event.name === "inference.retry.exhausted") {
      this.say(
        ctx,
        `Inference for ${event.provider}/${event.model} exhausted after ${event.attempt} attempt(s)${event.reason ? ` (${event.reason})` : ""}.`,
        "warning",
      );
    } else if (event.name === "inference.fallback.triggered") {
      this.say(ctx, `Falling back after admission on ${event.provider}/${event.model}.`, "info");
    }
  }

  // ------------------------------------------------------------- diagnostics

  async command(args: string, ctx: ExtensionContext): Promise<string> {
    const [sub = "status", ...rest] = args.trim().split(/\s+/);
    if (!this.policy) await this.bind(ctx);
    switch (sub) {
      case "status":
        return this.formatStatus();
      case "explain":
        return this.formatExplain(rest[0]);
      case "models": {
        if (rest.includes("--refresh") || (await this.registry?.isStale())) await this.registry?.refresh();
        return this.formatModels();
      }
      case "refresh-models": {
        const res = await this.registry?.refresh();
        if (!res) return "Model discovery is not bound yet.";
        this.telemetry.refresh({
          models: res.models,
          sources: res.sources.join(","),
          changed: res.changed,
          reason: "operator",
          errors: res.errors.join("; "),
        });
        return `Discovered ${res.models} model(s) from ${res.sources.join(", ") || "no source"}${res.errors.length ? `; errors: ${res.errors.join("; ")}` : ""}.`;
      }
      case "policy":
        return this.formatPolicy();
      case "ignore": {
        const fingerprint = rest.join(" ");
        if (!fingerprint) return "usage: /engineering ignore <fingerprint>";
        await this.controller?.ignoreFinding(fingerprint);
        return `Ignored finding ${fingerprint}.`;
      }
      case "reopen": {
        const run = await this.controller?.reopenRun(rest.join(" ") || "operator reopen");
        return run ? `Reopened ${run.runId} at round 0.` : "No active run to reopen.";
      }
      case "metrics": {
        const metrics = summarizeMetrics(this.telemetryEvents());
        return [
          `runs=${metrics.runs} complete=${metrics.passes} escalated=${metrics.escalations}`,
          `routing decisions with no selection=${metrics.routingFailures}`,
          `invocations=${metrics.modelInvocations} failed=${metrics.failedInvocations} cost=$${metrics.totalCostUsd.toFixed(4)}`,
          `reviews: ${
            Object.entries(metrics.reviewsByRole)
              .map(([role, c]) => `${role}(+${c.approve}/~${c.request_changes}/x${c.failed})`)
              .join(", ") || "none"
          }`,
        ].join("\n");
      }
      case "runs":
        return (this.store?.list().slice(0, 12) ?? [])
          .map((r) => `${r.runId} ${r.state} rounds=${r.rounds}/${r.maxRounds} ${truncate(r.request, 60)}`)
          .join("\n");
      case "admission": {
        const snapshot = this.admissionMetrics.snapshot();
        const summary = summarizeAdmissionMetrics(snapshot);
        return [
          `enabled=${this.admissionConfig.enabled} observe_only=${this.admissionConfig.observe_only}`,
          `max_attempts=${this.admissionConfig.max_attempts} max_elapsed_ms=${this.admissionConfig.max_elapsed_ms}`,
          ...summary,
          "",
          "recent events:",
          ...this.admissionBus
            .events(8)
            .map(
              (e) =>
                `${e.at.slice(11, 19)} ${e.name} ${e.provider}/${e.model} attempt=${e.attempt}${e.reason ? ` reason=${e.reason}` : ""}${e.delayUsedMs ? ` delay=${Math.round(e.delayUsedMs / 1000)}s` : ""}`,
            ),
        ].join("\n");
      }
      case "reset":
        this.controller = undefined;
        return "Lifecycle controller detached; the next turn rebinds with fresh state.";
      default:
        return [
          "usage: /engineering <status|explain [role]|models [--refresh]|refresh-models|policy|ignore <fingerprint>|reopen [reason]|metrics|admission|runs|reset>",
          `subcommand "${sub}" is not known.`,
        ].join("\n");
    }
  }

  telemetryEvents(): TelemetryEvent[] {
    for (const sink of this.telemetry?.sinks ?? []) {
      const maybe = sink as { recent?: (n: number) => TelemetryEvent[] };
      if (typeof maybe.recent === "function") return maybe.recent(2000);
    }
    return [];
  }

  private formatStatus(): string {
    const summary = this.controller?.statusSummary();
    if (!summary?.runId) return "No engineering run is active in this session.";
    const run = this.store?.get(summary.runId);
    const stage = STAGE_ORDER.find((s) => s.state === summary.state)?.label ?? summary.state;
    const lines = [
      `Run ${summary.runId} — ${summary.state} (${stage})`,
      `Categories: ${(summary.categories ?? []).join(", ") || "uncategorized"} | Risk: ${summary.risk ?? "?"} | Rounds: ${summary.rounds}`,
      `Gate: ${summary.gate ?? "not evaluated"}`,
    ];
    if (summary.blockers?.length) lines.push(`Blockers:\n${summary.blockers.map((b) => `  - ${b}`).join("\n")}`);
    if (summary.lastModels?.length) lines.push(`Reviewers: ${summary.lastModels.join(", ")}`);
    if (run?.gate) {
      lines.push("Gate items:");
      for (const item of run.gate.items) {
        const mark = item.status === "passed" || item.status === "not_applicable" ? "+" : "x";
        lines.push(`  ${mark} ${item.key}=${item.status}${item.required ? "" : " (optional)"} — ${item.reason}`);
      }
    }
    if (run?.openFingerprints.length) lines.push(`Open findings: ${run.openFingerprints.slice(0, 8).join(", ")}`);
    return lines.join("\n");
  }

  private formatExplain(role?: string): string {
    const decisions: RoutingDecision[] = this.controller?.activeRun()?.routing ?? [];
    const relevant = role ? decisions.filter((d) => d.role === role) : decisions;
    if (!relevant.length) return `No routing decisions recorded${role ? ` for role "${role}"` : ""} yet.`;
    return relevant
      .slice(-6)
      .map((d) => {
        const head = `${d.role}: ${d.selected ? modelKey(d.selected) : "NO ELIGIBLE MODEL"}`;
        const rationale = d.rationale.map((r) => `  · ${r}`).join("\n");
        const candidates = d.candidates
          .slice(0, 5)
          .map((c) => `  = ${modelKey(c.model)} score ${c.score.toFixed(3)}`)
          .join("\n");
        const rejected = d.rejected
          .slice(0, 6)
          .map((r) => `  - ${modelKey(r.model)} [${r.stage}] ${r.reason}`)
          .join("\n");
        return [head, rationale, candidates, rejected].filter(Boolean).join("\n");
      })
      .join("\n\n");
  }

  private formatModels(): string {
    const models = this.registry?.all() ?? [];
    if (!models.length) return "No models discovered. Configure a provider or add routing static models.";
    const lines = [`Discovered ${models.length} model(s):`];
    for (const rec of models.slice(0, 40)) {
      const caps = Object.entries(rec.capabilities.values)
        .filter(([, v]) => v)
        .map(([k]) => k);
      const flags = [
        rec.available ? "" : "unavailable",
        rec.healthy ? "" : "unhealthy",
        rec.local ? "local" : "",
        rec.penalty ? `penalty ${rec.penalty.toFixed(2)}` : "",
      ]
        .filter(Boolean)
        .join(",");
      const ctx = rec.contextWindow ? `${Math.round(rec.contextWindow / 1000)}k` : "?";
      lines.push(
        `  ${rec.provider}/${rec.id} [${rec.source}] ctx=${ctx} caps=${caps.join("/") || "-"}${flags ? ` ${flags}` : ""}`,
      );
    }
    return lines.join("\n");
  }

  private formatPolicy(): string {
    const p = this.policy;
    if (!p) return "Policy is not loaded yet.";
    const lines = [
      `Policy sources: ${this.policySources.join(" < ") || "built-in defaults"}`,
      `lifecycle: automatic=${p.lifecycle.automatic} max_rounds=${p.lifecycle.max_remediation_rounds} remediation=${p.lifecycle.remediation} budget_ms=${p.lifecycle.budget_ms} plan_threshold=${p.lifecycle.plan_threshold_risk}`,
      `routing: mode=${p.routing.mode} adopt_session_model=${p.routing.adopt_orchestrator_model} priority=${p.routing.provider_priority.join(",") || "-"} deny=${p.routing.provider_deny.join(",") || "-"}`,
      `review: independent=${p.policies.review.require_independent_review} differs_from_session=${p.policies.review.reviewer_differs_from_session} specialists=${p.policies.review.specialists_enabled} max_blocking=${p.policies.review.max_blocking_findings_to_pass}`,
      `verification: required=${p.policies.verification.require_before_complete} sources=${p.policies.verification.command_sources.join(",")} missing_blocks=${p.policies.verification.missing_required_blocks}`,
      `risk: approval_at=${p.policies.risk.pre_execution_approval_at} unattended=${p.policies.risk.unattended} preserved=${p.policies.risk.preserve_capabilities.join(",")}`,
      `vision: enabled=${p.vision.enabled} force_handoff=${p.vision.force_handoff} prefer_local=${p.vision.prefer_local} capture=${p.vision.capture_command ?? "<not configured>"}`,
      `gate: ${Object.entries(p.policies.completion_gate.require)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}`,
    ];
    if (this.policyIssues.length) {
      lines.push("Policy issues:");
      for (const issue of this.policyIssues) lines.push(`  ${issue.severity}: ${issue.path} — ${issue.message}`);
    }
    return lines.join("\n");
  }

  // --------------------------------------------------------------- accessors

  get controllerRef(): LifecycleController | undefined {
    return this.controller;
  }

  get registryRef(): ModelCapabilityRegistry | undefined {
    return this.registry;
  }

  get routerRef(): RoleRouter | undefined {
    return this.router;
  }

  get storeRef(): LifecycleStore | undefined {
    return this.store;
  }

  get currentPolicy(): EngineeringPolicy | undefined {
    return this.policy;
  }

  runFor(id: string): LifecycleRun | undefined {
    return this.store?.get(id);
  }

  /** Test/seam hook: install a pre-built controller. */
  setController(controller: LifecycleController): void {
    this.controller = controller;
  }

  markHarnessInjected(): void {
    this.harnessInjected = true;
  }
}

function mapRoleOverrides(policy: EngineeringPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, cfg] of Object.entries(policy.routing.roles)) {
    if (cfg?.model) out[role] = cfg.model;
  }
  return out;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
