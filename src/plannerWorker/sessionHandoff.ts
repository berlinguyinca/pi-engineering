/**
 * Session model-switch handoff (spec Unit C1, issue #350).
 *
 * When an interactive session switches to a model whose context window cannot
 * hold the current context, the PREFERRED transfer is a bounded
 * `HandoffArtifact` — the session's own state (latest user ask + latest
 * assistant work state) built by B2's `runHandoff` and driven to `committed`.
 * `ctx.compact()` (`selective_compaction`) stays reachable as the fallback
 * for when no handoff can be built or the handoff fits nowhere.
 *
 * Pure decision core: the handler in `extension.ts` reads the pi session
 * (`ctx.sessionManager`) into plain `{role, text}` views and maps the
 * decision onto side effects (transition log, durable artifact, notify,
 * compact).
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { isBareContinuation } from "../orchestration/autoInvoke.ts";
import { planTransition } from "./compatibility.ts";
import { plannerWorkerDir } from "./config.ts";
import { type HandoffCommandResult, runHandoff } from "./handoffCommand.ts";
import { profileOf } from "./sessionSwitch.ts";
import type { HandoffArtifact, MissionBrief, TaskContract } from "./types.ts";

export interface SessionHandoffMessage {
  role: string;
  text: string;
}

export interface SessionSwitchInput {
  /** The model being switched to. */
  next: { id: string; provider?: string; contextWindow?: number; input?: string[] };
  /** Current context size in tokens (null when unknown). */
  contextTokens: number | null;
  /** Pi session id — becomes the handoff's mission id. */
  sessionId: string;
  /** Session branch in transcript order (role + extracted text). */
  messages: SessionHandoffMessage[];
}

export type SessionSwitchDecision =
  | { action: "direct" }
  | {
      action: "handoff";
      artifact: HandoffArtifact;
      rendered: string;
      tokenEstimate: number;
      reason: string;
    }
  | { action: "compact"; reason: string }
  | { action: "reject"; reasons: string[] };

/**
 * Decide how a live session crosses a model switch (Unit C1).
 *
 * Order: (1) context fits directly → nothing to do; (2) build a bounded
 * session handoff and let `planTransition` with `preferHandoff` place it;
 * (3) fallback to the legacy plan (compact when the window allows, else
 * reject). The handoff path never calls compaction.
 */
export function decideSessionSwitch(input: SessionSwitchInput): SessionSwitchDecision {
  const contextTokens = input.contextTokens ?? 0;
  const directPlan = planTransition(profileOf(input.next), {
    contextTokens,
    canCompact: true,
  });
  if (directPlan.outcome === "switch" && directPlan.context === "direct") return { action: "direct" };

  const handoff = buildSessionHandoff({ sessionId: input.sessionId, messages: input.messages });
  if (handoff.ok) {
    const handoffPlan = planTransition(
      profileOf(input.next),
      {
        contextTokens,
        handoffTokens: handoff.tokenEstimate,
        preferHandoff: true,
        canCompact: true,
      },
      [],
    );
    if (handoffPlan.outcome !== "reject") {
      return {
        action: "handoff",
        artifact: handoff.artifact,
        rendered: handoff.rendered,
        tokenEstimate: handoff.tokenEstimate,
        reason:
          directPlan.outcome === "compact"
            ? `handoff fits ${input.next.id}; context (${contextTokens} tokens) does not`
            : `handoff carries the session to ${input.next.id}`,
      };
    }
  }

  if (directPlan.outcome === "compact") {
    return {
      action: "compact",
      reason: `${contextTokens} tokens do not fit ${input.next.id} (${input.next.contextWindow})`,
    };
  }
  return {
    action: "reject",
    reasons: directPlan.outcome === "reject" ? directPlan.reasons : ["no handoff, compaction or direct fit"],
  };
}

export type SessionHandoffResult =
  | { ok: true; artifact: HandoffArtifact; rendered: string; state: "committed"; tokenEstimate: number }
  | { ok: false; error: string };

/**
 * Build a bounded `HandoffArtifact` for a live session (Unit C1). Reuses B2's
 * `runHandoff`: the latest substantive user request as the mission
 * summary/objective, the latest assistant text as architectural context.
 * Returns `{ok:false}` when there is nothing to hand off (no user message)
 * or the artifact cannot reach `committed`.
 */
