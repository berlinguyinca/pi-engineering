/**
 * Lifecycle controller (spec §6, §19, §21).
 *
 * This is the harness-owned orchestrator. It opens a run from observed intent or
 * observed edits, drives classification → verification → independent review →
 * concurrent specialists → spec verification → final verification → completion
 * gate, and decides whether to remediate or escalate. The parent model is never
 * consulted for a state or verdict.
 */

import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { hasCapability } from "../capability/modelRecord.ts";
import type { ModelCapabilityRegistry } from "../capability/registry.ts";
import type { RoleName } from "../capability/roles.ts";
import { ROLE_REQUIREMENTS } from "../capability/roles.ts";
import { newArtifactId, newRunId } from "../core/ids.ts";
import { captureChangeSnapshot, hasMeaningfulChange } from "./changeObserver.ts";
import { classifyWork, maxRisk, riskRank } from "./classification.ts";
import { commandFromToolInput, gateOperation, isMutatingTool } from "./destructive.ts";
import { evaluateGate } from "./gate.ts";
import type { EngineeringPolicy } from "./policy.ts";
import { buildCompletionReport, buildRemediationBrief } from "./rolePrompts.ts";
import type { RoleRunner, RoleSpec } from "./roleRunner.ts";
import { canTransition } from "./stateMachine.ts";
import type { LifecycleStore } from "./store.ts";
import type { LifecycleTelemetry } from "./telemetry.ts";
import { modelKey } from "./types.ts";
import type { RoutingDecision } from "./types.ts";
import type {
  ChangeSnapshot,
  CheckSpec,
  Classification,
  LifecycleRisk,
  LifecycleRun,
  LifecycleState,
  LifecycleTrigger,
  ModelRef,
  ReviewReport,
  VerificationReport,
  WorkCategory,
} from "./types.ts";
import { planChecks, runChecks } from "./verification.ts";
import { VisionCache, captureScreenshots, imageFilesIn, loadImageFiles, shouldHandOffVision } from "./vision.ts";

export interface ApprovalRequest {
  command: string;
  risk: LifecycleRisk;
  reason: string;
  capability?: string;
}

export interface ControllerOptions {
  cwd: string;
  sessionKey: string;
  policy: EngineeringPolicy;
  registry: ModelCapabilityRegistry;
  roles: RoleRunner;
  store: LifecycleStore;
  telemetry: LifecycleTelemetry;
  artifacts: ArtifactStore;
  visionCache?: VisionCache;
  sessionModel?: () => ModelRef | undefined;
  /** Ask the operator; resolves true to allow the operation to proceed. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
  /** Surface a message to the user (Pi UI notification). */
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  /** Mirror findings/decisions into the Engineering Ledger. */
  record?: (entry: { kind: "finding" | "decision" | "requirement"; text: string; severity?: string }) => Promise<void>;
}

export type SettleAction = "none" | "complete" | "remediate" | "escalate" | "blocked";

export interface SettleResult {
  action: SettleAction;
  message?: string;
  run?: LifecycleRun;
  detail?: string;
}

export interface SessionObservation {
  mutations: number;
  failedMutations: number;
  commands: string[];
  riskFloor: LifecycleRisk;
  images: { data: string; mimeType: string; label?: string }[];
  lastToolAt: string;
  approvalDenied: string[];
}

function requestKey(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 16);
}

/** Words that indicate the user is asking for engineering work, not conversation. */
const ENGINEERING_INTENT =
  /\b(implement|add|fix|refactor|create|write|build|change|update|remove|delete|rename|migrate|deploy|install|configure|optimi[sz]e|upgrade|bump|patch|debug|set ?up|wire|integrat|extend|migrat|convert|clean ?up|replac|expose|hook ?up)\b/i;

const TEST_PATH = /(\.test\.|\.spec\.|^tests?[\/\\]|__tests__|\/testing\/)/i;

export class LifecycleController {
  private readonly opts: ControllerOptions;
  private observation: SessionObservation = {
    mutations: 0,
    failedMutations: 0,
    commands: [],
    riskFloor: "LOW",
    images: [],
    lastToolAt: "",
    approvalDenied: [],
  };
  private passInFlight: Promise<SettleResult> | undefined;
  private activeRunId: string | undefined;
  /** Fingerprints already escalated for the current content, to avoid repeat noise. */
  private notifiedGateFailures = new Set<string>();

