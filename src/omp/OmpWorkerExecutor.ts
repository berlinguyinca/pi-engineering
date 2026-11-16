import { type ChildProcess, spawn } from "node:child_process";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerResult } from "../core/types.ts";
import { TOOL_TRANSITION_RULE } from "../guard/RecoveryController.ts";
import { classifyError } from "../guard/transient.ts";
import { reviewResultTool } from "../lifecycle/reviewResultTool.ts";
import { MISSION_DEPTH_ENV, missionDepth } from "../orchestration/missionMode.ts";
import { resolveWorkerSkills } from "../skillpack/workerPacks.ts";
import { PROSE_ROLES, workerContext } from "../workers/PiWorkerExecutor.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import {
  CONTEXT_USAGE_SUMMARY,
  StreamingActivityThrottle,
  activityFromSessionEvent,
  emitWorkerActivity,
} from "../workers/activity.ts";
import { BuildCommandTimer } from "../workers/buildActivity.ts";
import { MUTATING_ROLES, WORKER_KICKOFF, buildSystemPrompt } from "../workers/prompts.ts";
import { completedReviewResult } from "../workers/reviewVerdict.ts";
import { createWorkerResultTool } from "../workers/workerResultTool.ts";
import { decodeReadyFrame, parseFrameLine } from "./frames.ts";
import { buildHostTools, isCheckpointTool, toHostToolSpec } from "./hostTools.ts";
import { terminate } from "./negotiate.ts";
import { type RpcEvent, RunCollector, buildOmpArgs, ompToolsFor, translateFrame } from "./rpcTranslate.ts";
import type { OmpLaunchSpec } from "./types.ts";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_INACTIVITY_MS = 300_000;
/** Upper bound on how long the inactivity guard is suspended while an omp bash call is in flight (omp's own tool timeout normally ends it first). */
const DEFAULT_BASH_MAX_MS = 3_600_000;
const MAX_FRAME_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 2_048;
const EXIT_SETTLE_DEFER_MS = 100;

export interface OmpWorkerOptions {
  /** Cap on the inactivity pause while a bash call is running; default 1 h. */
  readonly bashMaxMs?: number;
  readonly launch: OmpLaunchSpec;
  /** `provider/id` passed to `--model`; omp's own default when absent. */
  readonly model?: string;
  /** Isolated OMP HOME (offline mode: holds models.yml). */
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Budget for `ready` + `set_host_tools`; failing it makes the run unavailable (callers fall back). */
  readonly startTimeoutMs?: number;
}

/** Raised before the prompt was sent: nothing ran, so the caller may use another executor. */
export class OmpWorkerUnavailable extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`omp worker unavailable: ${detail}`);
    this.name = "OmpWorkerUnavailable";
    this.detail = detail;
  }
}

const emptyResult = (status: WorkerResult["status"], summary: string, error?: string): WorkerResult => ({
  status,
  summary,
  claims: [],
  evidence_refs: [],
  new_hypotheses: [],
  proposed_tasks: [],
  details: {},
  ...(error ? { error } : {}),
});

type Phase = "starting" | "running";
type Outcome = { run: WorkerRun } | { unavailable: string };

/**
 * A PE worker backed by one fresh `omp --mode rpc` process per run (INV-002).
 *
 * The result is delivered through a HOST tool (`worker_result` / `review_result`)
 * that omp calls back into this process; PE's own tool implementation
 * normalizes it, so the result contract is the one the Pi path produces.
 */
export class OmpWorkerExecutor implements WorkerExecutor {
  private readonly opts: OmpWorkerOptions;
  private customTools: readonly ToolDefinition[] = [];

  constructor(opts: OmpWorkerOptions) {
    this.opts = opts;
  }

