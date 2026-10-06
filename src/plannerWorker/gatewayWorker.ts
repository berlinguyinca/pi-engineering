/**
 * A tool-less `WorkerExecutor` over an OpenAI-compatible gateway.
 *
 * Production missions run roles through Pi worker sessions (PiWorkerExecutor,
 * full tool use). This executor exists for the benchmark harness and for
 * gateways reached without a Pi provider: each role gets ONE structured
 * completion, and an implementer's `files` are written into its worktree. The
 * planner/worker executor treats both executors identically — it inspects the
 * worktree, not the transcript.
 */

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { WorkerResult } from "../core/types.ts";
import type { WorkerExecutor, WorkerRequest, WorkerRun } from "../workers/WorkerExecutor.ts";
import { AWAITING_MODEL_RESPONSE_SUMMARY } from "../workers/activity.ts";
import { extractStructured } from "./contract.ts";
import { type CapabilityRequest, type GatewayConnection, chatCompletion } from "./gateway.ts";

export interface GatewayWorkerOptions extends GatewayConnection {
  /** Model used when a request carries no `modelOverride`. */
  defaultModel: string;
  /** Optional capability constraints per worker role (sent as request headers). */
  capabilityFor?: (role: WorkerRequest["role"]) => CapabilityRequest | undefined;
  /** Activity cadence while a completion is in flight (default 30 s). */
  keepaliveIntervalMs?: number;
  /** Stop reporting an in-flight completion as activity after this long (default 12 h). */
  keepaliveLimitMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when `path` stays inside `root` (no escape, no git metadata). */
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(/[\\/]/).includes(".git");
}

async function applyFiles(cwd: string, files: unknown[]): Promise<string[]> {
  const written: string[] = [];
  const root = await realpath(cwd);
  for (const f of files) {
    if (!isRecord(f) || typeof f.path !== "string" || typeof f.content !== "string") continue;
    if (isAbsolute(f.path)) continue;
    const target = resolve(root, f.path);
    if (!inside(root, target)) continue;
    await mkdir(dirname(target), { recursive: true });
    // A symlinked directory inside the worktree must not redirect the write outside it.
    const parent = await realpath(dirname(target));
    if (parent !== root && !inside(root, parent)) continue;
    await writeFile(target, f.content);
    written.push(relative(root, target));
  }
  return written;
}

export class GatewayChatWorkerExecutor implements WorkerExecutor {
  private readonly opts: GatewayWorkerOptions;

  constructor(opts: GatewayWorkerOptions) {
    this.opts = opts;
  }

  async run(req: WorkerRequest): Promise<WorkerRun> {
    const model = req.modelOverride?.id ?? this.opts.defaultModel;
    const capability = this.opts.capabilityFor?.(req.role);
    const outcome = await chatCompletion(this.opts, {
      model,
      system: req.systemPromptOverride ?? `You are a ${req.role}.`,
      user: [req.task, req.context].filter(Boolean).join("\n\n"),
      ...(capability ? { capability } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
      // Non-streaming: nothing arrives until the whole answer does, so the
      // open request is the worker's activity for the owner's watchdog.
      ...(req.onActivity
        ? {
            alive: {
              onAlive: () =>
                req.onActivity?.({
                  kind: "state",
                  summary: AWAITING_MODEL_RESPONSE_SUMMARY,
                  meaningfulProgress: false,
                }),
              ...(this.opts.keepaliveIntervalMs !== undefined ? { intervalMs: this.opts.keepaliveIntervalMs } : {}),
              ...(this.opts.keepaliveLimitMs !== undefined ? { limitMs: this.opts.keepaliveLimitMs } : {}),
            },
          }
        : {}),
    });
    if (!outcome.ok) {
      const result: WorkerResult = {
        status: "failed",
        summary: `gateway request failed (${outcome.status}): ${outcome.message}`,
        claims: [],
        evidence_refs: [],
        new_hypotheses: [],
        proposed_tasks: [],
        details: { gateway_status: outcome.status, gateway_error: outcome.error ?? null, model },
        error: outcome.message,
      };
      return { result, usage: null, error: outcome.message, toolCalls: 0 };
    }
    const parsed = extractStructured(outcome.content);
    const record = isRecord(parsed) ? parsed : {};
    const files = Array.isArray(record.files) && req.tools.includes("write") ? record.files : [];
    const written = await applyFiles(req.cwd, files);
    const status = record.status === "blocked" || record.status === "failed" ? record.status : "completed";
    const summary =
      typeof record.summary === "string" ? record.summary : outcome.content.slice(0, 2000) || "(empty response)";
    const result: WorkerResult = {
      status,
      summary,
      claims: [],
      evidence_refs: [],
      new_hypotheses: [],
      proposed_tasks: [],
      details: {
        served: outcome.served,
        files_written: written,
        ...(typeof record.evidence === "string" ? { evidence: record.evidence } : {}),
      },
    };
    return {
      result,
      usage: {
        input: outcome.usage.promptTokens,
        output: outcome.usage.completionTokens,
        cacheRead: outcome.usage.cachedTokens,
        cacheWrite: 0,
        cost: 0,
        contextTokens: outcome.usage.promptTokens + outcome.usage.completionTokens,
        turns: 1,
        model: outcome.served.model,
      },
      toolCalls: written.length,
      structured: parsed ?? outcome.content,
    };
  }
}