  constructor(opts: ControllerOptions) {
    this.opts = opts;
  }

  get policy(): EngineeringPolicy {
    return this.opts.policy;
  }

  activeRun(): LifecycleRun | undefined {
    if (this.activeRunId) return this.opts.store.get(this.activeRunId);
    return this.opts.store.activeFor(this.opts.sessionKey);
  }

  private async setState(
    run: LifecycleRun,
    to: LifecycleState,
    trigger: LifecycleTrigger,
    detail?: string,
  ): Promise<boolean> {
    const check = canTransition(run.state, to, trigger);
    if (!check.ok) {
      this.opts.telemetry.emit(
        "lifecycle.transition",
        { from: run.state, to, trigger, rejected: check.reason },
        { runId: run.runId, sessionKey: this.opts.sessionKey },
      );
      // A rejected transition is recorded but never fatal: the run keeps its
      // last valid state, which is what the gate will be evaluated against.
      return false;
    }
    const from = run.state;
    run.state = to;
    run.updatedAt = new Date().toISOString();
    await this.opts.store.save(run);
    await this.opts.store.recordTransition(run.runId, to, trigger, detail);
    this.opts.telemetry.transition({ runId: run.runId, sessionKey: this.opts.sessionKey, from, to, trigger, detail });
    return true;
  }

  /** Open (or reuse) a run for a user request. Returns the run and whether a plan is required. */
  async noteRequest(
    text: string,
    images: { data: string; mimeType: string; label?: string }[] = [],
  ): Promise<{ run: LifecycleRun; planRequired: boolean }> {
    const key = requestKey(text);
    const existing = this.opts.store.byRequestKey(key);
    if (existing && !["COMPLETE", "ESCALATED"].includes(existing.state)) {
      this.activeRunId = existing.runId;
      if (images.length) this.observation.images = [...this.observation.images, ...images];
      return { run: existing, planRequired: this.planRequired(existing.classification) };
    }

    const preliminary = classifyWork({ request: text, files: [], commands: [] });
    const isEngineering =
      ENGINEERING_INTENT.test(text) || preliminary.categories.some((c) => c !== "chat" && c !== "unknown");
    const run: LifecycleRun = {
      runId: newRunId(),
      sessionKey: this.opts.sessionKey,
      requestKey: key,
      request: text,
      requirementIds: [],
      specPaths: extractSpecPaths(text),
      state: "RECEIVED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rounds: 0,
      maxRounds: this.opts.policy.lifecycle.max_remediation_rounds,
      baseCommit: "",
      lastSnapshotFingerprint: "",
      ignoredFingerprints: [],
      openFingerprints: [],
      routing: [],
      reviews: [],
      verifications: [],
      remediations: [],
      checkOverrides: [],
      notes: isEngineering
        ? []
        : ["request did not look like engineering work; the run stays passive until a change is observed"],
    };
    await this.opts.store.save(run);
    await this.setState(run, "CLASSIFIED", "request", "intent classified");
    this.opts.telemetry.runStarted({
      runId: run.runId,
      sessionKey: this.opts.sessionKey,
      request: text,
      categories: preliminary.categories,
      risk: preliminary.risk,
    });
    this.activeRunId = run.runId;
    if (images.length) this.observation.images = [...this.observation.images, ...images];
    await this.opts.record?.({ kind: "requirement", text: `Lifecycle requirement: ${text.slice(0, 500)}` });
    const planRequired = this.planRequired(preliminary);
    run.classification = preliminary;
    if (planRequired)
      await this.setState(run, "PLAN_PENDING", "request", `plan required: ${preliminary.planTriggers.join(", ")}`);
    else await this.setState(run, "IMPLEMENTATION_PENDING", "request", "no plan required");
    return { run, planRequired };
  }

  private planRequired(classification?: Classification): boolean {
    if (!classification) return false;
    if (classification.planTriggers.length === 0) return false;
    const threshold = this.opts.policy.lifecycle.plan_threshold_risk;
    const risky = riskRank(classification.risk) >= riskRank(threshold);
    const categorized = classification.categories.some((c) =>
      this.opts.policy.lifecycle.plan_threshold_categories.includes(c),
    );
    return risky || categorized;
  }

