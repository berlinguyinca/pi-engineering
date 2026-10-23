/** Herdr runtime backend (herdr spec 03). All Herdr access stays behind this. */
export { HerdrAgentRuntime } from "./HerdrAgentRuntime.ts";
export type { HerdrAgentRuntimeOptions } from "./HerdrAgentRuntime.ts";
export { RealHerdrCli, HerdrError } from "./HerdrCli.ts";
export { HostConfigUnavailable, loadHostConfig } from "./HostConfig.ts";
export type { HostConfig, LoadHostConfigOptions } from "./HostConfig.ts";
export { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
export type { ControlPlaneIngestOptions } from "./ControlPlaneIngest.ts";
export type { HerdrCli, HerdrAgent, HerdrStatus, RealHerdrCliOptions } from "./HerdrCli.ts";
export { herdrEnsureLocal, detectHerdr } from "./ensureHerdr.ts";
export type { HerdrEnsureLocalOptions, HerdrEnsureResult, HerdrDetection } from "./ensureHerdr.ts";
export {
  callHerdrLiveHandoff,
  callHerdrSocket,
  buildLiveHandoffParams,
  deserializeLiveHandoffPayload,
  LIVE_HANDOFF_METHOD,
  LIVE_HANDOFF_PAYLOAD_VERSION,
  PAYLOAD_MAX_DIFF_CHARS,
  PAYLOAD_MAX_SUMMARY_CHARS,
  probeLiveHandoffCapability,
  serializeLiveHandoffPayload,
  validateLiveHandoffParams,
} from "./liveHandoff.ts";
export type {
  HerdrSocketOptions,
  LiveHandoffCapability,
  LiveHandoffParams,
  LiveHandoffPayload,
} from "./liveHandoff.ts";
export {
  InspectorFeed,
  INSPECTOR_LIMITS,
  attachInspectorFeed,
  attachInspectorFeedFromHost,
  inspectorConfigFromHost,
  isSensitivePath,
  isTestCommand,
  parseTestOutput,
} from "./InspectorFeed.ts";
export type {
  InspectorAssociation,
  InspectorEvent,
  InspectorFeedHandle,
  InspectorFeedOptions,
  InspectorSink,
  ReasoningMode,
} from "./InspectorFeed.ts";
export { LineageEmitter, createLineageEmitter, lineageNodeId } from "./lineage.ts";
export { createLineageFromHostConfig, lineageEnabledByConfig, loadLineageEmitter } from "./lineageConfig.ts";
export type { LineageSink, LineageEmitterOptions } from "./lineage.ts";
