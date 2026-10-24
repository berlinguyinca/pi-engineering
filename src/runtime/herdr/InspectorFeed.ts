/**
 * InspectorFeed — bounded, off-by-default Pi -> Herdr "agent inspector" feed.
 *
 * Projects what Pi actually delivers (messages, tool executions, edit diffs,
 * usage, model switches, test runs, lifecycle, optional reasoning) onto the
 * `inspector` entity of the existing control-plane ingest endpoint, through the
 * existing {@link ControlPlaneIngest} client. Wire contract (authoritative):
 * herdr-engineering `docs/contracts/agent-inspector-event.md`.
 *
 * Hard invariants:
 *  - OFF BY DEFAULT: nothing is subscribed or sent unless this host has a
 *    central fleet config (host.json) whose values set `inspector.enabled` to
 *    true (see {@link attachInspectorFeedFromHost}). No environment variable
 *    enables it.
 *  - NEVER THROWS INTO PI and never awaits the network in a handler: every
 *    handler is wrapped, sends are fire-and-forget on an unref'd timer.
 *  - BOUNDED: hard queue cap (default 500), droppable `update` events are
 *    evicted first and coalesced per call id, tool `end` / lifecycle /
 *    capabilities are never evicted for lower-priority events. Bodies are
 *    truncated (tool chunk 4KB, tool output 16KB head+tail, diff 64KB,
 *    message 16KB).
 *  - ONE request in flight, exponential backoff after a failure; a failed
 *    batch is dropped (no retry storms) and counted, and the count is reported
 *    as `dropped` on the next lifecycle event.
 *  - REASONING IS CAPABILITY-DEPENDENT, never synthesised: `reasoning` events
 *    are sent only if thinking text was really received AND the central
 *    config sets `inspector.reasoning` to `summary`/`full` (default `off`).
 *  - The server redacts; the client only truncates and adds a `sensitive` hint.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { contextReading } from "../../context/usage.ts";
import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { type HostConfig, type LoadHostConfigOptions, loadHostConfig } from "./HostConfig.ts";
import { reportRuntimeFacts } from "./runtimeReport.ts";

// ── limits ───────────────────────────────────────────────────────────────────

export const INSPECTOR_LIMITS = {
  queueCap: 500,
  flushMs: 250,
  flushAt: 50,
  maxBatch: 100,
  toolChunk: 4 * 1024,
  toolOutput: 16 * 1024,
  diff: 64 * 1024,
  message: 16 * 1024,
  argsPreview: 512,
  maxFailures: 20,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
} as const;

export type ReasoningMode = "off" | "summary" | "full";
export type ReasoningCapability = "none" | "summary" | "full";

export interface InspectorEvent {
  kind: string;
  agent_id?: string;
  parent_agent_id?: string;
  sensitive?: boolean;
  ts?: string;
  event_id?: string;
  [k: string]: unknown;
}

/** The slice of {@link ControlPlaneIngest} the feed needs (fakeable in tests). */
export interface InspectorSink {
  emitBatch(entityId: string, events: InspectorEvent[]): Promise<boolean>;
}

export interface InspectorAssociation {
  mission_id?: string;
  handoff_id?: string;
  handoff_from?: string;
  parent_session_id?: string;
  worktree?: string;
  branch?: string;
  pr?: { number?: number; url?: string; repo?: string };
}

export interface InspectorFeedOptions {
  ingest: InspectorSink;
  /** Reasoning forwarding. Default "off": reasoning is never sent. */
  reasoning?: ReasoningMode;
  /** Entity id; default HERDR_PANE_ID (== the `session` entity id), else Pi's session id. */
  sessionId?: string;
  env?: NodeJS.ProcessEnv;
  queueCap?: number;
  flushMs?: number;
  /** Why a model_select happened, when it is not a user switch (e.g. an automatic fallback). */
  modelReason?: () => "handoff" | "fallback" | undefined;
  /** Resolves worktree/branch for the association event (default: src/git GitRepo). */
  resolveGit?: (cwd: string) => Promise<{ branch?: string } | undefined>;
  now?: () => number;
}

export interface InspectorFeedHandle {
  readonly feed: InspectorFeed;
  /** Report mission / handoff / PR linkage (association event). */
  associate(a: InspectorAssociation): void;
  /** Flush now (fire-and-forget). */
  flush(): void;
  /** Unsubscribe and stop timers. */
  dispose(): void;
}