  /**
   * Observe an outgoing tool call. Returns a block instruction when the
   * destructive gate demands approval first.
   */
  async observeToolCall(toolName: string, input: unknown): Promise<{ block?: boolean; reason?: string } | undefined> {
    if (!isMutatingTool(toolName)) return undefined;
    const command = toolName === "bash" || toolName === "powershell" ? commandFromToolInput(input) : undefined;
    this.observation.lastToolAt = new Date().toISOString();

    if (!command) {
      this.observation.mutations++;
      return undefined;
    }

    const gate = gateOperation(command, this.opts.policy.policies.risk);
    this.observation.commands.push(command);
    this.observation.riskFloor = maxRisk(this.observation.riskFloor, gate.classification.risk);

    if (gate.decision !== "require_approval") {
      if (gate.decision === "review_after") {
        this.opts.notify?.(
          `[engineering] ${gate.classification.risk} operation allowed and routed to specialist review: ${command.slice(0, 80)}`,
          "info",
        );
      }
      return undefined;
    }

    const interactive = !!this.opts.requestApproval;
    let approved = false;
    let why: string;
    if (interactive) {
      approved = await this.opts.requestApproval!({
        command,
        risk: gate.classification.risk,
        reason: gate.reason,
        capability: gate.classification.capability,
      }).catch(() => false);
      why = approved ? "approved by operator" : "operator declined";
    } else {
      approved = this.opts.policy.policies.risk.unattended === "allow_with_log";
      why = approved
        ? "auto-allowed by policies.risk.unattended=allow_with_log"
        : "no interactive approver is available (policies.risk.unattended=block)";
    }
    this.opts.telemetry.approval({
      runId: this.activeRunId,
      command,
      risk: gate.classification.risk,
      decision: approved ? "allow" : "block",
      approved,
      reason: why,
    });
    await this.opts.record?.({
      kind: "decision",
      text: `Pre-execution gate ${approved ? "allowed" : "blocked"} ${gate.classification.risk} command (${gate.classification.reasons[0] ?? "policy match"}): ${why}`,
      severity: gate.classification.risk.toLowerCase(),
    });

    if (approved) return undefined;
    this.observation.approvalDenied.push(command);
    const capabilityHint = gate.classification.capability
      ? ` The "${gate.classification.capability}" capability is preserved by policy — re-run once an operator approves, or lower policies.risk.pre_execution_approval_at is not permitted.`
      : "";
    return {
      block: true,
      reason:
        `[engineering gate] Blocked: ${gate.reason} (${why}).${capabilityHint} ` +
        `Explain what you wanted to run and why in your reply; the harness records the decision. Command: ${command.slice(0, 200)}`,
    };
  }

  /** Observe a completed tool call so failures and image outputs are accounted for. */
  observeToolResult(
    toolName: string,
    isError: boolean,
    images: { data: string; mimeType: string; label?: string }[] = [],
  ): void {
    if (!isMutatingTool(toolName)) return;
    if (isError) this.observation.failedMutations++;
    if (images.length) this.observation.images = [...this.observation.images, ...images];
  }

  /** Attach images observed in the turn (user attachments) for vision routing. */
  attachImages(images: { data: string; mimeType: string; label?: string }[]): void {
    if (images.length) this.observation.images = [...this.observation.images, ...images];
  }

  /**
   * Run one automatic lifecycle pass. Called when the agent settles: it either
   * completes the work, asks for remediation, or escalates.
   */
  settle(trigger: LifecycleTrigger = "turn_settled"): Promise<SettleResult> {
    if (this.passInFlight) return this.passInFlight;
    this.passInFlight = this.runPass(trigger).finally(() => {
      this.passInFlight = undefined;
    });
    return this.passInFlight;
  }

