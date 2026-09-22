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
// Runtime-neutral AgentRuntime seam (herdr spec 02/03/14). All external runtime
// access flows through AgentRuntime; legacy is the current backend, Herdr is
// added behind the same seam in Phase D.
export * from "./runtime/index.ts";
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

// Versioned 60-metric UI rubric engine (spec 02-rubric).
export {
  RUBRIC_VERSION,
  METRICS,
  METRIC_IDS,
  METRICS_BY_ID,
  RUBRIC_REGISTRY,
  validateMetricIds,
  assertMetricKnown,
  scoreRecord,
  scoreAll,
  aggregateScores,
} from "./uieng/rubric.ts";
export type {
  MetricSource,
  MetricSeverity,
  MetricAnchors,
  RubricMetric,
  MetricScoreInput,
  MetricScore,
  RubricAggregate,
} from "./uieng/rubric.ts";

// Automatic UI-impact policy + repo/UI discovery (spec 01-auto-policy).
export {
  discoverUiProfile,
  persistUiProfile,
  loadUiProfile,
  discoverAndPersistUiProfile,
  DISCOVERY_LIMITS,
} from "./uieng/discovery.ts";
export type { UiProfile } from "./uieng/discovery.ts";
export {
  UI_IMPACT_LEVELS,
  rankLevel,
  classifyChange,
  derivedEvaluation,
  gateFailed,
  autoAttach,
  METRIC_GROUP_IDS,
  METRIC_GROUPS,
  BROWSER_TEST_KINDS,
  VIEWPORT_TARGETS,
} from "./uieng/policy.ts";
export type {
  UiImpactLevel,
  MetricGroupId,
  BrowserTestKind,
  ViewportTarget,
  EvaluationPlan,
  AutoRemedy,
  GateFailure,
  GateBudget,
  AutoAttachOptions,
  AutoAttachDecision,
} from "./uieng/policy.ts";

// Evidence capture + deterministic analyzers (spec 02-evidence).
export {
  produceEvidenceBundle,
  validateEvidenceBundle,
  analyzeAccessibilityViolations,
  analyzeContrastRatios,
  analyzeTouchTargets,
  analyzeOverflow,
  analyzeBreakpoints,
  analyzeDesignTokenAdherence,
  analyzeDesignEntropy,
  analyzeStyleDuplication,
  analyzeCodeDuplication,
  analyzeComponentReuse,
  analyzeDomDepth,
  analyzeDeadStyles,
  analyzeKeyboardFocus,
  analyzeRefreshDeepLink,
  analyzeAssetWeight,
  analyzeRenderPerformance,
  analyzeLayoutStability,
  analyzeRuntimeErrors,
  analyzeCapture,
  toMetricScore,
  scoreAnalysis,
  MIN_TOUCH_TARGET,
  RECOMMENDED_TOUCH_TARGET,
} from "./uieng/evidence.ts";
export type {
  ViewportInfo,
  Bounds,
  CapturePlan,
  ProduceEvidenceOptions,
  AnalysisResult,
  A11yViolation,
  ContrastCheck,
  TouchTarget,
  OverflowRecord,
  BreakpointFailure,
  TokenViolation,
  DesignEntropyInput,
  DuplicateRecord,
  DuplicationInput,
  ComponentReuseInput,
  DomDepthInfo,
  DeadStyleRecord,
  DeadStyleInput,
  FocusIssue,
  RefreshDeepLinkFailure,
  BundlePerf,
  RenderPerf,
  RuntimeError,
  CaptureSnapshot,
} from "./uieng/evidence.ts";

// Versioned UI genome + design entropy + contract injection (spec 04-ui-genome).
export {
  GENOME_VERSION,
  GENOME_DIR_NAME,
  APPROVED_REFERENCE_DIR,
  GENOME_MANIFEST_FILE,
  GENOME_CONTRACT_NAMES,
  GENOME_CONTRACT_FILES,
  GENOME_CONTRACT_KEYS,
  DEFAULT_GENOME_ENTROPY_WEIGHTS,
  genomeDirPath,
  loadGenome,
  saveGenome,
  listGenomeFiles,
  validateGenome,
  normalizedShannonEntropy,
  computeGenomeEntropy,
  analyzeGenomeEntropy,
  isConstitutional,
  splitConstitutionalRules,
  relevantContracts,
  injectGenomeContracts,
} from "./uieng/genome.ts";
export type {
  ConstitutionRule,
  ConstitutionContract,
  TokensContract,
  ColorSwatch,
  ColorsContract,
  SpacingToken,
  SpacingContract,
  Breakpoint,
  BreakpointsContract,
  TypeScaleToken,
  TypographyContract,
  ComponentContract,
  ComponentsContract,
  Term,
  TerminologyContract,
  InteractionPattern,
  InteractionPatternContract,
  ResponsiveContract,
  AccessibilityContract,
  UiTask,
  TaskCatalogContract,
  ContractException,
  ExceptionsContract,
  GenomeContracts,
  UiGenome,
  GenomeContractKey,
  GenomeValidation,
  StyleUsage,
  GenomeEntropyInput,
  GenomeEntropyWeights,
  GenomeEntropy,
  GenomeInjectionOptions,
  GenomeInjection,
} from "./uieng/genome.ts";

