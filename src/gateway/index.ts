/**
 * Model-gateway backpressure: parse the wait a gateway reports, and hold every
 * model caller in this process behind one gate until it expires.
 */

export { AdmissionController } from "./AdmissionController.ts";
export type {
  AdmissionControllerOptions,
  AdmissionEvent,
  AdmissionSlot,
  AdmissionStatus,
} from "./AdmissionController.ts";
export {
  DEFAULT_GATEWAY_CONFIG,
  emitAdmissionTelemetry,
  resolveGatewayConfig,
  setSharedAdmissionController,
  sharedAdmissionController,
  sharedGatewayConfig,
} from "./config.ts";
export type { GatewayAdmissionConfig } from "./config.ts";
export {
  DEFAULT_WAIT_MS,
  decideGatewayRetry,
  describeGatewayWait,
  parseGatewayWait,
  parseRetryAfterHeader,
} from "./signals.ts";
export type { GatewayRetryDecision, GatewayWaitInput, GatewayWaitSignal } from "./signals.ts";