  private async runPass(trigger: LifecycleTrigger): Promise<SettleResult> {
    if (!this.opts.policy.lifecycle.automatic) return { action: "none", detail: "lifecycle.automatic is false" };

    let run = this.activeRun();
    const deadline = Date.now() + this.opts.policy.lifecycle.budget_ms;

    // A settle after remediation is the next round of the same run.
    if (run?.state === "REMEDIATING") {
      run.rounds++;
      await this.setState(run, "CHANGE_CLASSIFIED", trigger, `remediation round ${run.rounds} settled`);
    }

    const snapshot = await captureChangeSnapshot({
      cwd: this.opts.cwd,
      baseRef: run?.baseCommit || undefined,
      mutationsObserved: this.observation.mutations,
      commandsObserved: this.observation.commands,
    });
    if (!run) {
      // No explicit request: adopt observed work so unattended edits are still gated.
      if (!hasMeaningfulChange(snapshot)) return { action: "none", detail: "no active run and no repository change" };
      run = await this.adoptObservedWork(snapshot);
    }
    if (["COMPLETE", "ESCALATED"].includes(run.state)) {
      if (snapshot.fingerprint === run.lastSnapshotFingerprint)
        return { action: "none", run, detail: "already gated for this content" };
      run.state = "RECEIVED";
      run.notes.push("reopened: the repository changed after the run reached a terminal state");
      await this.setState(run, "RECEIVED", trigger, "reopened after change");
    }
    if (run.state === "BLOCKED") {
      if (!hasMeaningfulChange(snapshot)) return { action: "blocked", run, detail: "run is blocked" };
      await this.setState(run, "CHANGE_CLASSIFIED", trigger, "work observed while blocked; re-evaluating");
    }
    if (!hasMeaningfulChange(snapshot)) {
      if (ENGINEERING_INTENT.test(run.request)) {
        await this.setState(run, "BLOCKED", trigger, "no repository change detected for an engineering request");
        const message =
          "[engineering gate] No repository change was detected, so nothing could be verified or reviewed. State is blocked — make the change or say explicitly why the work is not being done.";
        this.opts.notify?.(message, "warning");
        return { action: "blocked", run, message };
      }
      await this.setState(run, "COMPLETE", trigger, "conversation only; no change required");
      return { action: "complete", run, detail: "no engineering change required" };
    }

    run.lastSnapshotFingerprint = snapshot.fingerprint;
    run.baseCommit = run.baseCommit || snapshot.headCommit;
    await this.opts.store.save(run);
    await this.setState(run, "IMPLEMENTING", trigger, `${snapshot.files.length} changed file(s)`);
    await this.setState(run, "IMPLEMENTED", trigger, `${snapshot.files.length} changed file(s)`);

    const classification = classifyWork({
      request: run.request,
      files: snapshot.files,
      diffExcerpt: snapshot.diffExcerpt,
      commands: snapshot.commandsObserved,
      riskFloor: this.observation.riskFloor,
      changedLines: snapshot.files.reduce((sum, f) => sum + f.linesAdded + f.linesDeleted, 0),
    });
    run.classification = classification;
    await this.setState(
      run,
      "CHANGE_CLASSIFIED",
      trigger,
      `${classification.categories.join(",")} risk ${classification.risk}`,
    );

    // ---------------------------------------------------------------- verify
    await this.setState(run, "VERIFYING", trigger, "implementation verification");
    const checks = await planChecks({
      cwd: this.opts.cwd,
      policy: this.opts.policy,
      categories: classification.categories,
      extra: run.checkOverrides,
    });
    const verification = await runChecks({
      cwd: this.opts.cwd,
      specs: checks,
      artifacts: this.opts.artifacts,
      stage: "implementation",
      round: run.rounds,
    });
    run.verifications.push(verification);
    await this.opts.store.save(run);
    this.reportVerification(run, verification);
    await this.setState(
      run,
      verification.status === "passed" || verification.status === "not_applicable" ? "VERIFIED" : "VERIFICATION_FAILED",
      trigger,
      verification.status,
    );

    // ---------------------------------------------------------------- review
    const reports: ReviewReport[] = [];
    const roundReports = await this.runReviews(run, snapshot, classification, checks, verification, deadline);
    reports.push(...roundReports.reports);
    run.routing.push(...roundReports.decisions);

    // -------------------------------------------------------- spec verify
    let specReport: ReviewReport | undefined;
    if (run.specPaths.length > 0) {
      await this.setState(run, "SPEC_VERIFY_PENDING", trigger, `spec: ${run.specPaths.join(",")}`);
      const outcome = await this.opts.roles.runReview({
        role: "spec_verifier",
        request: run.request,
        round: run.rounds,
        snapshot,
        spec: await this.loadSpec(run.specPaths),
        checks: [verification],
        priorFindings: reports,
        requester: this.authorModel(run),
        timeoutMs: this.opts.policy.policies.review.specialist_timeout_ms,
      });
      reports.push(outcome.report);
      run.routing.push(outcome.decision);
      this.opts.telemetry.routing({ runId: run.runId, sessionKey: this.opts.sessionKey, decision: outcome.decision });
      specReport = outcome.report;
      await this.setState(
        run,
        outcome.report.verdict === "failed" ? "SPEC_VERIFY_FAILED" : "SPEC_VERIFIED",
        trigger,
        outcome.report.verdict,
      );
    }

    // ------------------------------------------------------ final verification
    let finalVerification = verification;
    const needsFinal = verification.status !== "passed" ? false : reports.length > 0 || run.rounds > 0;
    if (needsFinal && Date.now() < deadline) {
      await this.setState(run, "FINAL_VERIFY_PENDING", trigger, "re-verify after review");
      finalVerification = await runChecks({
        cwd: this.opts.cwd,
        specs: checks,
        artifacts: this.opts.artifacts,
        stage: "final",
        round: run.rounds,
      });
      run.verifications.push(finalVerification);
      this.reportVerification(run, finalVerification);
      await this.setState(run, "FINAL_VERIFIED", trigger, finalVerification.status);
    }

    // ---------------------------------------------------------------- gate
    const unresolved = this.unresolvedFindings(run, reports);
    run.openFingerprints = unresolved;
    const gate = evaluateGate({
      run,
      policy: this.opts.policy,
      classification,
      changeObserved: true,
      reviews: reports,
      requiredSpecialists: this.requiredSpecialists(classification, snapshot),
      verification,
      finalVerification,
      specVerification: specReport,
      unresolvedFingerprints: unresolved,
      implementerModel: this.authorModelKey(run),
      testFilesChanged: snapshot.files.filter((f) => TEST_PATH.test(f.path)).length,
    });
    run.gate = gate;
    await this.opts.store.save(run);
    this.opts.telemetry.gate({ runId: run.runId, gate, round: run.rounds });
    await this.opts.record?.({
      kind: "decision",
      text: `Completion gate ${gate.pass ? "passed" : "failed"} (round ${run.rounds}): ${gate.items.map((i) => `${i.key}=${i.status}`).join(", ")}`,
    });

    if (gate.pass) {
      run.completedAt = new Date().toISOString();
      await this.setState(run, "COMPLETE", trigger, "gate satisfied");
      const message = buildCompletionReport({
        state: "COMPLETE",
        pass: true,
        gateBlockers: [],
        rounds: run.rounds,
        files: snapshot.files.length,
        reports,
        verification: finalVerification,
        models: reports.map((r) => `${r.model.provider}/${r.model.id}`),
      });
      this.opts.notify?.(message, "info");
      this.resetObservation();
      return { action: "complete", run, message };
    }

    if (run.rounds >= run.maxRounds) {
      await this.setState(run, "REMEDIATION_REQUIRED", trigger, "round budget spent");
      await this.setState(run, "ESCALATED", trigger, `${gate.blockers.length} blocker(s) after ${run.rounds} round(s)`);
      const message = buildCompletionReport({
        state: "ESCALATED",
        pass: false,
        gateBlockers: gate.blockers,
        rounds: run.rounds,
        files: snapshot.files.length,
        reports,
        verification: finalVerification,
        models: reports.map((r) => `${r.model.provider}/${r.model.id}`),
      });
      this.opts.notify?.(message, "error");
      return { action: "escalate", run, message };
    }

    const brief = buildRemediationBrief({
      round: run.rounds + 1,
      reports,
      verification: finalVerification.status === "passed" ? verification : finalVerification,
      gateBlockers: gate.blockers,
    });
    await this.setState(run, "REMEDIATION_REQUIRED", trigger, gate.blockers[0] ?? "gate blockers");
    const remediation = {
      round: run.rounds + 1,
      at: new Date().toISOString(),
      fingerprints: unresolved,
      instruction: brief,
      target: this.opts.policy.lifecycle.remediation,
      resolvedFingerprints: [],
      outcome: "pending" as const,
    };
    run.remediations.push(remediation);
    await this.setState(run, "REMEDIATING", trigger, `${unresolved.length} finding(s) to fix`);
    await this.opts.record?.({
      kind: "finding",
      text: `Remediation round ${remediation.round} requested: ${gate.blockers.slice(0, 3).join("; ")}`,
      severity: "medium",
    });
    this.opts.notify?.(
      `[engineering] Gate not satisfied — automatic remediation round ${remediation.round} of ${run.maxRounds}.`,
      "warning",
    );
    return { action: "remediate", run, message: brief };
  }