export function buildSessionHandoff(input: {
  sessionId: string;
  messages: SessionHandoffMessage[];
}): SessionHandoffResult {
  const last = (role: string): SessionHandoffMessage | undefined =>
    [...input.messages].reverse().find((m) => m.role === role && m.text.trim() !== "");
  const lastUser =
    [...input.messages]
      .reverse()
      .find((m) => m.role === "user" && m.text.trim() && !isBareContinuation(m.text.trim())) ?? last("user");
  if (!lastUser) return { ok: false, error: "no user message to hand off" };
  const lastAssistant = last("assistant");
  // Bound the session text that enters the artifact. `summary` is already
  // clipped by `buildHandoff` downstream, but `architectural_context` and
  // `objective` are NOT, so a very long single user/assistant message would
  // otherwise flow into the artifact unbounded. Cap those two here at the same
  // 1500-char bound the summary uses.
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
  const MAX_SESSION_TEXT = 1_500;

  const brief: MissionBrief = {
    mission_id: `session:${input.sessionId}`,
    summary: lastUser.text,
    architectural_context: lastAssistant ? [clip(lastAssistant.text, MAX_SESSION_TEXT)] : [],
    acceptance_criteria: [],
    constraints: [],
  };
  const contract: TaskContract = {
    task_id: "session",
    objective: clip(lastUser.text, MAX_SESSION_TEXT),
    depends_on: [],
    scope: { allowed: [], forbidden: [] },
    acceptance: [],
    verification: [],
    constraints: [],
    risk: "low",
    relevant_files: [],
    decisions: [],
  };
  const result: HandoffCommandResult = runHandoff({
    // planner-worker artifact kind (B2's vocabulary): the session's planning
    // context crosses to the implementer continuing the work.
    kind: "planner_to_worker",
    brief,
    // buildHandoff merges brief + plan architectural context; the session's
    // state lives in the brief only (no planner decisions exist here).
    plan: { decisions: [], architectural_context: [] },
    contract,
    from: "planner",
    to: "implementer",
  });
  if (result.state !== "committed" || !result.artifact) {
    return { ok: false, error: result.error ?? "handoff did not reach committed" };
  }
  return {
    ok: true,
    artifact: result.artifact,
    rendered: result.rendered ?? "",
    state: "committed",
    tokenEstimate: result.artifact.token_estimate,
  };
}

/**
 * Read the session branch into plain `{role, text}` views (only user/assistant
 * messages carry handoff content). Structural by design: `getBranch()` is the
 * pi session-manager shape, and the pure functions above never see pi types.
 */
export function sessionBranchMessages(sessionManager: {
  getBranch(): Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
}): SessionHandoffMessage[] {
  const out: SessionHandoffMessage[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, text: messageText(entry.message.content) });
  }
  return out;
}

/** Extract human text from a message content (string or content-block array). */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Durable branch-local projection boundary; custom entries never enter model context. */
export const SESSION_HANDOFF_ENTRY = "engineering-session-handoff";

/**
 * Project a bounded handoff into Pi's native per-request context hook. Read the
 * current branch on every call so reload, fork and session replacement never
 * reuse a captured context. The transcript stays available for inspection.
 * Later native compaction supersedes the projection with its own summary.
 */
export function projectSessionHandoff(messages: AgentMessage[], branch: SessionEntry[]): AgentMessage[] | undefined {
  let boundary = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY) boundary = i;
  }
  if (boundary < 0 || branch.slice(boundary + 1).some((entry) => entry.type === "compaction")) return;
  const marker = branch[boundary];
  const data = marker?.type === "custom" ? (marker.data as { rendered?: unknown } | undefined) : undefined;
  if (typeof data?.rendered !== "string" || !data.rendered) return;
  const fingerprint = (message: unknown) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
  const oldMessages = new Map<string, number>();
  // Resolve edits against the complete branch before selecting hidden entries:
  // an edit appended after the marker may replace a pre-marker message.
  const hiddenIds = new Set(branch.slice(0, boundary).map((entry) => entry.id));
  const hiddenMessages = buildSessionProjection(branch)
    .entries.filter((entry) => hiddenIds.has(entry.sourceEntry.id))
    .flatMap((entry) => entry.messages);
  for (const message of hiddenMessages) {
    const key = fingerprint(message);
    oldMessages.set(key, (oldMessages.get(key) ?? 0) + 1);
  }
  const remaining = messages.filter((message) => {
    const key = fingerprint(message);
    const count = oldMessages.get(key) ?? 0;
    if (count === 0) return true;
    oldMessages.set(key, count - 1);
    return false;
  });
  return [
    { role: "user", content: `Session handoff (earlier transcript retained on disk):\n${data.rendered}`, timestamp: 0 },
    ...remaining,
  ];
}