// ── truncation helpers ───────────────────────────────────────────────────────

/** Head+tail truncation with a marker. Returns the original string when it fits. */
export function headTail(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor((max - 32) / 2);
  const dropped = text.length - half * 2;
  return { text: `${text.slice(0, half)}\n…[${dropped} chars truncated]…\n${text.slice(-half)}`, truncated: true };
}

function tail(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: text.slice(-max), truncated: true };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content ?? value;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
      const t = (part as { text?: unknown }).text;
      if (typeof t === "string") out += out ? `\n${t}` : t;
    }
  }
  return out;
}

const SENSITIVE_PATH =
  /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials|\.git-credentials)$|\.(pem|key|p12|pfx|jks|keystore)$|[\\/]\.(ssh|aws|gnupg)[\\/]|(^|[\\/])secrets?\.(json|ya?ml|toml)$/i;

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH.test(path);
}

// ── test-runner recognition (conservative) ───────────────────────────────────

const TEST_COMMAND =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)\b|(npx\s+)?(vitest|jest|mocha|pytest|phpunit|rspec)\b|node\s+(\S+\s+)*--test\b|cargo\s+(\S+\s+)*test\b|go\s+test\b|python3?\s+-m\s+(pytest|unittest)\b)/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

export interface ParsedTestRun {
  passed?: number;
  failed?: number;
  skipped?: number;
  failures?: Array<{ name: string }>;
}

function num(m: RegExpMatchArray | null, i = 1): number | undefined {
  const v = m?.[i];
  return v === undefined ? undefined : Number(v);
}

/**
 * Parse pass/fail counts and failing test names from a runner's output.
 * Recognises node:test, jest, vitest, pytest and cargo summaries. Anything
 * else returns `{}`: counts are NEVER guessed.
 */