  private async adoptObservedWork(snapshot: ChangeSnapshot): Promise<LifecycleRun> {
    const run: LifecycleRun = {
      runId: newRunId(),
      sessionKey: this.opts.sessionKey,
      requestKey: `adopted-${snapshot.fingerprint}`,
      request: "Repository changes observed without an explicit engineering request.",
      requirementIds: [],
      specPaths: [],
      state: "RECEIVED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rounds: 0,
      maxRounds: this.opts.policy.lifecycle.max_remediation_rounds,
      baseCommit: snapshot.headCommit,
      lastSnapshotFingerprint: snapshot.fingerprint,
      ignoredFingerprints: [],
      openFingerprints: [],
      routing: [],
      reviews: [],
      verifications: [],
      remediations: [],
      checkOverrides: [],
      notes: ["run adopted from observed tool activity"],
    };
    await this.opts.store.save(run);
    await this.setState(run, "CLASSIFIED", "tool_activity", "adopted from observed changes");
    this.opts.telemetry.runStarted({
      runId: run.runId,
      sessionKey: this.opts.sessionKey,
      request: run.request,
      categories: [],
      risk: this.observation.riskFloor,
    });
    this.activeRunId = run.runId;
    return run;
  }

  private authorModel(run: LifecycleRun): ModelRef | undefined {
    if (run.authorModel) return parseMaybe(run.authorModel);
    return this.opts.sessionModel?.();
  }