// Runtime usability & robustness evaluation (spec 05-runtime-tests).
export {
  TASK_METRIC_MAPPING,
  evaluateCanonicalTask,
  viewportMetricGroup,
  buildViewportMatrix,
  VIEWPORT_MATRIX,
  SCENARIO_METRIC_MAP,
  ROBUSTNESS_SCENARIOS,
  analyzeRobustnessScenario,
  evaluateViewport,
  buildUsabilityEvaluationPlan,
  runUsabilityEvaluation,
} from "./uieng/usability.ts";
export type {
  TaskMode,
  CanonicalTask,
  TaskMetrics,
  TaskMetricKey,
  ViewportMatrixEntry,
  RobustnessScenarioKind,
  RobustnessScenario,
  RobustnessEvidence,
  RobustnessAnalyzeOptions,
  ViewportEvidence,
  UsabilityEvaluationPlan,
  UsabilityEvaluationInputs,
} from "./uieng/usability.ts";

// Automatic design exploration + diffusion planning (spec 03-design-exploration).
export {
  DIFFUSION_REFERENCE_NOTE,
  SUBSTANTIAL_TASK_THRESHOLD,
  EXPLORATION_TRIGGERS,
  REQUIREMENT_CATEGORIES,
  CAPABILITY_IDS,
  UX_ARCHITECTURE_CAPABILITY,
  DIFFUSION_IMAGE_GENERATION_CAPABILITY,
  RESPONSIVE_FAMILY_CAPABILITY,
  VISUAL_IDEATION_CAPABILITY,
  DESIGN_DEVICES,
  DESIGN_STATES,
  explorationTrigger,
  shouldExplore,
  explorationPlan,
  requestCapability,
  familyPlan,
  coversRequirement,
  checkRequirementsCoverage,
  SELECTION_OPS,
  selectArtifact,
  moreLikeThis,
  combineSelections,
  applyFeedback,
  letPiChoose,
  applySelectionOp,
  convertDesignDirection,
} from "./uieng/exploration.ts";
export type {
  ExplorationTriggerKind,
  ExplorationInputs,
  ExplorationRequirement,
  RequirementCategory,
  HypothesisArchetype,
  UxHypothesis,
  ExplorationPlan,
  CapabilityId,
  CapabilityRequestPayload,
  CapabilityRequest,
  DesignDevice,
  DesignState,
  DesignPage,
  DesignFamily,
  RequirementsCoverage,
  SelectionOp,
  SelectionResult,
  SelectionOpOptions,
  SelectedDirection,
} from "./uieng/exploration.ts";
// Vision payload management (spec pi-engineering-vision-payload-management-413-recovery).
// Pure deterministic logic; no image decoding.
export * from "./vision/observation.ts";
export * from "./vision/metrics.ts";
export {
  estimatePayloadBytes,
  estimateTokensForBytes,
  classifyBudget,
  RequestBudgetManager,
  PAYLOAD_REDUCTION_ORDER,
  DEFAULT_BUDGET_THRESHOLDS,
  JSON_SERIALIZATION_OVERHEAD_BYTES,
} from "./vision/budget.ts";
export type {
  PayloadBreakdown,
  BudgetThresholds,
  BudgetState as VisionBudgetState,
} from "./vision/budget.ts";
export * from "./vision/provider.ts";
export * from "./vision/asset.ts";
export * from "./vision/processor.ts";
export {
  UNIFIED_CONTRACT_SCHEMA_VERSION,
  TOPIC_AREAS,
  detectConflicts,
  DesignContractMerger,
  renderContractMarkdown,
} from "./vision/merger.ts";
export type {
  ReferencePrecedence,
  ReferenceConflict,
  ContractSection,
  UnifiedDesignContract,
} from "./vision/merger.ts";
export {
  DEFAULT_ANALYSIS_ROOT,
  VisionObservationStore,
  buildTraceability,
} from "./vision/store.ts";
export type { TraceabilityRecord } from "./vision/store.ts";

// Vision worker isolation + 413 recovery (Phase 3/4).
export {
  VISION_ANALYSIS_TASK,
  VISUAL_REGRESSION_TASK,
  IMPLEMENT_TASK,
  VISION_WORKER_INSTRUCTIONS,
  buildVisionWorkerContext,
  VisionAnalysisWorker,
} from "./vision/worker.ts";
export type { VisionWorkerRequest, VisionWorkerResult } from "./vision/worker.ts";
export {
  DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES,
  classifyBoundary,
  buildDiagnostic,
  PayloadRecoveryManager,
} from "./vision/recovery.ts";
export type { PayloadBoundary, PayloadDiagnostic } from "./vision/recovery.ts";

