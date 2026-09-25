/**
 * The request-body guard for the worker's ModelRuntime.
 *
 * A fresh-context worker's agent loop calls `modelRuntime.streamSimple` (the
 * SDK's `streamFn`, pi-coding-agent core/sdk.js), so wrapping that one method
 * on the worker's own runtime covers every provider call a worker makes. The
 * interactive session is covered by the gateway stream-retry wrapper instead
 * (installGatewayStreamRetry); both share src/request/bodyBudget.ts.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { terminalAssistantMessage } from "../inference/admissionTransport.ts";
import { type RequestBodyBudgetConfig, streamWithinRequestBudget } from "../request/bodyBudget.ts";

const GUARDED = Symbol.for("pi-engineering.requestBodyGuard");

type StreamSimple = ModelRuntime["streamSimple"];

/** Wrap `runtime.streamSimple` in place. Idempotent. */
export function guardRuntimeRequestBody(runtime: ModelRuntime, config: RequestBodyBudgetConfig): void {
  const target = runtime as ModelRuntime & { [GUARDED]?: boolean };
  if (target[GUARDED]) return;
  const base = runtime.streamSimple.bind(runtime);
  const guarded = streamWithinRequestBudget(base as never, {
    config,
    errorResult: (model, error) => terminalAssistantMessage(model as never, error.message, "error"),
  });
  target.streamSimple = guarded as unknown as StreamSimple;
  target[GUARDED] = true;
}