  /** `provider/id` identity of the model that produced the change. */
  private authorModelKey(run: LifecycleRun): string | undefined {
    const model = this.authorModel(run);
    return model ? modelKey(model) : undefined;
  }

  private requiredSpecialists(classification: Classification, snapshot: ChangeSnapshot): string[] {
    const out = new Set<string>(this.opts.policy.policies.review.specialists_enabled ? classification.specialists : []);
    const imagesPresent =
      this.observation.images.length > 0 || imageFilesIn(snapshot.files.map((f) => f.path)).length > 0;
    const session = this.opts.sessionModel?.();
    const sessionRecord = session ? this.opts.registry.get(session) : undefined;
    const handoff = shouldHandOffVision({
      visionRequired: classification.visionRequired,
      forceHandoff: this.opts.policy.vision.force_handoff,
      sessionHasVision: !!sessionRecord && hasCapability(sessionRecord, "vision"),
      imagesPresent,
    });
    if (handoff.handoff) out.add(classification.categories.includes("ui_ux") ? "ui_reviewer" : "vision_reviewer");
    return [...out];
  }

  private async runReviews(
    run: LifecycleRun,
    snapshot: ChangeSnapshot,
    classification: Classification,
    checks: CheckSpec[],
    verification: VerificationReport,
    deadline: number,
  ): Promise<{ reports: ReviewReport[]; decisions: RoutingDecision[] }> {
    const reports: ReviewReport[] = [];
    const decisions: RoutingDecision[] = [];
    const prior = run.reviews.filter((r) => r.round < run.rounds);
    const baseSpec: RoleSpec = {
      role: "reviewer",
      request: run.request,
      round: run.rounds,
      snapshot,
      checks: run.verifications,
      priorFindings: prior,
      requester: this.authorModel(run),
      timeoutMs: this.opts.policy.policies.review.specialist_timeout_ms,
    };

    await this.setState(run, "REVIEW_PENDING", "turn_settled", "independent review required");
    await this.setState(run, "REVIEWING", "turn_settled", "reviewer dispatched");
    const primary = await this.opts.roles.runReview(baseSpec);
    reports.push(primary.report);
    decisions.push(primary.decision);
    this.opts.telemetry.routing({ runId: run.runId, sessionKey: this.opts.sessionKey, decision: primary.decision });
    this.opts.telemetry.review({
      runId: run.runId,
      role: primary.report.role,
      model: primary.report.model,
      verdict: primary.report.verdict,
      findings: primary.report.findings.length,
      blockers: primary.report.findings.filter((f) => ["blocker", "critical", "high"].includes(f.severity)).length,
      durationMs: primary.report.durationMs,
    });
    await this.setState(
      run,
      primary.report.verdict === "failed" ? "REVIEW_FAILED" : "REVIEWED",
      "turn_settled",
      primary.report.verdict,
    );

    const specialists = this.requiredSpecialists(classification, snapshot).filter((r) => r !== "reviewer");
    if (specialists.length && this.opts.policy.policies.review.specialists_enabled && Date.now() < deadline) {
      await this.setState(run, "SPECIALIST_REVIEW_PENDING", "turn_settled", specialists.join(","));
      const images = await this.gatherImages(classification, snapshot);
      const results = await this.fanOut(specialists, async (role) => {
        const spec: RoleSpec = {
          ...baseSpec,
          role: role as RoleName,
          images: images.length ? images.slice(0, this.opts.policy.vision.max_images_per_review) : undefined,
          extraKickoff: `Specialist scope: ${role}. ${ROLE_REQUIREMENTS[role as RoleName] ?? ""}`.trim(),
        };
        return this.opts.roles.runReview(spec);
      });
      let anyFailed = false;
      for (const result of results) {
        if (!result) continue;
        reports.push(result.report);
        decisions.push(result.decision);
        this.opts.telemetry.routing({ runId: run.runId, sessionKey: this.opts.sessionKey, decision: result.decision });
        this.opts.telemetry.review({
          runId: run.runId,
          role: result.report.role,
          model: result.report.model,
          verdict: result.report.verdict,
          findings: result.report.findings.length,
          blockers: result.report.findings.filter((f) => ["blocker", "critical", "high"].includes(f.severity)).length,
          durationMs: result.report.durationMs,
        });
        if (result.report.verdict === "failed") anyFailed = true;
      }
      await this.setState(
        run,
        anyFailed ? "SPECIALIST_REVIEW_FAILED" : "SPECIALIST_REVIEWED",
        "turn_settled",
        `${specialists.length} specialist(s)`,
      );
    }

    for (const report of reports) {
      run.reviews.push(report);
      await this.opts.record?.({
        kind: "finding",
        text: `[${report.role}] ${report.verdict}: ${
          report.findings
            .slice(0, 5)
            .map((f) => `${f.severity} ${f.title}`)
            .join("; ") || "no findings"
        }`,
        severity: report.findings.some((f) => f.severity === "critical" || f.severity === "blocker") ? "high" : "low",
      });
    }
    await this.opts.store.save(run);
    return { reports, decisions };
  }