// Independent review / diagnosis / implementation-spec generation (spec 06-review-diagnose).
export {
  REVIEWER_ROLE_IDS,
  REVIEWER_ROLES,
  reviewerRoleById,
  normalizeRootCause,
  deriveRootCause,
  mapFindingSurface,
  clusterRootCauses,
  rankClusters,
  fnv1a,
  buildSpec,
  assembleReviewPlan,
  disagreementIndex,
} from "./uieng/review.ts";
export type {
  EvidenceField,
  ReviewerRoleId,
  ReviewerRole,
  ReviewerScore,
  ReviewerReview,
  EffortLevel,
  RiskLevel,
  RootCauseCluster,
  ImplementationSpecOptions,
  ImplementationSpec,
  ReviewPlan,
} from "./uieng/review.ts";

// Candidate tournaments + Pareto acceptance gates (spec 07-tournaments-gates).
export {
  buildEvaluationBattery,
  defaultCanonicalTasks,
  tournamentPlan,
  candidateProvenance,
  TournamentRunner,
  PERFORMANCE_COMPLEXITY_METRICS,
  performanceComplexityMetricIds,
  provenanceIdentity,
  changeRequiresApproval,
  evaluateCandidate,
  gateDisagreement,
} from "./uieng/tournament.ts";
export type {
  EvaluationBattery,
  TournamentPlan,
  TournamentOptions,
  GateBudgets,
  ParetoGateOptions,
  GatedAcceptanceDecision,
  GateCriterion,
} from "./uieng/tournament.ts";

// pi-web integration adapter surface (spec 09-pi-web-adapter).
export {
  WEB_SNAPSHOT_VERSION,
  UIENG_EVENT_TYPES,
  buildWebSnapshot,
  computeMetricDeltas,
  uiengEvaluationCompleted,
  uiengFindingMapped,
  uiengCandidateAccepted,
  uiengWorkDequeued,
  uiengApprovalRequested,
} from "./uieng/web.ts";
export type {
  UiengEventType,
  ScoreTrendPoint,
  BeforeAfterPair,
  TaskSuccessEntry,
  MetricDelta,
  WorkQueueItem,
  ProtectedApproval,
  WebSnapshotInput,
  WebSnapshot,
  UiengEventEnvelope,
  EvaluationCompletedEvent,
  FindingMappedEvent,
  CandidateAcceptedEvent,
  WorkDequeuedEvent,
  ApprovalRequestedEvent,
  UiengEvent,
  PiWebSnapshotQuery,
  PiWebQueueQuery,
  PiWebApprovalsQuery,
  PiWebAdapter,
} from "./uieng/web.ts";

// Autonomous UI quality controller (spec 08-autonomous-controller).
export {
  createQualityState,
  rollbackRefFor,
  debtSurface,
  remainingBudget,
  debtCost,
  debtLeverage,
  surfaceInCooldown,
  idleCapacityForDebt,
  evaluationScore,
  recentImprovement,
  checkStopConditions,
  controlEventFor,
  decideNext,
  applyAction,
  recordEvaluation,
  recordDecision,
  markDebtRemediated,
  rejectDebt,
  revertChange,
} from "./uieng/controller.ts";
export type {
  DebtItemStatus,
  DebtItem,
  Cooldown,
  UiQualityState,
  UiQualityConfig,
  ControllerContext,
  StopCondition,
  ControllerAction,
  ControlEventType,
  ControlEvent,
  RevertResult,
} from "./uieng/controller.ts";
export {
  VISUAL_DIFF_SCHEMA_VERSION,
  DEFAULT_VIEWPORTS,
  validateVisualDiffObservation,
  isVisualDiffObservation,
  renderVisualDiffMarkdown,
  planResponsiveViewports,
  VisualVerificationWorker,
} from "./vision/visual.ts";
export type {
  VisualDifference,
  Viewport,
  VisualDiffObservation,
  VisualVerificationRequest,
  VisualVerificationResult,
} from "./vision/visual.ts";

// InferWeave task routing + dynamically advertised capabilities (spec §30-31).
export {
  TASK_ANALYZE_UI,
  TASK_IMPLEMENT,
  TASK_VISUAL_REGRESSION,
  routeTask,
  DEFAULT_INFERWEAVE_CAPABILITIES,
  InferWeaveCapabilityClient,
  capabilitiesToJson,
} from "./vision/inferweave.ts";
export type { VisionTask, VisionTaskRoute, InferWeaveCapabilities } from "./vision/inferweave.ts";
// Staged rollout state machine (spec 10-rollout.md).
export {
  ROLLOUT_STAGE_ORDER,
  rolloutStageIndex,
  stageMutatesRepo,
  canAdvance,
  evidenceAllowsAdvance,
  nextStage,
  captureBaselineSnapshot,
  createRolloutState,
  recordRolloutTransition,
  checkRollbackConditions,
  isAuthoritativeGate,
  rolloutApprovalForChange,
  rolloutDisagreement,
  rolloutBudgetAvailable,
  rolloutAutoAttach,
  rolloutShouldExplore,
} from "./uieng/rollout.ts";
export type {
  RolloutStage,
  RolloutConfig,
  RolloutEvidence,
  BaselineSnapshot,
  RollbackCondition,
  RolloutTransition,
  RolloutState,
  RollbackCandidate,
  RollbackViolation,
  RollbackCheck,
  GateKind,
  GateRef,
} from "./uieng/rollout.ts";

export * from "./request/index.ts";
