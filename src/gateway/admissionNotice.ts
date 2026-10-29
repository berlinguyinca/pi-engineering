/**
 * Admission events, phrased for a person.
 *
 * The events were reported as `[gateway-admission] {"type":"wait","waitMs":…}`
 * — every field the controller had, in JSON, on a terminal. It is unreadable at
 * a glance, it is most of a screen wide, and the one number the operator
 * actually wants ("how long am I stuck for?") is in the middle of it.
 *
 * What a waiting operator needs is the duration, the reason, and how loaded the
 * queue is. Everything else stays in `detail` for a sink that records rather
 * than shows.
 */

import { stripVTControlCharacters } from "node:util";
import { redactSecrets } from "../platform/redact.ts";
import type { TelemetryNotice } from "../telemetry/sink.ts";
import type { AdmissionEvent } from "./AdmissionController.ts";
import { type GatewayWaitSignal, isNodeUpdating } from "./signals.ts";

/** "30s", "2m 05s", "450ms" — the shortest form that is still exact enough. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * How long an outage has lasted, at a glance: "42s", "5m 07s", "2h 03m". An
 * outage can run for hours, and "waiting 60s" alone reads as a stuck loop.
 */
export function formatWaitingFor(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * What the gateway says while the only node serving the model restarts for a
 * deployment (`node_updating`). Used as is when the refusal reached us
 * flattened to its bare code, with no message left to show.
 */
export const NODE_UPDATING_NOTICE = "updating node, please retry in 30 s";

/** Longest gateway message a one-line notice shows. */
const NOTICE_MESSAGE_MAX_CHARS = 160;

/**
 * Gateway-supplied text made safe for a one-line notice: terminal escapes and
 * control characters removed, secrets redacted (the same steps as the worker
 * output preview, safeWorkerOutputPreview), whitespace collapsed, and cut to
 * its head, where the sentence is. Not safeWorkerOutputPreview itself: that
 * module's import graph would pull worker tools (and `typebox`) into the
 * session-auto-resume launcher, which copies this file's imports.
 */
function gatewayText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const plain = [...stripVTControlCharacters(value.slice(0, 4 * NOTICE_MESSAGE_MAX_CHARS))]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? " " : ch;
    })
    .join("")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  const clean = redactSecrets(plain).replace(/\s+/g, " ").trim();
  return clean.slice(0, NOTICE_MESSAGE_MAX_CHARS) || undefined;
}

/**
 * "queue timeout" from "queue_timeout"; the gateway's own words, made readable.
 * `node_updating` reads as the console's sentence instead of the code.
 */
export function waitReasonText(signal: GatewayWaitSignal): string {
  if (isNodeUpdating(signal)) return gatewayText(signal.message) ?? NODE_UPDATING_NOTICE;
  const raw = signal.reason ?? signal.type ?? (signal.status ? `HTTP ${signal.status}` : "");
  return raw.replaceAll("_", " ");
}

/** "31 of 100 queued · 4 admitted", omitting whatever the gateway did not report. */
function loadText(signal: GatewayWaitSignal): string {
  const parts: string[] = [];
  if (signal.queued !== undefined) {
    parts.push(
      signal.queueLimit !== undefined ? `${signal.queued} of ${signal.queueLimit} queued` : `${signal.queued} queued`,
    );
  }
  if (signal.activeLimit !== undefined) parts.push(`${signal.activeLimit} admitted`);
  return parts.join(" · ");
}

/** A transient link failure is not evidence that the inference queue is full. */
export function gatewayWaitLabel(signal: GatewayWaitSignal): string {
  const reason = `${signal.reason ?? ""} ${signal.type ?? ""}`;
  if (
    signal.source === "transport-drop" ||
    signal.source === "link-cut" ||
    /transport|network|connection|link.cut/i.test(reason)
  ) {
    return "Gateway transport interruption";
  }
  if (signal.queued !== undefined || /queue|capacity|admission|concurrency|busy|saturat/i.test(reason)) {
    return "Gateway capacity wait";
  }
  return "Gateway retry wait";
}

/**
 * Turn an admission event into one line.
 *
 * A wait is a WARNING: work is not progressing and the operator is entitled to
 * know why their session went quiet. A clamp is a warning for the same reason —
 * the session just got slower. A relax is INFO: it is good news, and good news
 * does not need to look like a problem.
 */
export function describeAdmissionEvent(event: AdmissionEvent, now: () => number = Date.now): TelemetryNotice {
  if (event.type === "wait") {
    const reason = waitReasonText(event.signal);
    const load = loadText(event.signal);
    const since = event.signal.waitingSinceMs;
    const lasted = since !== undefined ? `waiting for ${formatWaitingFor(now() - since)}` : "";
    // Which model an outage is about: one model reloading is not the gateway down.
    const tail = [reason, event.signal.model, load, lasted].filter(Boolean).join(" · ");
    return {
      level: "warning",
      // Keyed on the CONDITION, not the sentence: the queue depth moves between
      // waits, so two waits for the same reason are different strings and a
      // text-keyed throttle would never fire.
      key: `wait:${event.signal.reason ?? event.signal.type ?? event.signal.status ?? "unknown"}`,
      text: `${gatewayWaitLabel(event.signal)} — waiting ${formatDuration(event.waitMs)}${tail ? ` · ${tail}` : ""}`,
      detail: event,
    };
  }
  if (event.type === "clamp") {
    const reason = waitReasonText(event.signal);
    return {
      level: "warning",
      key: `clamp:${event.signal.reason ?? event.signal.type ?? event.signal.status ?? "unknown"}`,
      text: `gateway busy — concurrency ${event.previous} → ${event.concurrency}${reason ? ` · ${reason}` : ""}`,
      detail: event,
    };
  }
  return {
    level: "info",
    key: "relax",
    text: `gateway recovered — concurrency ${event.previous} → ${event.concurrency}`,
    detail: event,
  };
}
