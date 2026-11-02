/**
 * Task Contract: the trusted, versioned authorization snapshot for one task.
 *
 * Pure data and pure functions. The contract is created and amended by the
 * host/operator, never by the model; this module only validates, hashes and
 * narrows. Wire shape is `task-contract.schema.json` (Herdr Task Discipline v1).
 */
import { createHash } from "node:crypto";

export const TASK_MODES = ["investigation", "implementation", "review", "deployment"] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const EXTERNAL_EFFECTS = [
  "remote_read",
  "remote_write",
  "artifact_upload",
  "git_push",
  "ci_dispatch",
  "deploy",
  "remote_restart",
  "destructive_operation",
] as const;
export type ExternalEffect = (typeof EXTERNAL_EFFECTS)[number];

export interface TaskContract {
  taskId: string;
  missionId?: string;
  parentTaskId?: string;
  objective: string;
  mode: TaskMode;
  /** Monotonic; bumped by every approved amendment. */
  policyRevision: number;
  workspace?: string;
  /** Broad: anything under these may be read (including dependent repos). */
  readRoots: string[];
  /** Narrow: the only places files may be created, edited or deleted. */
  writeRoots: string[];
  /** Writable scratch space for diagnostics (e.g. a temp dir); never a repo. */
  scratchRoots?: string[];
  /** Files that are never writable regardless of roots (contract store, policy). */
  protectedPaths?: string[];
  /** Hosts the task may contact, and only for effects listed in externalEffects. */
  allowedHosts: string[];
  externalEffects: ExternalEffect[];
  /** Custom/MCP tool name globs the task may call. Built-in tools need no entry. */
  allowedTools?: string[];
  /** Command basenames the operator approved although the classifier does not know them. */
  allowedCommands?: string[];
  acceptanceCriteria: string[];
  owner?: string;
  createdAt?: string;
  approvedAmendmentIds?: string[];
}

export class ContractError extends Error {}

const isStr = (v: unknown): v is string => typeof v === "string";
const strArray = (v: unknown, name: string, required = true): string[] => {
  if (v === undefined && !required) return [];
  if (!Array.isArray(v) || !v.every(isStr)) throw new ContractError(`${name} must be an array of strings`);
  return [...v];
};

/** Validate an untrusted JSON value into a TaskContract; throws ContractError. */
export function parseContract(raw: unknown): TaskContract {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContractError("contract must be an object");
  const r = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    "taskId",
    "missionId",
    "parentTaskId",
    "objective",
    "mode",
    "policyRevision",
    "workspace",
    "readRoots",
    "writeRoots",
    "scratchRoots",
    "protectedPaths",
    "allowedHosts",
    "externalEffects",
    "allowedTools",
    "allowedCommands",
    "acceptanceCriteria",
    "owner",
    "createdAt",
    "approvedAmendmentIds",
  ]);
  for (const k of Object.keys(r)) if (!allowedKeys.has(k)) throw new ContractError(`unknown contract field: ${k}`);
  if (!isStr(r.taskId) || !r.taskId) throw new ContractError("taskId is required");
  if (!isStr(r.objective) || !r.objective) throw new ContractError("objective is required");
  if (!TASK_MODES.includes(r.mode as TaskMode)) throw new ContractError(`mode must be one of ${TASK_MODES.join(", ")}`);
  if (!Number.isInteger(r.policyRevision) || (r.policyRevision as number) < 1)
    throw new ContractError("policyRevision must be an integer >= 1");
  const effects = strArray(r.externalEffects, "externalEffects");
  for (const e of effects)
    if (!EXTERNAL_EFFECTS.includes(e as ExternalEffect)) throw new ContractError(`unknown external effect: ${e}`);
  const criteria = strArray(r.acceptanceCriteria, "acceptanceCriteria");
  if (criteria.length === 0) throw new ContractError("acceptanceCriteria needs at least one entry");
  const c: TaskContract = {
    taskId: r.taskId,
    objective: r.objective,
    mode: r.mode as TaskMode,
    policyRevision: r.policyRevision as number,
    readRoots: strArray(r.readRoots, "readRoots"),
    writeRoots: strArray(r.writeRoots, "writeRoots"),
    allowedHosts: strArray(r.allowedHosts, "allowedHosts"),
    externalEffects: effects as ExternalEffect[],
    acceptanceCriteria: criteria,
  };
  for (const k of ["missionId", "parentTaskId", "workspace", "owner", "createdAt"] as const) {
    if (r[k] !== undefined) {
      if (!isStr(r[k])) throw new ContractError(`${k} must be a string`);
      c[k] = r[k] as string;
    }
  }
  for (const k of [
    "scratchRoots",
    "protectedPaths",
    "allowedTools",
    "allowedCommands",
    "approvedAmendmentIds",
  ] as const) {
    if (r[k] !== undefined) c[k] = strArray(r[k], k);
  }
  if ((c.mode === "investigation" || c.mode === "review") && c.externalEffects.some((e) => e !== "remote_read"))
    throw new ContractError(
      `${c.mode} contracts may only allow remote_read; change the mode through an approved amendment instead`,
    );
  if ((c.mode === "investigation" || c.mode === "review") && c.writeRoots.length > 0)
    throw new ContractError(`${c.mode} contracts cannot have writeRoots; use scratchRoots for diagnostics`);
  return c;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable content hash; bound into approvals, handoffs and audit records. */
