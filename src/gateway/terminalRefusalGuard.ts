import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseAdmissionPayload } from "../inference/admissionContract.ts";

const TERMINAL_ACTIONS = new Set([
  "do_not_retry",
  "fix_request",
  "authenticate",
  "request_access",
  "resolve_conflict",
  "reduce_input",
]);
const TERMINAL_CODES = new Set([
  "IW-ACT-DO-NOT-RETRY",
  "IW-ACT-FIX-REQUEST",
  "IW-ACT-AUTHENTICATE",
  "IW-ACT-REQUEST-ACCESS",
  "IW-ACT-RESOLVE-CONFLICT",
  "IW-ACT-REDUCE-INPUT",
]);

/** Only explicit, structurally recognized gateway guidance can stop the host's retry loop. */
export function isTerminalGatewayRefusal(text: string): boolean {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  const info = parseAdmissionPayload(text.slice(start, end + 1));
  if (!info?.explicitReplayContract) return false;
  return (
    info.retryable === false ||
    info.replaySafe === false ||
    (info.action !== undefined && TERMINAL_ACTIONS.has(info.action)) ||
    (info.actionCode !== undefined && TERMINAL_CODES.has(info.actionCode)) ||
    info.requestState === "dispatched" ||
    info.requestState === "streaming" ||
    info.requestState === "unknown"
  );
}

const handled = new WeakSet<object>();

/**
 * Pi's outer retry classifier treats a 503 as transient, including an explicit
 * do_not_retry response that our provider wrapper correctly lets through.
 * The public abort API synchronously marks this run cancelled before Pi makes
 * that retry decision. Do not await it here: abort waits for the run to settle,
 * and the run is waiting for this message_end handler to return.
 * Preserve the original assistant message, including its error stop reason.
 */
export function registerTerminalRefusalGuard(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (
      message.role !== "assistant" ||
      message.stopReason !== "error" ||
      !message.errorMessage ||
      handled.has(message) ||
      !isTerminalGatewayRefusal(message.errorMessage)
    )
      return;
    handled.add(message);
    void ctx.abort();
  });
}
