import type { WorkerUsage } from "../core/types.ts";
import { firewallArgs } from "./firewall.ts";

/**
 * Pure translation of OMP `--mode rpc` frames into what a PE worker run needs.
 * Every shape here was observed from the real binary (omp 18.20.0); the frames
 * are kept verbatim in test/fixtures/omp-frames/.
 */

export type RpcEvent =
  | { kind: "response"; id: string | null; command: string; success: boolean; error?: string; data?: unknown }
  | { kind: "host_tool_call"; id: string; toolName: string; args: unknown }
  | { kind: "tool_end"; toolName: string; isError: boolean }
  | { kind: "assistant_end"; usage: RpcUsage; model: string; text: string }
  | { kind: "prompt_result"; status: "completed" | "aborted" | "error"; error?: string }
  | { kind: "ignored" };

export interface RpcUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const IGNORED: RpcEvent = { kind: "ignored" };

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function assistantEnd(message: Record<string, unknown>): RpcEvent {
  const usage = rec(message.usage) ?? {};
  const cost = rec(usage.cost);
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((part) => rec(part))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part?.text as string)
    .join("");
  return {
    kind: "assistant_end",
    usage: {
      input: num(usage.input),
      output: num(usage.output),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      cost: num(cost?.total),
    },
    model: typeof message.model === "string" ? message.model : "",
    text,
  };
}

/** Classify one decoded frame. Frames the worker run does not need (streaming deltas, UI, command lists) are `ignored`. */
export function translateFrame(frame: Record<string, unknown>): RpcEvent {
  switch (frame.type) {
    case "response":
      return {
        kind: "response",
        id: typeof frame.id === "string" ? frame.id : null,
        command: typeof frame.command === "string" ? frame.command : "",
        success: frame.success === true,
        ...(typeof frame.error === "string" ? { error: frame.error } : {}),
        data: frame.data,
      };
    case "host_tool_call":
      return typeof frame.id === "string" && typeof frame.toolName === "string"
        ? { kind: "host_tool_call", id: frame.id, toolName: frame.toolName, args: frame.arguments }
        : IGNORED;
    case "tool_execution_end":
      return {
        kind: "tool_end",
        toolName: typeof frame.toolName === "string" ? frame.toolName : "",
        isError: frame.isError === true,
      };
    case "message_end": {
      const message = rec(frame.message);
      return message?.role === "assistant" ? assistantEnd(message) : IGNORED;
    }
    case "prompt_result": {
      const status = frame.status === "aborted" || frame.status === "error" ? frame.status : "completed";
      return { kind: "prompt_result", status, ...(typeof frame.error === "string" ? { error: frame.error } : {}) };
    }
    default:
      return IGNORED;
  }
}

/** Accumulates tool-call count, usage and the last assistant text across one prompt. */
export class RunCollector {
  toolCalls = 0;
  turns = 0;
  lastText = "";
  private model = "";
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private contextTokens = 0;

  accept(event: RpcEvent): void {
    if (event.kind === "tool_end") {
      this.toolCalls += 1;
    } else if (event.kind === "assistant_end") {
      this.turns += 1;
      this.input += event.usage.input;
      this.output += event.usage.output;
      this.cacheRead += event.usage.cacheRead;
      this.cacheWrite += event.usage.cacheWrite;
      this.cost += event.usage.cost;
      this.contextTokens = event.usage.input + event.usage.cacheRead + event.usage.output;
      this.model = event.model || this.model;
      this.lastText = event.text;
    }
  }

  /** Null when no assistant message ever reported usage (never 0 for "not reported"). */
  usage(): WorkerUsage | null {
    if (this.turns === 0) return null;
    return {
      input: this.input,
      output: this.output,
      total: this.input + this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      contextTokens: this.contextTokens,
      turns: this.turns,
      model: this.model,
    };
  }
}

/** PE tool name -> OMP built-in. PE's `ls` has no OMP twin; `read` lists directories. */
const BUILTIN_FOR: Readonly<Record<string, string>> = {
  read: "read",
  grep: "grep",
  find: "glob",
  ls: "read",
  bash: "bash",
  edit: "edit",
  write: "write",
};

/** Translate a PE tool allowlist. Names with no OMP equivalent (repo_search, symbol, ledger_read, ...) are reported, never silently exposed. */
export function ompToolsFor(tools: readonly string[]): { builtin: string[]; dropped: string[] } {
  const builtin = new Set<string>();
  const dropped: string[] = [];
  for (const name of tools) {
    if (name === "worker_result" || name === "review_result") continue;
    const mapped = BUILTIN_FOR[name];
    if (mapped) builtin.add(mapped);
    else dropped.push(name);
  }
  return { builtin: [...builtin], dropped };
}

/**
 * The context firewall, as flags plus a `--config` overlay (see firewall.ts). PE workers are skill-less and fresh-context:
 * no skills, extensions, rules, project context files, LSP, PTY, title
 * generation or session persistence; only the translated tool allowlist plus
 * the host result tool; a replaced system prompt.
 */
export function buildOmpArgs(opts: { model?: string; systemPrompt: string; builtin: readonly string[] }): string[] {
  return [
    "--mode",
    "rpc",
    "--no-session",
    ...firewallArgs(),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.builtin.length > 0 ? ["--tools", opts.builtin.join(",")] : ["--no-tools"]),
    "--system-prompt",
    opts.systemPrompt,
  ];
}