export function contractHash(c: TaskContract): string {
  const normalized = {
    ...c,
    readRoots: [...c.readRoots].sort(),
    writeRoots: [...c.writeRoots].sort(),
    allowedHosts: [...c.allowedHosts].sort(),
    externalEffects: [...c.externalEffects].sort(),
  };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

const MODE_RANK: Record<TaskMode, number> = { investigation: 0, review: 0, implementation: 1, deployment: 2 };

export type ChildRequest = Partial<
  Pick<
    TaskContract,
    | "objective"
    | "mode"
    | "readRoots"
    | "writeRoots"
    | "scratchRoots"
    | "allowedHosts"
    | "externalEffects"
    | "allowedTools"
    | "allowedCommands"
    | "acceptanceCriteria"
  >
> & {
  taskId: string;
};

/** Child contract = intersection with the parent. Any attempt to widen throws. */
export function narrowContract(
  parent: TaskContract,
  req: ChildRequest,
  within: (child: string, roots: string[]) => boolean,
): TaskContract {
  const mode = req.mode ?? parent.mode;
  if (MODE_RANK[mode] > MODE_RANK[parent.mode])
    throw new ContractError(`child mode ${mode} would widen parent mode ${parent.mode}`);
  const subset = (name: string, child: string[] | undefined, par: string[], inRoots: boolean) => {
    if (child === undefined) return [...par];
    for (const x of child) {
      const ok = inRoots ? within(x, par) : par.includes(x);
      if (!ok) throw new ContractError(`child ${name} ${JSON.stringify(x)} is not covered by the parent contract`);
    }
    return [...child];
  };
  const effects = req.externalEffects ?? parent.externalEffects;
  for (const e of effects)
    if (!parent.externalEffects.includes(e)) throw new ContractError(`child external effect ${e} would widen parent`);
  const tools = req.allowedTools === undefined ? parent.allowedTools : req.allowedTools;
  if (req.allowedTools !== undefined && parent.allowedTools !== undefined) {
    for (const t of req.allowedTools)
      if (!parent.allowedTools.includes(t)) throw new ContractError(`child tool ${t} would widen parent`);
  }
  if (req.allowedTools !== undefined && parent.allowedTools === undefined)
    throw new ContractError("parent contract has no tool allowlist to narrow");
  const cmds = req.allowedCommands ?? parent.allowedCommands;
  for (const c of req.allowedCommands ?? [])
    if (!(parent.allowedCommands ?? []).includes(c)) throw new ContractError(`child command ${c} would widen parent`);
  const child: TaskContract = {
    ...parent,
    taskId: req.taskId,
    parentTaskId: parent.taskId,
    objective: req.objective ?? parent.objective,
    mode,
    policyRevision: parent.policyRevision,
    readRoots: subset("readRoot", req.readRoots, parent.readRoots, true),
    writeRoots: subset("writeRoot", req.writeRoots, parent.writeRoots, true),
    scratchRoots: subset("scratchRoot", req.scratchRoots, parent.scratchRoots ?? [], true),
    allowedHosts: subset("host", req.allowedHosts, parent.allowedHosts, false),
    externalEffects: effects,
    acceptanceCriteria: req.acceptanceCriteria ?? parent.acceptanceCriteria,
    approvedAmendmentIds: [...(parent.approvedAmendmentIds ?? [])],
  };
  if (tools !== undefined) child.allowedTools = [...tools];
  if (cmds !== undefined) child.allowedCommands = [...cmds];
  return child;
}
