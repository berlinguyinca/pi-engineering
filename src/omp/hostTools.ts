import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { offersCheckpointProgress, offersClaimDeliverable } from "../workers/PiWorkerExecutor.ts";
import type { WorkerRequest } from "../workers/WorkerExecutor.ts";
import { CHECKPOINT_PROGRESS_TOOL_NAME, createCheckpointProgressTool } from "../workers/checkpointProgressTool.ts";
import { CLAIM_DELIVERABLE_TOOL_NAME, createClaimDeliverableTool } from "../workers/claimDeliverableTool.ts";
import { createNumberedReadTool, createTolerantEditTool } from "../workers/tolerantFileTools.ts";
import { createWorktreeFileTools } from "../workers/worktreeFileTools.ts";

/** One tool as `set_host_tools` carries it. `parameters` is PE's own JSON Schema, untouched. */
export interface HostToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  loadMode: "essential";
}

export const RESULT_TOOL_NAMES: ReadonlySet<string> = new Set(["worker_result", "review_result"]);

/** PE tool names omp already owns as built-ins: a host tool may not reuse them (omp rejects the collision). */
const OMP_BUILTIN_NAMES: ReadonlySet<string> = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

/** Host name of a PE tool that replaces an omp built-in (worktree-confined write/edit, numbered read, tolerant edit). */
export const replacementName = (name: string): string => `pe_${name}`;

export interface HostToolPlan {
  /** Host tools to register, keyed by the name omp sees. */
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  /** PE tool names whose omp built-in must NOT be enabled because a PE replacement is registered instead. */
  readonly replaced: ReadonlySet<string>;
}

/**
 * The PE-owned tools an OMP worker gets as HOST tools for one request: the same set, filtered by the same
 * per-role allowlist (`req.tools`), that `PiWorkerExecutor` hands its in-process session. They execute in PE
 * (host side), so ledger/artifact/broker access and the worktree mutation boundary stay in PE. Result tools
 * are never included: the executor owns them. `bash` is not replaced: omp's own bash runs in the worker's
 * process group (killed with it) and the mission-depth marker is set in the process environment.
 */
export async function buildHostTools(req: WorkerRequest, base: readonly ToolDefinition[]): Promise<HostToolPlan> {
  const candidates: ToolDefinition[] = [
    ...base,
    ...(req.tolerantFileTools ? [createNumberedReadTool(req.cwd)] : []),
    ...(req.isolatedWorktree
      ? await createWorktreeFileTools(req.cwd, req.tolerantFileTools === true)
      : req.tolerantFileTools
        ? [createTolerantEditTool(req.cwd)]
        : []),
    ...(offersClaimDeliverable(req)
      ? [createClaimDeliverableTool(req.deliverables ?? []) as unknown as ToolDefinition]
      : []),
    ...(offersCheckpointProgress(req) ? [createCheckpointProgressTool(req.deliverables ?? [])] : []),
  ];
  const tools = new Map<string, ToolDefinition>();
  const replaced = new Set<string>();
  // Later entries replace earlier ones of the same name (a worktree-confined `edit` replaces a stock one).
  for (const tool of candidates) {
    if (!req.tools.includes(tool.name) || RESULT_TOOL_NAMES.has(tool.name)) continue;
    const builtin = OMP_BUILTIN_NAMES.has(tool.name);
    if (builtin) replaced.add(tool.name);
    tools.set(
      builtin ? replacementName(tool.name) : tool.name,
      builtin ? { ...tool, name: replacementName(tool.name) } : tool,
    );
  }
  return { tools, replaced };
}

export const toHostToolSpec = (tool: Pick<ToolDefinition, "name" | "description" | "parameters">): HostToolSpec => ({
  name: tool.name,
  label: tool.name,
  description: tool.description,
  parameters: JSON.parse(JSON.stringify(tool.parameters)) as unknown,
  loadMode: "essential",
});

/** Tool names whose successful result carries checkpoint claims the broker consumes. */
export const isCheckpointTool = (name: string): boolean =>
  name === CHECKPOINT_PROGRESS_TOOL_NAME || name === CLAIM_DELIVERABLE_TOOL_NAME;