/** Pre-switch usage cannot justify threshold compaction of the new projection. */
export function staleHandoffThreshold(reason: string | undefined, branch: SessionEntry[]): boolean {
  if (reason !== "threshold") return false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "compaction" || (entry?.type === "message" && entry.message.role === "assistant")) return false;
    if (entry?.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY) return true;
  }
  return false;
}

/** Canonical native-compaction input containing no hidden transcript prefix. */
export function sessionHandoffCompactionBranch(
  branch: SessionEntry[],
): { entries: SessionEntry[]; markerId: string; summary: string } | undefined {
  let boundary = -1;
  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry?.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY) boundary = i;
  }
  const marker = branch[boundary];
  if (marker?.type !== "custom" || branch.slice(boundary + 1).some((entry) => entry.type === "compaction")) return;
  const rendered = (marker.data as { rendered?: unknown } | undefined)?.rendered;
  if (typeof rendered !== "string" || !rendered) return;
  // Native preparation recognizes previousSummary and chooses cuts only in the
  // successor suffix. Reuse the REAL marker id so every returned cutoff is a
  // valid persisted boundary, never an invented session entry.
  return {
    markerId: marker.id,
    summary: rendered,
    entries: [
      {
        type: "compaction",
        id: marker.id,
        parentId: null,
        timestamp: marker.timestamp,
        summary: rendered,
        firstKeptEntryId: marker.id,
        tokensBefore: 0,
      },
      ...branch.slice(boundary + 1),
    ],
  };
}

/**
 * The side-effect surface a model-switch decision needs. `extension.ts`
 * satisfies it with the pi event context; tests satisfy it with counters.
 */
export interface SessionSwitchEffects {
  /** Record the MODEL_TRANSITION entry with the context-crossing mode. */
  recordContext(context: "handoff" | "compact" | "direct", reason: string): void;
  /** Persist the committed handoff artifact (handoff path only). */
  persist(decision: Extract<SessionSwitchDecision, { action: "handoff" }>): Promise<void>;
  /** Install the durable context boundary before reporting a handoff. */
  transfer(decision: Extract<SessionSwitchDecision, { action: "handoff" }>): void;
  notify(message: string, level: "info" | "error"): void;
  /** Native compaction — the fallback only; NEVER on the handoff path. */
  compact(options: { customInstructions: string }): void;
}

/**
 * Map a `SessionSwitchDecision` onto its side effects (Unit C1). The handoff
 * path emits exactly one transition entry (`context: "handoff"`) and persists
 * the artifact, with ZERO `compact()` calls; the compact path is the
 * last-resort fallback.
 */
export async function applySessionSwitchDecision(
  decision: SessionSwitchDecision,
  nextId: string,
  effects: SessionSwitchEffects,
): Promise<void> {
  if (decision.action === "handoff") {
    effects.transfer(decision);
    effects.recordContext("handoff", decision.reason);
    await effects.persist(decision);
    effects.notify(`switching to ${nextId} via handoff (${decision.tokenEstimate} tokens); no compaction`, "info");
    return;
  }
  if (decision.action === "compact") {
    effects.recordContext("compact", decision.reason);
    effects.notify(`${nextId} holds the session only after compaction`, "info");
    effects.compact({ customInstructions: "Preserve task state, decisions, and open files; compress the rest." });
    return;
  }
  if (decision.action === "reject") {
    effects.recordContext("direct", decision.reasons.join("; "));
    effects.notify(`switch to ${nextId} cannot hold this session: ${decision.reasons.join("; ")}`, "error");
    return;
  }
  effects.recordContext("direct", "fits");
}

/**
 * Persist a committed session handoff durably (`.pi-eng/planner-worker/
 * session-handoffs.jsonl`) so a successor — including D1's `server.live_handoff`
 * payload — can resume from it. Best-effort: a persistence failure must never
 * block the model switch.
 */
export async function persistSessionHandoff(
  repoRoot: string,
  decision: Extract<SessionSwitchDecision, { action: "handoff" }>,
): Promise<void> {
  const dir = plannerWorkerDir(repoRoot);
  const entry = {
    at: new Date().toISOString(),
    session: decision.artifact.mission_id,
    token_estimate: decision.tokenEstimate,
    artifact: decision.artifact,
  };
  // Both the directory creation AND the append are best-effort: a persistence
  // failure (read-only checkout, permission, disk) must never block the model
  // switch, which is the documented contract above. Guarded together so an
  // unwritable planner-worker dir cannot reject out of the model_select handler.
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "session-handoffs.jsonl"), `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort by design — the in-session handoff still succeeds.
  }
}