  /** Bind the runtime's semantic tools (ledger_read, repo_search, ...); same contract as `PiWorkerExecutor.setCustomTools`. */
  setCustomTools(tools: readonly ToolDefinition[]): void {
    this.customTools = tools;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const terminating =
      req.resultTool === "review_result"
        ? reviewResultTool
        : createWorkerResultTool(
            req.baseRef && MUTATING_ROLES.has(req.role) ? { cwd: req.cwd, baseRef: req.baseRef } : undefined,
          );
    const { tools: hostTools, replaced } = await buildHostTools(req, this.customTools);
    // A PE replacement (worktree-confined write/edit) is offered as pe_<name>; the omp built-in it replaces stays off.
    const builtin = ompToolsFor(req.tools.filter((name) => !replaced.has(name))).builtin;
    const built = buildSystemPrompt(req.role, req.task, workerContext(req), {
      isolatedWorktree: req.isolatedWorktree,
    });
    const systemPrompt =
      req.systemPromptOverride ?? (PROSE_ROLES.has(req.role) ? built : `${built}\n\n${TOOL_TRANSITION_RULE}`);
    const base = this.opts.env ?? process.env;
    // Opt-in (PI_ENGINEERING_WORKER_SKILLS=1 plus workers.skillPacks for this role): verified packs only; a refused
    // pack is reported as activity and the worker runs without it.
    const skills = await resolveWorkerSkills({ role: req.role, cwd: req.cwd, env: base });
    for (const line of skills.diagnostics)
      req.onActivity?.({ kind: "state", summary: line, meaningfulProgress: false });
    const args = [
      ...this.opts.launch.args,
      ...buildOmpArgs({
        model: this.opts.model,
        systemPrompt,
        builtin,
        skillPackDirs: skills.packs.map((p) => p.dir),
      }),
    ];
    // Every worker command runs one mission-depth deeper (recursion guard); omp's children inherit it.
    const env = {
      ...base,
      [MISSION_DEPTH_ENV]: String(missionDepth(base) + 1),
      ...(this.opts.home ? { HOME: this.opts.home } : {}),
    };

    return new Promise<WorkerRun>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(this.opts.launch.command, args, {
          cwd: req.cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (error) {
        reject(new OmpWorkerUnavailable(`spawn threw: ${String(error)}`));
        return;
      }
      const collector = new RunCollector();
      let phase: Phase = "starting";
      let structured: unknown;
      let stderr = "";
      let buffer = "";
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      // Host tool calls in flight: omp is waiting on PE, so its silence is not inactivity.
      let inflight = 0;
      const runAbort = new AbortController();

      const send = (frame: unknown): void => {
        child.stdin?.write(`${JSON.stringify(frame)}\n`);
      };
      const onAbort = (): void => {
        if (phase === "running") send({ type: "abort", id: "pe-abort" });
        // The owner asked to stop: never an Unavailable (that would re-run the work on the legacy executor).
        finish({ run: failedRun("OMP worker failed: aborted by owner") });
      };
      const finish = (outcome: Outcome): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        runAbort.abort();
        req.signal?.removeEventListener("abort", onAbort);
        void terminate(child).then(() => {
          if ("run" in outcome) resolve(outcome.run);
          else reject(new OmpWorkerUnavailable(outcome.unavailable));
        });
      };
      const failedRun = (reason: string): WorkerRun => ({
        result: emptyResult("failed", reason, reason),
        usage: collector.usage(),
        error: reason,
        toolCalls: collector.toolCalls,
      });
      function fail(error: string): void {
        finish(phase === "starting" ? { unavailable: error } : { run: failedRun(`OMP worker failed: ${error}`) });
      }
      // omp's own bash runs in the foreground (auto-background is off in the overlay) and is silent until it
      // ends, so the inactivity guard is suspended while one is in flight, bounded by bashMaxMs. With no tool in
      // flight, silence still times out as before.
      const bashInFlight = new Set<string>();
      const arm = (): void => {
        clearTimeout(timer);
        if (done || inflight > 0) return;
        const bash = bashInFlight.size > 0;
        const ms =
          phase === "starting"
            ? (this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
            : bash
              ? Math.max(req.timeoutMs ?? DEFAULT_INACTIVITY_MS, this.opts.bashMaxMs ?? DEFAULT_BASH_MAX_MS)
              : (req.timeoutMs ?? DEFAULT_INACTIVITY_MS);
        timer = setTimeout(
          () => fail(`no omp frame for ${ms}ms (${phase}${bash ? ", bash in flight" : ""})`),
          Math.max(1, ms),
        );
      };

      const complete = (status: "completed" | "aborted" | "error", error?: string): void => {
        if (structured !== undefined && structured !== null) {
          const result: WorkerResult =
            req.resultTool === "review_result" ? completedReviewResult(structured) : (structured as WorkerResult);
          finish({ run: { result, usage: collector.usage(), toolCalls: collector.toolCalls, structured } });
          return;
        }
        finish({
          run: failedRun(
            status === "completed"
              ? `Worker returned no ${terminating.name}.`
              : `OMP prompt ${status}${error ? `: ${error}` : ""}`,
          ),
        });
      };

      // Host tools only read `cwd` from the context; the session-bound members of ExtensionContext have no omp twin.
      const toolCtx = { cwd: req.cwd } as ExtensionContext;
      const onHostToolCall = async (id: string, toolName: string, toolArgs: unknown): Promise<void> => {
        const isTerminating = toolName === terminating.name;
        const tool = isTerminating ? terminating : hostTools.get(toolName);
        if (!tool) {
          send({
            type: "host_tool_result",
            id,
            isError: true,
            result: { content: [{ type: "text", text: `unknown host tool ${toolName}` }] },
          });
          return;
        }
        // A finished or aborted run must not mutate the worktree: the process is already being killed.
        if (done) return;
        inflight++;
        clearTimeout(timer);
        try {
          const out = await tool.execute(id, toolArgs as never, runAbort.signal, undefined, toolCtx);
          if (done) return;
          const failed = (out as { isError?: boolean }).isError === true;
          if (isTerminating) structured = out.details;
          else if (isCheckpointTool(toolName) && !failed) {
            req.onActivity?.({
              kind: "checkpoint",
              summary: "Checkpoint progress recorded",
              meaningfulProgress: true,
              claims: (out.details as { claims?: never } | undefined)?.claims,
            });
          }
          send({
            type: "host_tool_result",
            id,
            ...(failed ? { isError: true } : {}),
            result: { content: out.content, details: out.details },
          });
        } catch (error) {
          if (done) return;
          const message = error instanceof Error ? error.message : String(error);
          send({
            type: "host_tool_result",
            id,
            isError: true,
            result: { content: [{ type: "text", text: message }] },
          });
        } finally {
          inflight--;
          arm();
        }
      };

      // The activity the legacy executor shows for the same session events (same shapes and summaries), so the
      // existing mission UI needs no change. PE's pe_<name> replacements report as the built-in they replace;
      // the terminating and checkpoint tools are reported by their own paths, as on the legacy executor.
      // The legacy session ends at the terminating tool; omp's closing turn after it is not reported.
      let resultCalled = false;
      let turnClosed = false;
      let turnToolErrors: string[] = [];
      let modelWindow: { id: string; window: number } | undefined;
      const streaming = new StreamingActivityThrottle();
      const buildTimer = new BuildCommandTimer();
      const emitFrameActivity = (frame: Record<string, unknown>): void => {
        const type = frame.type;
        if (turnClosed) return;
        const raw = typeof frame.toolName === "string" ? frame.toolName : undefined;
        if (type === "turn_end") {
          const m = (frame.message ?? {}) as { stopReason?: unknown };
          const stop = typeof m.stopReason === "string" ? m.stopReason : "unknown";
          emitWorkerActivity(req, {
            kind: "state",
            summary: `Turn ended: stop=${stop} tool_error=${turnToolErrors[0] ?? "none"}`,
            meaningfulProgress: false,
          });
          turnToolErrors = [];
          if (resultCalled) turnClosed = true;
          return;
        }
        // omp streams partial results for tools (write, edit) whose legacy counterparts never do; only bash's count.
        if (type === "message_update" || (type === "tool_execution_update" && raw === "bash")) {
          const streamed = streaming.note(frame as { type?: string; message?: unknown; partialResult?: unknown });
          if (streamed && !resultCalled) emitWorkerActivity(req, streamed);
          return;
        }
        if (type !== "tool_execution_start" && type !== "tool_execution_end" && type !== "message_end") return;
        // The legacy session ends at the terminating tool only when it ran; a failed call is retried.
        if (type === "tool_execution_end" && raw === terminating.name && frame.isError !== true) resultCalled = true;
        if (type === "tool_execution_end" && frame.isError === true && raw !== terminating.name) {
          const text = (frame.result as { content?: Array<{ text?: unknown }> } | undefined)?.content
            ?.map((b) => (typeof b?.text === "string" ? b.text : ""))
            .join("");
          turnToolErrors.push(classifyError(text ?? "").category);
        }
        if (type === "message_end" && !resultCalled) {
          const message = (frame.message ?? {}) as {
            role?: unknown;
            model?: unknown;
            usage?: { totalTokens?: unknown };
          };
          const total = message.usage?.totalTokens;
          if (message.role === "assistant" && typeof total === "number" && modelWindow && modelWindow.window > 0) {
            emitWorkerActivity(req, {
              kind: "state",
              summary: CONTEXT_USAGE_SUMMARY,
              meaningfulProgress: false,
              context: { tokens: total, window: modelWindow.window, model: modelWindow.id },
            });
          }
        }
        if (raw === terminating.name || (raw !== undefined && isCheckpointTool(raw))) return;
        const bare = raw?.startsWith("pe_") && replaced.has(raw.slice(3)) ? raw.slice(3) : raw;
        const activity = buildTimer.observe(
          frame,
          activityFromSessionEvent({ ...frame, ...(bare === undefined ? {} : { toolName: bare }) }),
        );
        if (activity) emitWorkerActivity(req, activity);
      };

      const handle = (frame: Record<string, unknown>): void => {
        if (done) return;
        if (frame.toolName === "bash" && typeof frame.toolCallId === "string") {
          if (frame.type === "tool_execution_start") bashInFlight.add(frame.toolCallId);
          else if (frame.type === "tool_execution_end") bashInFlight.delete(frame.toolCallId);
        }
        arm();
        if (phase === "starting" && frame.type === "ready") {
          if (decodeReadyFrame(frame) === null) {
            fail("malformed ready frame");
            return;
          }
          send({
            id: "pe-host-tools",
            type: "set_host_tools",
            tools: [terminating, ...hostTools.values()].map(toHostToolSpec),
          });
          return;
        }
        emitFrameActivity(frame);
        const event: RpcEvent = translateFrame(frame);
        collector.accept(event);
        if (event.kind === "response" && event.id === "pe-state") {
          const model = (event.data as { model?: { id?: unknown; contextWindow?: unknown } } | undefined)?.model;
          if (event.success && typeof model?.id === "string" && typeof model.contextWindow === "number")
            modelWindow = { id: model.id, window: model.contextWindow };
          return;
        }
        if (event.kind === "response" && event.id === "pe-host-tools") {
          if (!event.success) {
            fail(`set_host_tools rejected: ${event.error ?? "unknown"}`);
            return;
          }
          phase = "running";
          arm();
          emitWorkerActivity(req, { kind: "state", summary: "Worker session started", meaningfulProgress: false });
          send({ id: "pe-state", type: "get_state" });
          send({ id: "pe-prompt", type: "prompt", message: req.kickoff ?? WORKER_KICKOFF });
        } else if (event.kind === "response" && event.id === "pe-prompt" && !event.success) {
          fail(`prompt rejected: ${event.error ?? "unknown"}`);
        } else if (event.kind === "host_tool_call") {
          void onHostToolCall(event.id, event.toolName, event.args);
        } else if (event.kind === "prompt_result") {
          complete(event.status, event.error);
        }
      };

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
      });
      child.stdin?.on("error", () => {});
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          const frame = parseFrameLine(line);
          if (frame) handle(frame);
        }
        if (buffer.length > MAX_FRAME_LINE_BYTES) fail("frame line exceeds 1 MiB");
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        fail(
          error.code === "ENOENT" || error.code === "EACCES"
            ? `${this.opts.launch.command}: ${error.code}`
            : `spawn error: ${error.message}`,
        );
      });
      child.once("exit", (code, signal) => {
        // Let already-buffered stdout (prompt_result) settle before calling this a crash.
        setTimeout(
          () =>
            fail(`omp exited before completing (code=${code}, signal=${signal}) stderr=${stderr.trim() || "<empty>"}`),
          EXIT_SETTLE_DEFER_MS,
        );
      });
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener("abort", onAbort, { once: true });
      arm();
    });
  }
}
