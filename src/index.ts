export * from "./core/types.ts";
export * from "./platform/index.ts";
export * from "./platform/security.ts";
export * from "./platform/memoryOutbox.ts";
export { id, newRunId } from "./core/ids.ts";
export { EventStore } from "./ledger/EventStore.ts";
export { Ledger } from "./ledger/Ledger.ts";
export { ArtifactStore } from "./artifacts/ArtifactStore.ts";
export { ContextBroker, estimateTokens } from "./context/ContextBroker.ts";
export { GitRepo } from "./git/GitRepo.ts";
export { CommandVerifier } from "./verify/Verifier.ts";
export type { VerificationProvider, VerificationProfile, VerifyOutcome, StageRun } from "./verify/Verifier.ts";
export type { WorkerExecutor, WorkerRequest, WorkerRun } from "./workers/WorkerExecutor.ts";
export { PiWorkerExecutor } from "./workers/PiWorkerExecutor.ts";
export { FakeWorkerExecutor } from "./workers/FakeWorkerExecutor.ts";
export { buildSystemPrompt, WORKER_KICKOFF } from "./workers/prompts.ts";
export { workerResultTool } from "./workers/workerResultTool.ts";
export { reviewResultTool } from "./lifecycle/reviewResultTool.ts";
export { buildCoreTools } from "./tools/coreTools.ts";
// Capability-aware model router (standalone; no lifecycle harness).
export { createRoleRouter } from "./capability/adapter.ts";
export type { RoleRouterAdapter, RouteAdapterOptions } from "./capability/adapter.ts";
export { RoleRouter } from "./capability/router.ts";
export { ModelCapabilityRegistry } from "./capability/registry.ts";
export { ROLE_REQUIREMENTS } from "./capability/roles.ts";
export type { RoleName } from "./capability/roles.ts";
export { parseRef } from "./capability/router.ts";
// InferWeave admission-retry subsystem.
export * from "./inference/index.ts";
export type { CoreServices } from "./tools/coreTools.ts";
export { EngineeringRuntime } from "./runtime/EngineeringRuntime.ts";
export type {
  EngineerReport,
  EngineeringRuntimeOptions,
  TournamentReport,
  TournamentEntry,
} from "./runtime/EngineeringRuntime.ts";
export { RoadmapEngine, RoadmapError, ALL_EVIDENCE_TYPES } from "./roadmap/RoadmapEngine.ts";
export { RoadmapEvidenceStore } from "./roadmap/evidence.ts";
export { parseRoadmap } from "./roadmap/schema.ts";
export { evaluateMilestone, evaluateAll, milestoneRequiredTypes } from "./roadmap/evaluate.ts";
export { evaluateReleaseGate } from "./roadmap/releaseGate.ts";
export { runCheck, CHECKS } from "./roadmap/checks.ts";
export { runRoadmapCheck, runRoadmapStatus, defaultCliPaths } from "./roadmap/cli.ts";
export type { RoadmapCliOptions, RoadmapCliResult } from "./roadmap/cli.ts";
export type * from "./roadmap/types.ts";
export { ModelRouter, ROLE_CAPABILITIES } from "./routing/ModelRouter.ts";
export type { ModelProvider, RouteResult, Capability, WorkerRoleName } from "./routing/ModelRouter.ts";
export { Scheduler } from "./sched/Scheduler.ts";
export type { SchedulableTask, ScheduledOutcome } from "./sched/Scheduler.ts";
export { BudgetManager, DEFAULT_BUDGETS } from "./budget/BudgetManager.ts";
export type { BudgetSpec, BudgetState, BudgetRole } from "./budget/BudgetManager.ts";
export {
  ToolPolicy,
  redactSecrets,
  scanUntrustedInstructions,
  evaluateInstruction,
  SECRET_PATTERNS,
  SECRET_REDACTION,
  INJECTION_MARKERS,
} from "./security/SecurityPolicy.ts";
export type { ToolPolicyOptions, InjectionFinding, GuardrailVerdict } from "./security/SecurityPolicy.ts";
export { MergeQueue } from "./merge/MergeQueue.ts";
export type { GitPrimitives, PromoteResult, PromotionLevel } from "./merge/MergeQueue.ts";
export { buildSymbolIndex, symbolIndex, findSymbol, isSourceFile, NoopLspIntegration } from "./intel/RepoIntel.ts";
export type { SymbolLocation, LspIntegration } from "./intel/RepoIntel.ts";
export * from "./verify/farm/index.ts";
export { runBenchmark, evaluateBenchmark } from "./bench/Benchmark.ts";
export type { BenchmarkMetrics, BenchmarkBaseline, BenchmarkVerdict } from "./bench/Benchmark.ts";
export { AdapterRegistry } from "./adapters/Adapters.ts";
export type { AutoSpecAdapter, InferWeaveAdapter } from "./adapters/Adapters.ts";
// Orchestration module (spec pi-engineering-orchestration). Re-exported
// explicitly to avoid colliding with the existing core/platform `TaskKind`,
// `EntityId` and `AcceptanceCriterion` names. Full surface is available from
// `src/orchestration/index.ts`.
export {
  canTransitionMission,
  canTransitionTask,
  assertMissionTransition,
  assertTaskTransition,
  pathMatchesPattern,
  classifyFiles,
  deriveRequiredGates,
  mutationFactFromChangedFiles,
  workflowRank,
  classifyIntent,
  workflowForIntent,
  workflowMutatesRepo,
  classifyRiskDefault,
  IntentRouter,
  MissionStore,
  ExecutionBroker,
  MissionScheduler,
  classifyFailure,
  domainsOverlap,
  brokerKind,
  assertAcyclic,
  CompletionGate,
  Integrator,
  Orchestrator,
} from "./orchestration/index.ts";
export type {
  MissionStatus,
  WorkflowClass,
  Intent,
  RequiredGate,
  RiskProfile,
  Mission,
  OrchestrationTask,
  TaskStatus,
  IsolationMode,
  FailurePolicy,
  ExecutionBackend,
  ExecutionStatus,
  Execution,
  IntentResult,
  ReviewFinding,
  CompletionVerdict,
  FileClass,
  PolicyRule,
  MutationFact,
  AcceptanceCriterion as OrchestrationAcceptanceCriterion,
  TaskKind as OrchestrationTaskKind,
  EntityId as OrchestrationEntityId,
  MissionCreateInput,
  TaskCreateInput,
  OrchestrationEvent,
  OrchestrationEventType,
  ExecutionRequestInput,
  ExecutionHandle,
  ExecutionOutcome,
  SchedulerLimits,
  ScheduledTaskResult,
  SchedulerOptions as OrchestrationSchedulerOptions,
  BrokerBackends,
  BrokerOptions,
  AgentRunner,
  ProcessRunner,
  ReviewRunner,
  IntegrationRunner,
  ValidationRunner,
  OrchestratorOptions,
  OrchestrateResult,
  IntegratorInput,
  GateEvidence,
  IntentRouterOptions,
  RouteInput,
} from "./orchestration/index.ts";
export { exportTelemetry, formatTelemetry } from "./telemetry/TelemetryExport.ts";
export type { TelemetrySnapshot } from "./telemetry/TelemetryExport.ts";
export {
  GenerationGuard,
  ModelDegenerationError,
  normalizeSentence,
  splitSentences,
  splitCompleteSentences,
  guardFeedFor,
  RECOVERY_PROMPT,
  TOOL_TRANSITION_RULE,
  lowerReasoningEffort,
  decideRecovery,
  buildCompactedContext,
  buildDegenerationEvent,
  initialRecoveryTelemetry,
  DEFAULT_GUARD_CONFIG,
  resolveGuardConfig,
} from "./guard/index.ts";
export type {
  GuardDecision,
  GuardAbortReason,
  ProgressEventType,
  GenerationGuardState,
  ReasoningEffort,
  CompactionInput,
  RecoveryDecision,
  DegenerationEvent,
  RecoveryTelemetry,
  GenerationGuardConfig,
  GuardProfile,
  GuardFeed,
} from "./guard/index.ts";
export {
  AdmissionController,
  DEFAULT_GATEWAY_CONFIG,
  decideGatewayRetry,
  describeGatewayWait,
  parseGatewayWait,
  parseRetryAfterHeader,
  resolveGatewayConfig,
  sharedAdmissionController,
  sharedGatewayConfig,
} from "./gateway/index.ts";
export type {
  AdmissionControllerOptions,
  AdmissionEvent,
  AdmissionSlot,
  AdmissionStatus,
  GatewayAdmissionConfig,
  GatewayRetryDecision,
  GatewayWaitInput,
  GatewayWaitSignal,
} from "./gateway/index.ts";
export { PanelState } from "./panel/PanelState.ts";
export type {
  PanelFileEntry,
  PanelFinding,
  PanelRunView,
  PanelSectionError,
  PanelSpend,
  PanelStateShape,
  PanelWorkspaceView,
} from "./panel/PanelState.ts";
export { buildRows, clampSelection, SECTION_IDS } from "./panel/tree.ts";
export type { PanelRow, RowPayload } from "./panel/tree.ts";
export { LedgerFeeder } from "./panel/feeders/LedgerFeeder.ts";
export { WorkspaceFeeder, parseGitStatusShort } from "./panel/feeders/WorkspaceFeeder.ts";
export {
  MAX_CONTENT_BYTES,
  MAX_CONTENT_LINES,
  readDiffContent,
  readFileContent,
  toContentView,
} from "./panel/content.ts";
export type { ContentView } from "./panel/content.ts";
export { PanelComponent } from "./panel/PanelComponent.ts";
export { PanelController, matchesChord } from "./panel/PanelController.ts";
export { BlackholeManager } from "./blackhole/BlackholeManager.ts";
export type { BlackholeManagerOptions } from "./blackhole/BlackholeManager.ts";
export { resolveBlackholeConfig } from "./blackhole/config.ts";
export type { PartialBlackholeConfig, ConfigResult } from "./blackhole/config.ts";
export { MemoryStore } from "./blackhole/MemoryStore.ts";
export { newSessionIdentity, memoryWorkerIdentity } from "./blackhole/SessionStore.ts";
export type { SessionIdentity, SessionContext } from "./blackhole/SessionStore.ts";
export { InMemoryDurableMemory } from "./blackhole/OpenViking.ts";
export type { DurableMemoryProvider, DurableMemoryRecord } from "./blackhole/OpenViking.ts";
export { SharedFileDurableMemory, OpenVikingProvider } from "./blackhole/durable.ts";
export type { OpenVikingProviderOptions } from "./blackhole/durable.ts";
export { buildDurableProvider } from "./blackhole/BlackholeManager.ts";
export { decidePromotion } from "./blackhole/promotion.ts";
export type { PromotionDecision, PromotionOutcome } from "./blackhole/promotion.ts";
export { validateBlackholePackage, tryLoadBlackholePackage } from "./blackhole/versioning.ts";
export type { PackageValidation } from "./blackhole/versioning.ts";
export { blackholeTelemetry, formatBlackholeTelemetry } from "./blackhole/telemetry.ts";
export type { BlackholeTelemetry } from "./blackhole/telemetry.ts";
export {
  PINNED_BLACKHOLE_VERSION,
  BLACKHOLE_ALLOWLIST,
  sessionKey,
} from "./blackhole/types.ts";
export type {
  BlackholeConfig,
  BlackholeManagerState,
  MemoryEntry,
  MemoryPriority,
  PromotionCandidate,
  PromotionState,
  MemoryWorkerRole,
} from "./blackhole/types.ts";
export { runExperiment } from "./benchmark/ExperimentRunner.ts";
export type { ExperimentResult, ExperimentOptions, Workload } from "./benchmark/ExperimentRunner.ts";
export { summarize } from "./benchmark/Metrics.ts";
export type { RunMetrics, ConditionSummary, Condition } from "./benchmark/Metrics.ts";
export { generatePlots } from "./benchmark/Plots.ts";
export type { PlotSpec } from "./benchmark/Plots.ts";
export { renderReport } from "./benchmark/Report.ts";
export {
  panelHealth,
  panelPromotion,
  panelDurable,
  panelEntries,
  renderPanels,
} from "./blackhole/dashboard.ts";
export type { DashboardPanel } from "./blackhole/dashboard.ts";
// Autonomous UI engineering shared schema contracts (spec 01-contracts).
export {
  SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  RECORD_KINDS,
  SCHEMAS,
  TaskRequestSchema,
  ExecutionProvenanceSchema,
  EvidenceBundleSchema,
  FindingSchema,
  EvaluationRunSchema,
  DesignArtifactSchema,
  CandidateSchema,
  AcceptanceDecisionSchema,
  validateRecord,
  migrateRecord,
} from "./uieng/schemas.ts";
export type {
  RecordKind,
  TaskRequest,
  ExecutionProvenance,
  EvidenceBundle,
  Finding,
  EvaluationRun,
  DesignArtifact,
  Candidate,
  AcceptanceDecision,
  UiengRecord,
} from "./uieng/schemas.ts";
