/**
 * Feasibility spike: a WorkerExecutor that runs one fresh worker session in a Pi-Bolt (or any Pi) child process
 * over `--mode rpc`, instead of in-process through the Pi SDK like PiWorkerExecutor.
 *
 * NOT wired into any mission path. It exists to show what an RPC-backed worker can and cannot do:
 *  - works: fresh session per task, cwd, builtin tool allowlist, inactivity timeout, cancellation, final-answer capture, tool-call count.
 *  - not carried over: the in-process terminating tools (`worker_result`, `review_result`), tolerant file tools, the resilience wrapper,
 *    context-budget aborts and checkpoint claims all live in extensions/SDK hooks. The worker here reports its result as a JSON object in
 *    its final message, which is weaker than the validated terminating-tool contract.
 * Plan gates, Autospec and lineage depend on those pieces, so they stay on PiWorkerExecutor.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { WorkerResult } from "../core/types.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "./WorkerExecutor.ts";

const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export interface PiBoltRpcWorkerOptions {
  /** Path to the pi / pi-bolt binary. */
  binary: string;
  /** `provider/id` passed to `--model`. */
  model: string;
  /** Private agent dir (models.json etc.). */
  agentDir?: string;
  /** Default inactivity guard in ms when the request has none. */
  timeoutMs?: number;
}

const RESULT_INSTRUCTIONS =
  'When finished, reply with ONLY a JSON object: {"status":"completed"|"blocked"|"failed","summary":string,"claims":[{"claim":string,"evidence":string}]}.';

/** Pull the last JSON object out of the worker's final text. */
export function parseWorkerText(text: string): WorkerResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)].filter(
    Boolean,
  ) as string[];
  for (const c of candidates) {
    try {
      const o = JSON.parse(c) as Partial<WorkerResult>;
      if (o && (o.status === "completed" || o.status === "blocked" || o.status === "failed")) {
        return {
          status: o.status,
          summary: String(o.summary ?? ""),
          claims: Array.isArray(o.claims) ? o.claims : [],
          evidence_refs: [],
          new_hypotheses: [],
          proposed_tasks: [],
          details: {},
        };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return {
    status: "failed",
    summary: "",
    claims: [],
    evidence_refs: [],
    new_hypotheses: [],
    proposed_tasks: [],
    details: {},
    error: "worker did not return a result object",
  };
}

export class PiBoltRpcWorkerExecutor implements WorkerExecutor {
  private readonly opts: PiBoltRpcWorkerOptions;

  constructor(opts: PiBoltRpcWorkerOptions) {
    this.opts = opts;
  }

  run(req: WorkerRequest): Promise<WorkerRun> {
    const tools = req.tools.filter((t) => BUILTIN_TOOLS.has(t));
    const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--thinking", "off", "--model", this.opts.model];
    args.push(...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]));
    const env = {
      ...process.env,
      ...(this.opts.agentDir ? { PI_CODING_AGENT_DIR: this.opts.agentDir } : {}),
      PI_SKIP_VERSION_CHECK: "1",
    };
    const child: ChildProcessWithoutNullStreams = spawn(this.opts.binary, args, { cwd: req.cwd, env });
    const idleMs = req.timeoutMs ?? this.opts.timeoutMs ?? 120_000;
    const message = [
      req.kickoff ?? req.task,
      req.context ? `\nContext:\n${req.context}` : "",
      `\n${RESULT_INSTRUCTIONS}`,
    ].join("");

    return new Promise<WorkerRun>((resolve) => {
      let buf = "";
      let toolCalls = 0;
      let settled = false;
      let idle: NodeJS.Timeout;
      const finish = (run: WorkerRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        req.signal?.removeEventListener("abort", onAbort);
        child.kill("SIGTERM");
        resolve(run);
      };
      const fail = (error: string) =>
        finish({
          result: {
            status: "failed",
            summary: "",
            claims: [],
            evidence_refs: [],
            new_hypotheses: [],
            proposed_tasks: [],
            details: {},
            error,
          },
          usage: null,
          error,
          toolCalls,
        });
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail(`no session event for ${idleMs} ms`), idleMs);
      };
      const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);
      const onAbort = () => {
        send({ type: "abort" });
        setTimeout(() => fail("canceled"), 500);
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });
      if (req.signal?.aborted) return onAbort();

      child.on("error", (e) => fail(`spawn failed: ${e.message}`));
      child.on("exit", (code) => fail(`runtime exited (${code}) before a result`));
      child.stderr.on("data", () => arm());
      child.stdout.on("data", (chunk: Buffer) => {
        arm();
        buf += chunk.toString("utf8");
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          let o: { type?: string; command?: string; data?: { text?: string }; success?: boolean };
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o.type === "tool_execution_start") toolCalls++;
          else if (o.type === "agent_end") send({ id: "last", type: "get_last_assistant_text" });
          else if (o.type === "response" && o.command === "get_last_assistant_text") {
            const result = parseWorkerText(o.data?.text ?? "");
            finish({ result, usage: null, toolCalls, ...(result.error ? { error: result.error } : {}) });
          }
        }
      });
      arm();
      send({ id: "p", type: "prompt", message });
    });
  }
}