export function parseTestOutput(output: string): ParsedTestRun {
  const text = output.length > 256 * 1024 ? output.slice(-256 * 1024) : output;
  const result: ParsedTestRun = {};
  const failures = new Set<string>();

  // node:test summary (spec / tap reporters): "ℹ pass 12", "ℹ fail 1", "ℹ skipped 0".
  const nodePass = text.match(/^\s*(?:ℹ|#)\s+pass\s+(\d+)\s*$/m);
  const nodeFail = text.match(/^\s*(?:ℹ|#)\s+fail\s+(\d+)\s*$/m);
  if (nodePass && nodeFail) {
    result.passed = num(nodePass);
    result.failed = num(nodeFail);
    const skipped = num(text.match(/^\s*(?:ℹ|#)\s+skipped\s+(\d+)\s*$/m));
    if (skipped !== undefined) result.skipped = skipped;
    for (const m of text.matchAll(/^\s*✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/gm)) {
      const name = m[1]?.trim();
      if (name && !/^failing tests:?$/i.test(name)) failures.add(name);
    }
  } else {
    // jest: "Tests:       2 failed, 1 skipped, 8 passed, 11 total"; vitest: "Tests  2 failed | 8 passed (10)".
    const line = text.match(/^\s*Tests:?\s+(.*\d+\s+(?:passed|failed).*)$/m)?.[1];
    if (line && /\b(\d+)\s+(?:total|passed|failed)\b|\(\d+\)/.test(line)) {
      result.passed = num(line.match(/(\d+)\s+passed/)) ?? 0;
      result.failed = num(line.match(/(\d+)\s+failed/)) ?? 0;
      const skipped = num(line.match(/(\d+)\s+(?:skipped|todo)/));
      if (skipped !== undefined) result.skipped = skipped;
      for (const m of text.matchAll(/^\s*(?:●|×|✕|FAIL)\s+(.+?)\s*$/gm)) {
        const name = m[1]?.trim();
        if (name && !/^Test suite failed to run$/i.test(name)) failures.add(name);
      }
    } else {
      // pytest: "=== 2 failed, 8 passed, 1 skipped in 1.2s ===" (also "1 passed in 0.1s").
      const py = text.match(/^=+\s*(.*?\b(?:passed|failed|error|errors)\b.*?)\s+in\s+[\d.]+s.*=+\s*$/m)?.[1];
      if (py) {
        result.passed = num(py.match(/(\d+)\s+passed/)) ?? 0;
        result.failed = (num(py.match(/(\d+)\s+failed/)) ?? 0) + (num(py.match(/(\d+)\s+errors?/)) ?? 0);
        const skipped = num(py.match(/(\d+)\s+skipped/));
        if (skipped !== undefined) result.skipped = skipped;
        for (const m of text.matchAll(/^FAILED\s+(\S+)/gm)) if (m[1]) failures.add(m[1]);
      } else {
        // cargo: one "test result:" line per test binary; sum them.
        const cargo = [
          ...text.matchAll(/^test result: (?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored/gm),
        ];
        if (cargo.length > 0) {
          result.passed = cargo.reduce((n, m) => n + Number(m[1]), 0);
          result.failed = cargo.reduce((n, m) => n + Number(m[2]), 0);
          result.skipped = cargo.reduce((n, m) => n + Number(m[3]), 0);
          for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) if (m[1]) failures.add(m[1]);
        } else {
          // go test without a summary: only failing test names are certain.
          for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) if (m[1]) failures.add(m[1]);
        }
      }
    }
  }
  if (failures.size > 0) {
    result.failures = [...failures]
      .slice(0, INSPECTOR_LIMITS.maxFailures)
      .map((name) => ({ name: name.slice(0, 300) }));
  }
  return result;
}

// ── bounded queue + sender ───────────────────────────────────────────────────

/** 0 = droppable (updates), 1 = normal, 2 = critical (tool end, lifecycle, capabilities). */
type Priority = 0 | 1 | 2;
interface Entry {
  ev: InspectorEvent;
  p: Priority;
  /** Set while this entry is a coalescable tool `update`. */
  callId?: string;
}

/** Absolute ceiling for the queue as a multiple of the cap (critical events only can exceed the cap). */
const CRITICAL_CEILING = 2;

export class InspectorFeed {
  private queue: Entry[] = [];
  private readonly pendingUpdates = new Map<string, Entry>();
  private readonly cap: number;
  private readonly flushMs: number;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private failures = 0;
  private retryAt = 0;
  private disposed = false;
  private lastPhase = "started";
  /** Events dropped since the last lifecycle report. */
  dropped = 0;
  /** Lifetime counters (diagnostics, tests). */
  stats = { enqueued: 0, sent: 0, droppedTotal: 0, failedBatches: 0, requests: 0 };

  private readonly sink: InspectorSink;
  private readonly entityId: () => string | undefined;

  constructor(
    sink: InspectorSink,
    entityId: () => string | undefined,
    opts: { queueCap?: number; flushMs?: number; now?: () => number } = {},
  ) {
    this.sink = sink;
    this.entityId = entityId;
    this.cap = Math.max(10, opts.queueCap ?? INSPECTOR_LIMITS.queueCap);
    this.flushMs = Math.max(10, opts.flushMs ?? INSPECTOR_LIMITS.flushMs);
    this.now = opts.now ?? Date.now;
  }
  private readonly now: () => number;

  get size(): number {
    return this.queue.length;
  }

  /** Enqueue an event (never throws). Tool `update`s coalesce per call id into the latest tail. */
  push(ev: InspectorEvent, p: Priority = 1): void {
    if (this.disposed) return;
    try {
      if (ev.kind === "lifecycle" && typeof ev.phase === "string" && ev.phase !== "ended") this.lastPhase = ev.phase;
      this.stats.enqueued++;
      this.queue.push({ ev, p });
      if (this.queue.length > this.cap) this.evict();
      if (this.queue.length >= INSPECTOR_LIMITS.flushAt) this.schedule(0);
      else this.schedule(this.flushMs);
    } catch {
      // never throw into Pi
    }
  }

  /** Latest-tail coalescing for streaming tool output. One queue slot per call id. */
  pushUpdate(callId: string, build: () => InspectorEvent): void {
    if (this.disposed) return;
    try {
      const existing = this.pendingUpdates.get(callId);
      if (existing) {
        existing.ev = build();
        return;
      }
      const entry: Entry = { ev: build(), p: 0, callId };
      this.pendingUpdates.set(callId, entry);
      this.stats.enqueued++;
      this.queue.push(entry);
      if (this.queue.length > this.cap) this.evict();
      this.schedule(this.flushMs);
    } catch {
      // never throw into Pi
    }
  }

  /** Stop coalescing into a call's update slot (call before its `end`). */
  closeUpdates(callId: string): void {
    this.pendingUpdates.delete(callId);
  }

  private evict(): void {
    // One compaction pass drops ~10% headroom of the lowest-priority, oldest entries,
    // so a flood costs O(1) amortised per event rather than a scan each time.
    const over = this.queue.length - this.cap;
    let need = over + Math.ceil(this.cap / 10);
    for (const level of [0, 1] as const) {
      if (need <= 0) break;
      const next: Entry[] = [];
      for (const e of this.queue) {
        if (need > 0 && e.p === level) {
          need--;
          this.drop(e);
        } else next.push(e);
      }
      this.queue = next;
    }
    // Only critical events remain above the cap: allow a bounded overrun, then shed the oldest.
    const ceiling = this.cap * CRITICAL_CEILING;
    if (this.queue.length > ceiling) {
      const excess = this.queue.length - ceiling;
      for (const e of this.queue.splice(0, excess)) this.drop(e);
    }
  }

  private drop(e: Entry): void {
    this.dropped++;
    this.stats.droppedTotal++;
    if (e.callId) this.pendingUpdates.delete(e.callId);
  }

  private schedule(ms: number): void {
    if (this.timer || this.disposed || this.inFlight) return;
    const wait = Math.max(ms, this.retryAt - this.now(), 0);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  /** Send at most one batch (<= 100 events), fire-and-forget, one request in flight. */
  flush(): void {
    if (this.disposed || this.inFlight || this.queue.length === 0) return;
    const id = this.entityId();
    if (!id) {
      // No stable entity id yet: keep events (bounded) and try again shortly.
      this.schedule(this.flushMs);
      return;
    }
    if (this.now() < this.retryAt) {
      this.schedule(this.retryAt - this.now());
      return;
    }
    const taken = this.queue.splice(0, INSPECTOR_LIMITS.maxBatch);
    const batch: InspectorEvent[] = [];
    for (const e of taken) {
      if (e.callId) this.pendingUpdates.delete(e.callId);
      batch.push(e.ev);
    }
    if (this.dropped > 0) {
      // Report loss explicitly (the server surfaces `dropped`); the batch stays <= 100.
      if (batch.length >= INSPECTOR_LIMITS.maxBatch) this.queue.unshift({ ev: batch.pop() as InspectorEvent, p: 1 });
      batch.push({ kind: "lifecycle", phase: this.lastPhase, dropped: this.dropped });
      this.dropped = 0;
    }
    this.inFlight = true;
    this.stats.requests++;
    let sent: Promise<boolean>;
    try {
      sent = Promise.resolve(this.sink.emitBatch(id, batch));
    } catch {
      sent = Promise.resolve(false);
    }
    void sent
      .catch(() => false)
      .then((ok) => {
        this.inFlight = false;
        if (ok) {
          this.failures = 0;
          this.retryAt = 0;
          this.stats.sent += batch.length;
        } else {
          // Drop the batch (no retry storm), remember how much, back off.
          this.stats.failedBatches++;
          this.failures++;
          const lost = batch.filter((e) => !(e.kind === "lifecycle" && typeof e.dropped === "number")).length;
          const carried = batch.reduce(
            (n, e) => n + (e.kind === "lifecycle" && typeof e.dropped === "number" ? (e.dropped as number) : 0),
            0,
          );
          this.dropped += lost + carried;
          this.stats.droppedTotal += lost;
          const backoff = Math.min(
            INSPECTOR_LIMITS.backoffMaxMs,
            INSPECTOR_LIMITS.backoffBaseMs * 2 ** Math.min(this.failures - 1, 10),
          );
          this.retryAt = this.now() + backoff;
        }
        if (this.queue.length > 0 && !this.disposed)
          this.schedule(this.queue.length >= INSPECTOR_LIMITS.flushAt ? 0 : this.flushMs);
      });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.disposed = true;
    this.queue = [];
    this.pendingUpdates.clear();
  }
}

// ── Pi wiring ────────────────────────────────────────────────────────────────

/** Session ids seen by this process, to tell a reload (`restarted`) from a first start. */
const seenSessions = new Set<string>();

const FILE_TOOLS: Record<string, "read" | "write" | "edit"> = { read: "read", write: "write", edit: "edit" };

function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.path ?? o.file_path ?? o.filePath;
  return typeof p === "string" && p ? p : undefined;
}

function argsPreview(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > INSPECTOR_LIMITS.argsPreview ? `${s.slice(0, INSPECTOR_LIMITS.argsPreview)}…` : s;
  } catch {
    return undefined;
  }
}

function countDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    const c = line.charCodeAt(0);
    if (c === 43 && !line.startsWith("+++")) additions++;
    else if (c === 45 && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

interface CallState {
  tool: string;
  startedAt: number;
  sensitive: boolean;
  command?: string;
  path?: string;
  fileOp?: "read" | "write" | "edit";
}

/**
 * Subscribe the feed to Pi. Handlers are registered with `pi.on`; each is
 * wrapped so it can neither throw into Pi nor await anything.
 */
export function attachInspectorFeed(pi: ExtensionAPI, opts: InspectorFeedOptions): InspectorFeedHandle {
  const env = opts.env ?? process.env;
  const reasoningMode: ReasoningMode = opts.reasoning ?? "off";
  const now = opts.now ?? Date.now;
  let sessionId: string | undefined = opts.sessionId ?? (env.HERDR_PANE_ID?.trim() || undefined);
  const feed = new InspectorFeed(opts.ingest, () => sessionId, {
    queueCap: opts.queueCap,
    flushMs: opts.flushMs,
    now,
  });
  const offs: Array<() => void> = [];
  const calls = new Map<string, CallState>();
  let subCounter = 0;

  // Capability state: derived from what Pi really delivers, never assumed.
  let modelId: string | undefined;
  let modelApi: string | undefined;
  let modelProvider: string | undefined;
  let modelReasoningFlag = false;
  let observedReasoning: ReasoningCapability = "none";
  let capSent = "";
  // Reasoning text being collected for the current assistant message (only when enabled).
  let thinkingBuf = "";
  let thinkingSeen = false;

  const iso = () => new Date(now()).toISOString();
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch {
        // never throw into Pi
      }
    };
  const on = (event: string, handler: (event: any, ctx: any) => void): void => {
    const off = (pi.on as (e: string, h: unknown) => unknown)(event, guard(handler));
    if (typeof off === "function") offs.push(off as () => void);
  };

  const emitCapabilities = (): void => {
    const sig = `${modelId}|${observedReasoning}`;
    if (sig === capSent) return;
    capSent = sig;
    feed.push(
      {
        kind: "capabilities",
        ts: iso(),
        reasoning: observedReasoning,
        streaming_tools: true,
        diffs: true,
        usage: true,
        ...(modelId ? { model: modelId } : {}),
      },
      2,
    );
  };

  const setModel = (m: any): void => {
    if (!m) return;
    modelId = typeof m.id === "string" ? m.id : modelId;
    modelApi = typeof m.api === "string" ? m.api : undefined;
    modelProvider = typeof m.provider === "string" ? m.provider : undefined;
    modelReasoningFlag = m.reasoning === true;
    // A new model resets what we may claim: reasoning is "none" until text is observed.
    observedReasoning = "none";
  };

  const observeThinking = (): void => {
    if (thinkingSeen) return;
    thinkingSeen = true;
    // Responses-style APIs deliver provider summaries; other streams deliver raw thinking text.
    const next: ReasoningCapability = modelApi && /responses/i.test(modelApi) ? "summary" : "full";
    if (observedReasoning !== next) {
      observedReasoning = next;
      emitCapabilities();
    }
  };

  const usageFor = (message: any, ctx: any): InspectorEvent | undefined => {
    const u = message?.usage;
    if (!u || typeof u !== "object") return undefined;
    const ev: InspectorEvent = {
      kind: "usage",
      ts: iso(),
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read_tokens: u.cacheRead,
    };
    if (typeof u.reasoning === "number") ev.reasoning_tokens = u.reasoning;
    if (modelId) ev.model = modelId;
    try {
      const cu = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      if (cu && typeof cu.tokens === "number" && typeof cu.contextWindow === "number") {
        const r = contextReading(cu.tokens, cu.contextWindow);
        ev.context_tokens = r.usedTokens;
        ev.context_window = r.windowTokens;
      }
    } catch {
      // usage is optional
    }
    return ev;
  };

  const messageId = (m: any, role: string): string => `${role}:${m?.timestamp ?? now()}`;

  // ── session lifecycle ──
  on("session_start", (event, ctx) => {
    if (!sessionId) sessionId = String(ctx?.sessionManager?.getSessionId?.() ?? "") || undefined;
    const reason = event?.reason as string | undefined;
    const known = sessionId ? seenSessions.has(sessionId) : false;
    if (sessionId) seenSessions.add(sessionId);
    const phase = reason === "resume" ? "restored" : known || reason === "reload" ? "restarted" : "started";
    setModel(ctx?.model);
    feed.push({ kind: "lifecycle", ts: iso(), phase }, 2);
    emitCapabilities();
    const cwd: string | undefined = ctx?.cwd;
    if (cwd) {
      feed.push({ kind: "association", ts: iso(), worktree: cwd }, 1);
      const resolve = opts.resolveGit ?? defaultResolveGit;
      void resolve(cwd)
        .then((g) => {
          if (g?.branch) feed.push({ kind: "association", ts: iso(), worktree: cwd, branch: g.branch }, 1);
        })
        .catch(() => {});
    }
  });
  on("session_shutdown", () => {
    feed.push({ kind: "lifecycle", ts: iso(), phase: "ended" }, 2);
    feed.flush();
  });
  // ── model switch ──
  on("model_select", (event) => {
    setModel(event?.model);
    const reason = opts.modelReason?.() ?? "switch";
    feed.push(
      {
        kind: "model",
        ts: iso(),
        model: event?.model?.id,
        provider: event?.model?.provider,
        ...(event?.previousModel?.id ? { previous_model: event.previousModel.id } : {}),
        reason,
      },
      1,
    );
    emitCapabilities();
  });

  // ── messages (+ optional reasoning, usage) ──
  on("message_start", (event) => {
    const m = event?.message;
    if (m?.role === "assistant") {
      thinkingBuf = "";
      thinkingSeen = false;
    }
    if (m?.role !== "user") return;
    const t = headTail(textOf(m), INSPECTOR_LIMITS.message);
    feed.push(
      {
        kind: "message",
        ts: iso(),
        message_id: messageId(m, "user"),
        role: "user",
        text: t.text,
        truncated: t.truncated,
      },
      1,
    );
  });
  on("message_update", (event) => {
    const d = event?.assistantMessageEvent;
    const type = d?.type;
    if (type === "thinking_start" || type === "thinking_delta") {
      observeThinking();
      if (reasoningMode !== "off" && type === "thinking_delta" && typeof d.delta === "string") {
        if (thinkingBuf.length < INSPECTOR_LIMITS.message) thinkingBuf += d.delta;
      }
    } else if (type === "thinking_end") {
      observeThinking();
      if (reasoningMode !== "off" && observedReasoning !== "none") {
        const raw = typeof d.content === "string" && d.content ? d.content : thinkingBuf;
        thinkingBuf = "";
        if (raw) {
          const t = headTail(raw, INSPECTOR_LIMITS.message);
          feed.push(
            {
              kind: "reasoning",
              ts: iso(),
              message_id: messageId(event?.message, "assistant"),
              text: t.text,
              source: observedReasoning === "summary" ? "provider_summary" : "provider_raw",
            },
            1,
          );
        }
      }
    }
  });
  on("message_end", (event, ctx) => {
    const m = event?.message;
    if (m?.role !== "assistant") return;
    const text = textOf(m);
    if (text) {
      const t = headTail(text, INSPECTOR_LIMITS.message);
      feed.push(
        {
          kind: "message",
          ts: iso(),
          message_id: messageId(m, "assistant"),
          role: "assistant",
          text: t.text,
          truncated: t.truncated,
        },
        1,
      );
    }
    const usage = usageFor(m, ctx);
    if (usage) feed.push(usage, 1);
  });

  // ── tools ──
  on("tool_call", (event) => {
    const tool = String(event?.toolName ?? "");
    const input = event?.input;
    const p = pathOf(input);
    const st: CallState = calls.get(event?.toolCallId) ?? { tool, startedAt: now(), sensitive: false };
    if (p) {
      st.path = p;
      st.sensitive = isSensitivePath(p);
      const op = FILE_TOOLS[tool];
      if (op) st.fileOp = op;
    }
    if (tool === "bash" && input && typeof (input as any).command === "string") st.command = (input as any).command;
    if (typeof event?.toolCallId === "string") {
      if (calls.size > 256) calls.delete(calls.keys().next().value as string);
      calls.set(event.toolCallId, st);
    }
    // Reads have no result-side data we need: report them as soon as they are requested.
    if (st.fileOp === "read" && st.path) {
      feed.push(
        {
          kind: "file",
          ts: iso(),
          path: st.path,
          op: "read",
          call_id: event.toolCallId,
          ...(st.sensitive ? { sensitive: true } : {}),
        },
        1,
      );
    }
  });
  on("tool_execution_start", (event) => {
    const id = String(event?.toolCallId ?? "");
    const tool = String(event?.toolName ?? "");
    let st = calls.get(id);
    if (!st) {
      st = { tool, startedAt: now(), sensitive: false };
      const p = pathOf(event?.args);
      if (p) {
        st.path = p;
        st.sensitive = isSensitivePath(p);
      }
      calls.set(id, st);
    }
    st.tool = tool;
    st.startedAt = now();
    if (tool === "bash" && typeof event?.args?.command === "string") st.command = event.args.command;
    feed.push(
      {
        kind: "tool",
        ts: iso(),
        call_id: id,
        tool,
        phase: "start",
        args_preview: argsPreview(event?.args),
        ...(st.sensitive ? { sensitive: true } : {}),
      },
      1,
    );
    if (st.command && isTestCommand(st.command)) {
      feed.push({ kind: "test", ts: iso(), run_id: id, command: st.command.slice(0, 300), phase: "start" }, 1);
    }
  });
  on("tool_execution_update", (event) => {
    const id = String(event?.toolCallId ?? "");
    const st = calls.get(id);
    feed.pushUpdate(id, () => {
      const t = tail(textOf(event?.partialResult), INSPECTOR_LIMITS.toolChunk);
      return {
        kind: "tool",
        call_id: id,
        tool: String(event?.toolName ?? ""),
        phase: "update",
        output: t.text,
        truncated: t.truncated,
        ...(st?.sensitive ? { sensitive: true } : {}),
      };
    });
  });
  on("tool_execution_end", (event) => {
    const id = String(event?.toolCallId ?? "");
    feed.closeUpdates(id);
    const st = calls.get(id);
    calls.delete(id);
    const out = textOf(event?.result);
    const t = headTail(out, INSPECTOR_LIMITS.toolOutput);
    const isError = event?.isError === true;
    const tool = String(event?.toolName ?? st?.tool ?? "");
    const ev: InspectorEvent = {
      kind: "tool",
      ts: iso(),
      call_id: id,
      tool,
      phase: "end",
      output: t.text,
      is_error: isError,
      truncated: t.truncated,
      ...(st ? { duration_ms: Math.max(0, now() - st.startedAt) } : {}),
      ...(st?.sensitive ? { sensitive: true } : {}),
    };
    let exitCode: number | undefined;
    if (tool === "bash") {
      const m = out.match(/(?:exited|exit(?:ed)? with) (?:with )?code (-?\d+)/i);
      exitCode = m ? Number(m[1]) : isError ? undefined : 0;
      if (exitCode !== undefined) ev.exit_code = exitCode;
    }
    feed.push(ev, 2);
    if (st?.command && isTestCommand(st.command)) {
      const parsed = parseTestOutput(out);
      feed.push(
        {
          kind: "test",
          ts: iso(),
          run_id: id,
          command: st.command.slice(0, 300),
          phase: "end",
          ...(st ? { duration_ms: Math.max(0, now() - st.startedAt) } : {}),
          // Counts only when the output is a recognised format; exit code is always real when known.
          ...(parsed.passed !== undefined ? { passed: parsed.passed } : {}),
          ...(parsed.failed !== undefined ? { failed: parsed.failed } : {}),
          ...(parsed.skipped !== undefined ? { skipped: parsed.skipped } : {}),
          ...(parsed.failures ? { failures: parsed.failures } : {}),
          ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        },
        2,
      );
    }
  });
  on("tool_result", (event) => {
    const id = String(event?.toolCallId ?? "");
    const st = calls.get(id);
    const tool = String(event?.toolName ?? "");
    const op = FILE_TOOLS[tool];
    if (!op || op === "read") return;
    const p = pathOf(event?.input) ?? st?.path;
    if (!p) return;
    const sensitive = isSensitivePath(p);
    const ev: InspectorEvent = { kind: "file", ts: iso(), path: p, op, call_id: id };
    const diff = event?.details?.diff;
    if (typeof diff === "string" && diff) {
      const t = headTail(diff, INSPECTOR_LIMITS.diff);
      ev.diff = t.text;
      Object.assign(ev, countDiff(diff));
    }
    if (sensitive) ev.sensitive = true;
    if (event?.isError === true) return;
    feed.push(ev, 1);
  });

  // ── subagents ──
  const events = (pi as unknown as { events?: { on?: (e: string, h: (d: unknown) => void) => unknown } }).events;
  if (typeof events?.on === "function") {
    const off = events.on(
      "subagents:tool_call",
      guard((data: unknown) => {
        const { toolName, input, agent } = (data ?? {}) as { toolName?: string; input?: unknown; agent?: string };
        if (!toolName) return;
        const agentId = typeof agent === "string" && agent ? agent.slice(0, 120) : "subagent";
        const p = pathOf(input);
        const sensitive = p ? isSensitivePath(p) : false;
        const callId = `sub:${++subCounter}`;
        feed.push(
          {
            kind: "tool",
            ts: iso(),
            call_id: callId,
            tool: toolName,
            phase: "start",
            args_preview: argsPreview(input),
            agent_id: agentId,
            parent_agent_id: "main",
            ...(sensitive ? { sensitive: true } : {}),
          },
          1,
        );
        const op = FILE_TOOLS[toolName];
        if (op && p) {
          feed.push(
            {
              kind: "file",
              ts: iso(),
              path: p,
              op,
              call_id: callId,
              agent_id: agentId,
              parent_agent_id: "main",
              ...(sensitive ? { sensitive: true } : {}),
            },
            1,
          );
        }
      }),
    );
    if (typeof off === "function") offs.push(off as () => void);
  }

  return {
    feed,
    associate: guard((a: InspectorAssociation) => feed.push({ kind: "association", ts: iso(), ...a }, 1)),
    flush: () => feed.flush(),
    dispose: () => {
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          // Pi may not support removing handlers
        }
      }
      feed.dispose();
    },
  };
}

async function defaultResolveGit(cwd: string): Promise<{ branch?: string } | undefined> {
  const { GitRepo } = await import("../../git/GitRepo.ts");
  const repo = await GitRepo.open(cwd);
  const branch = repo ? await repo.currentBranch() : null;
  return branch ? { branch } : undefined;
}

// ── central host config entry point ─────────────────────────────────────────

/** Resolved inspector configuration; `enabled` only when the central config sets `inspector.enabled` to boolean true. */
export function inspectorConfigFromHost(cfg: Pick<HostConfig, "url" | "apiKey" | "get">): {
  enabled: boolean;
  url: string;
  apiKey?: string;
  reasoning: ReasoningMode;
} {
  const r = String(cfg.get<unknown>("inspector.reasoning", "off")).trim().toLowerCase();
  return {
    enabled: cfg.get<unknown>("inspector.enabled", false) === true,
    url: cfg.url,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    reasoning: r === "summary" || r === "full" ? r : "off",
  };
}

/**
 * Load the central host config and attach the feed when it enables the
 * inspector; resolves null (and registers nothing) otherwise. Rejects with
 * {@link HostConfigUnavailable} when no config can be loaded (callers decide
 * whether that matters). Builds its own {@link ControlPlaneIngest} because no
 * production code constructs one today.
 */
export async function attachInspectorFeedFromHost(
  pi: ExtensionAPI,
  extra: Partial<InspectorFeedOptions> & { fetch?: typeof globalThis.fetch; hostConfig?: LoadHostConfigOptions } = {},
): Promise<InspectorFeedHandle | null> {
  const { fetch, hostConfig, ...rest } = extra;
  const host = await loadHostConfig(hostConfig);
  const cfg = inspectorConfigFromHost(host);
  if (!cfg.enabled) return null;
  const ingest = new ControlPlaneIngest({
    url: cfg.url,
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(fetch ? { fetch } : {}),
  });
  const handle = attachInspectorFeed(pi, { reasoning: cfg.reasoning, ingest, ...rest });
  const env = rest.env ?? process.env;
  const paneId = rest.sessionId ?? env.HERDR_PANE_ID?.trim();
  if (handle && paneId) {
    const reporter = reportRuntimeFacts(ingest, paneId, env);
    pi.on?.("session_shutdown" as never, (() => reporter.stop()) as never);
  }
  return handle;
}
