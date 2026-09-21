/**
 * PayloadRecoveryManager — 413 diagnostics + boundary classification + safe
 * retry (spec: pi-engineering-vision-payload-management, §§21-22).
 *
 * Pure deterministic logic. `recover` only computes a reduced payload and a
 * diagnostic; it never actually transmits anything.
 */

import { type RequestBudgetManager, estimatePayloadBytes } from "./budget.ts";
import type { PayloadBreakdown } from "./budget.ts";

export type PayloadBoundary =
  | "browser_to_piweb"
  | "piweb_to_daemon"
  | "reverse_proxy"
  | "pi_to_inferweave"
  | "inferweave_to_model_runtime"
  | "provider_api"
  | "unknown";

export interface PayloadDiagnostic {
  type: "MODEL_REQUEST_TOO_LARGE";
  httpStatus: number;
  requestBytesEstimated: number;
  activeImages: number;
  encodedImageBytes: number;
  tokenEstimate: number;
  provider: string;
  endpoint: string;
  recoveryAction: string;
  retrySucceeded: boolean;
}

export interface DiagnosticInput {
  httpStatus: number;
  requestBytesEstimated: number;
  activeImages: number;
  encodedImageBytes: number;
  tokenEstimate: number;
  provider: string;
  endpoint: string;
  recoveryAction: string;
  retrySucceeded: boolean;
}

/**
 * Deterministic heuristic for classifying which boundary produced a 413
 * (spec §22). Never includes header values in the output.
 */
export function classifyBoundary(
  httpStatus: number,
  endpointHint?: string,
  _responseHeaders?: Record<string, string>,
): PayloadBoundary {
  if (httpStatus !== 413 && !endpointHint) {
    return "unknown";
  }
  const hint = endpointHint?.toLowerCase() ?? "";
  if (hint.includes("inferweave")) {
    if (hint.includes("/runtime") || hint.includes("model") || hint.includes("generate")) {
      return "inferweave_to_model_runtime";
    }
    return "pi_to_inferweave";
  }
  if (hint.includes("proxy") || hint.includes("nginx") || hint.includes("caddy") || hint.includes("traefik")) {
    return "reverse_proxy";
  }
  if (hint.includes("pi-web") || hint.includes("upload")) {
    return "browser_to_piweb";
  }
  return "unknown";
}

/** Build a PayloadDiagnostic of type MODEL_REQUEST_TOO_LARGE (spec §21). */
export function buildDiagnostic(input: DiagnosticInput): PayloadDiagnostic {
  return { type: "MODEL_REQUEST_TOO_LARGE", ...input };
}

export interface RecoveryInput {
  httpStatus: number;
  activeImages: number;
  encodedImageBytes: number;
  tokenEstimate: number;
  provider: string;
  endpoint: string;
  recoveryAction: string;
}

export interface RecoveryResult {
  retryPayload: Partial<PayloadBreakdown>;
  diagnostic: PayloadDiagnostic;
  retried: boolean;
  retrySucceeded: boolean;
}

/** Fixed text allowance used to replace dropped raw visual assets. */
export const DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES = 16_384;

/**
 * Recovery manager for MODEL_REQUEST_TOO_LARGE. Reduces a payload breakdown by
 * dropping raw visual assets in favor of DesignObservation text (reduction
 * order steps 1/2), re-runs the budget preflight, and retries ONCE when the
 * reduced payload is allowed. Never retries endlessly.
 */
export class PayloadRecoveryManager {
  private readonly budget: RequestBudgetManager;
  private readonly maxRetries: number;

  constructor(budget: RequestBudgetManager, opts?: { maxRetries?: number }) {
    this.budget = budget;
    this.maxRetries = opts?.maxRetries ?? 1;
  }

  async recover(breakdown: Partial<PayloadBreakdown>, input: RecoveryInput): Promise<RecoveryResult> {
    const preflight = this.budget.preflight(breakdown);
    // Step 1/2: drop raw visual assets (encodedImageBytes -> 0) and replace with
    // a small DesignObservation text allowance.
    const retryPayload: Partial<PayloadBreakdown> = {
      ...breakdown,
      encodedImageBytes: 0,
      textBytes: (breakdown.textBytes ?? 0) + DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES,
      totalEstimatedBytes: estimatePayloadBytes({
        ...breakdown,
        encodedImageBytes: 0,
        textBytes: (breakdown.textBytes ?? 0) + DESIGN_OBSERVATION_TEXT_ALLOWANCE_BYTES,
      }),
    };

    let retried = false;
    let retrySucceeded = false;
    if (!preflight.allowed && this.maxRetries > 0) {
      retried = true;
      const reduced = this.budget.preflight(retryPayload);
      retrySucceeded = reduced.allowed;
    }

    const diagnostic = buildDiagnostic({
      httpStatus: input.httpStatus,
      requestBytesEstimated: preflight.estimatedBytes,
      activeImages: input.activeImages,
      encodedImageBytes: input.encodedImageBytes,
      tokenEstimate: input.tokenEstimate,
      provider: input.provider,
      endpoint: input.endpoint,
      recoveryAction: input.recoveryAction,
      retrySucceeded,
    });

    return { retryPayload, diagnostic, retried, retrySucceeded };
  }
}