  /** Bounded-concurrency fan-out: one failing specialist must not cancel siblings. */
  private async fanOut<T, R>(
    items: T[],
    fn: (item: T) => Promise<R>,
    concurrency = this.opts.policy.lifecycle.max_concurrency,
  ): Promise<(R | undefined)[]> {
    const results: (R | undefined)[] = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index] as T);
        } catch {
          results[index] = undefined;
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async gatherImages(
    classification: Classification,
    snapshot: ChangeSnapshot,
  ): Promise<{ data: string; mimeType: string; label?: string }[]> {
    const out = [...this.observation.images];
    if (out.length === 0) {
      const candidates = imageFilesIn(
        snapshot.files.map((f) => f.path),
        { max: this.opts.policy.vision.max_images_per_review },
      );
      out.push(...(await loadImageFiles(this.opts.cwd, candidates)));
    }
    if (
      out.length === 0 &&
      this.opts.policy.vision.enabled &&
      this.opts.policy.vision.capture_command &&
      classification.visionRequired
    ) {
      const captured = await captureScreenshots({
        cwd: this.opts.cwd,
        command: this.opts.policy.vision.capture_command,
        timeoutMs: this.opts.policy.vision.capture_timeout_ms,
        newerThan: Date.now() - 5 * 60_000,
      });
      out.push(...captured.images);
    }
    return out;
  }

  /** Findings still open: high-severity, not ignored, seen in the newest round. */
  private unresolvedFindings(run: LifecycleRun, reports: ReviewReport[]): string[] {
    const latest = new Map<string, ReviewReport["role"]>();
    const open = new Set<string>();
    for (const report of reports) {
      for (const finding of report.findings) {
        if (!["blocker", "critical", "high"].includes(finding.severity)) continue;
        if (run.ignoredFingerprints.includes(finding.fingerprint)) continue;
        if (latest.has(finding.fingerprint)) continue;
        latest.set(finding.fingerprint, report.role);
        open.add(finding.fingerprint);
      }
    }
    return [...open];
  }

  private reportVerification(run: LifecycleRun, report: VerificationReport): void {
    this.opts.telemetry.verification({
      runId: run.runId,
      stage: report.stage,
      status: report.status,
      passed: report.outcomes.filter((o) => o.status === "passed").length,
      failed: report.outcomes.filter((o) => o.status === "failed").length,
      other: report.outcomes.filter((o) => o.status !== "passed" && o.status !== "failed").length,
      durationMs: report.outcomes.reduce((sum, o) => sum + o.durationMs, 0),
    });
  }

  private async loadSpec(paths: string[]): Promise<{ path: string; excerpt: string }> {
    const { readFile } = await import("node:fs/promises");
    const parts: string[] = [];
    for (const path of paths.slice(0, 3)) {
      try {
        const text = await readFile(new URL(`file://${path}`).pathname, "utf-8");
        parts.push(`### ${path}\n${text.slice(0, 24_000)}`);
      } catch {
        parts.push(`### ${path}\n(unreadable)`);
      }
    }
    return { path: paths.join(", "), excerpt: parts.join("\n\n") };
  }

  private resetObservation(): void {
    this.observation = {
      mutations: 0,
      failedMutations: 0,
      commands: [],
      riskFloor: "LOW",
      images: [],
      lastToolAt: "",
      approvalDenied: [],
    };
  }

  /** Operator override: ignore a finding fingerprint for this run. */
  async ignoreFinding(fingerprint: string): Promise<void> {
    const run = this.activeRun();
    if (!run) return;
    if (!run.ignoredFingerprints.includes(fingerprint)) run.ignoredFingerprints.push(fingerprint);
    run.openFingerprints = run.openFingerprints.filter((f) => f !== fingerprint);
    await this.opts.store.save(run);
  }

  /** Operator override: force another remediation round even past the budget. */
  async reopenRun(reason: string): Promise<LifecycleRun | undefined> {
    const run = this.activeRun();
    if (!run) return undefined;
    run.rounds = 0;
    run.notes.push(`reopened by operator: ${reason}`);
    await this.setState(run, "REMEDIATING", "command", reason);
    return run;
  }

  /** Store a plan artifact produced before implementation (spec §6.4). */
  async recordPlan(artifactUri: string): Promise<void> {
    const run = this.activeRun();
    if (!run) return;
    run.planArtifactUri = artifactUri;
    await this.setState(run, "PLANNED", "command", `plan ${artifactUri}`);
  }

  /** Compact status for `/engineering status`. */
  statusSummary(): {
    runId?: string;
    state?: LifecycleState;
    categories?: WorkCategory[];
    risk?: LifecycleRisk;
    rounds?: string;
    gate?: string;
    blockers?: string[];
    lastModels?: string[];
  } {
    const run = this.activeRun();
    if (!run) return {};
    const latest = run.reviews.filter((r) => r.round === run.rounds);
    return {
      runId: run.runId,
      state: run.state,
      categories: run.classification?.categories,
      risk: run.classification?.risk,
      rounds: `${run.rounds}/${run.maxRounds}`,
      gate: run.gate ? (run.gate.pass ? "PASS" : `FAIL (${run.gate.blockers.length})`) : "not evaluated",
      blockers: run.gate?.blockers.slice(0, 5) ?? [],
      lastModels: latest.map((r) => `${r.role}=${r.model.provider}/${r.model.id}`),
    };
  }

  /** Persist a large text as an artifact reference rather than inlining it. */
  async stash(kind: string, text: string, summary: string): Promise<string> {
    const meta = await this.opts.artifacts.put(kind, newArtifactId(), text, summary);
    return meta.uri;
  }
}

function parseMaybe(ref: string): ModelRef | undefined {
  const [provider, ...rest] = ref.split("/");
  if (!provider || rest.length === 0) return undefined;
  return { provider, id: rest.join("/") };
}

/** Specification paths referenced in the request text. */
function extractSpecPaths(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/[\w./-]+\.(?:md|markdown|txt|yaml|yml)\b/g)) {
    const path = match[0];
    if (/spec|requirement|design|rfc|issue|ticket/i.test(path)) out.add(path);
  }
  return [...out].slice(0, 3);
}

export { VisionCache };
