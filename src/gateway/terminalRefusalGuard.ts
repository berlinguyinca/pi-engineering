import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isTerminalReplayContract } from "../inference/admissionContract.ts";

/**
 * Only explicit, structurally recognized gateway guidance can stop the host's
 * retry loop. Delegates to the shared terminal-contract predicate so the host
 * guard, the unified classifier, and the transient layer agree on what is
 * terminal.
 */
export function isTerminalGatewayRefusal(text: string): boolean {
  return isTerminalReplayContract(text);
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
