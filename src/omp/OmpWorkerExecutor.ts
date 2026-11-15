import { type ChildProcess, spawn } from "node:child_process";
import type { WorkerResult } from "../core/types.ts";
import { reviewResultTool } from "../lifecycle/reviewResultTool.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import { MUTATING_ROLES, WORKER_KICKOFF, buildSystemPrompt } from "../workers/prompts.ts";
import { completedReviewResult } from "../workers/reviewVerdict.ts";
import { createWorkerResultTool } from "../workers/workerResultTool.ts";
import { decodeReadyFrame, parseFrameLine } from "./frames.ts";
import { terminate } from "./negotiate.ts";
import { type RpcEvent, RunCollector, buildOmpArgs, ompToolsFor, translateFrame } from "./rpcTranslate.ts";
import type { OmpLaunchSpec } from "./types.ts";

const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_INACTIVITY_MS = 300_000;
const MAX_FRAME_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 2_048;
const EXIT_SETTLE_DEFER_MS = 100;

export interface OmpWorkerOptions {
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

  constructor(opts: OmpWorkerOptions) {
    this.opts = opts;
  }

  run(req: WorkerRequest): Promise<WorkerRun> {
    const terminating =
      req.resultTool === "review_result"
        ? reviewResultTool
        : createWorkerResultTool(
            req.baseRef && MUTATING_ROLES.has(req.role) ? { cwd: req.cwd, baseRef: req.baseRef } : undefined,
          );
    const { builtin } = ompToolsFor(req.tools);
    const systemPrompt =
      req.systemPromptOverride ??
      buildSystemPrompt(req.role, req.task, req.context, { isolatedWorktree: req.isolatedWorktree });
    const args = [...this.opts.launch.args, ...buildOmpArgs({ model: this.opts.model, systemPrompt, builtin })];
    const env = { ...(this.opts.env ?? process.env), ...(this.opts.home ? { HOME: this.opts.home } : {}) };

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
      const arm = (): void => {
        clearTimeout(timer);
        if (done) return;
        const ms =
          phase === "starting"
            ? (this.opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
            : (req.timeoutMs ?? DEFAULT_INACTIVITY_MS);
        timer = setTimeout(() => fail(`no omp frame for ${ms}ms (${phase})`), Math.max(1, ms));
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

      const onHostToolCall = async (id: string, toolName: string, toolArgs: unknown): Promise<void> => {
        if (toolName !== terminating.name) {
          send({
            type: "host_tool_result",
            id,
            isError: true,
            result: { content: [{ type: "text", text: `unknown host tool ${toolName}` }] },
          });
          return;
        }
        try {
          const out = await terminating.execute(id, toolArgs as never, undefined, undefined, undefined as never);
          structured = out.details;
          send({ type: "host_tool_result", id, result: { content: out.content, details: out.details } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          send({
            type: "host_tool_result",
            id,
            isError: true,
            result: { content: [{ type: "text", text: message }] },
          });
        }
      };

      const handle = (frame: Record<string, unknown>): void => {
        if (done) return;
        arm();
        if (phase === "starting" && frame.type === "ready") {
          if (decodeReadyFrame(frame) === null) {
            fail("malformed ready frame");
            return;
          }
          send({
            id: "pe-host-tools",
            type: "set_host_tools",
            tools: [
              {
                name: terminating.name,
                description: terminating.description,
                parameters: JSON.parse(JSON.stringify(terminating.parameters)) as unknown,
                loadMode: "essential",
              },
            ],
          });
          return;
        }
        const event: RpcEvent = translateFrame(frame);
        collector.accept(event);
        if (event.kind === "response" && event.id === "pe-host-tools") {
          if (!event.success) {
            fail(`set_host_tools rejected: ${event.error ?? "unknown"}`);
            return;
          }
          phase = "running";
          arm();
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
