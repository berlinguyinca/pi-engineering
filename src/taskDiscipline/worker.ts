/**
 * Worker scope narrowing (issue #563, slice 1).
 *
 * A mission worker is a second agent running in the same process. Before this
 * module a worker session carried no Task Contract at all: `roleResourceLoader`
 * handed `createAgentSession` an empty extension list, so the parent's gate did
 * not apply to it and a worker's blast radius was whatever its tool allowlist
 * allowed. Here a worker gets its OWN contract, derived from the parent's with
 * `narrowContract` (so it can only ever be a subset), materialized in
 * host-owned state the agent cannot write, and the gate is loaded into the
 * worker session as an inline extension.
 *
 * Rules, ordered by what they cost an attacker who owns a worker:
 *   - external effects: always `[]`. A worker proposes; the host executes.
 *   - allowed hosts: `[]` unless the parent grants the `remote_read` effect.
 *   - mode: never above the parent's; a non-mutating role caps at `review`.
 *   - write roots: the worker's own allocated worktree, and only when the
 *     parent's write roots already cover it — otherwise the worker is REFUSED.
 *     Quietly inheriting the parent's broader write roots is exactly the
 *     widening this closes, so there is no fallback that widens.
 *
 * The derived contract is data the agent may read but never edit: it lives
 * under the state root, and `FileContractProvider` protects the file itself
 * plus the parent contract and decision log passed to it.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type LoadExtensionsResult,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import { FileContractProvider, disciplineFromEnv } from "./config.ts";
import { CONTRACT_FIELDS, type TaskContract, type TaskMode, narrowContract, parseContract } from "./contract.ts";
import { type DisciplineOptions, registerTaskDiscipline } from "./hook.ts";
import { isWithin, resolvePath } from "./pathScope.ts";

/** A worker whose request cannot be expressed inside the parent contract. */
export class WorkerScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerScopeError";
  }
}

export interface WorkerScopeRequest {
  /** Stable identifier for the worker (mission/role/attempt) — becomes the child taskId. */
  taskId: string;
  /** Mission role, for the refusal message when a mutating role has no parent permission. */
  role: string;
  /** The worker's allocated worktree: the only place it may write. */
  cwd: string;
  /** Whether the role may mutate the repository (MUTATING_ROLES). */
  mutating: boolean;
  objective?: string;
}

const RANK: Record<TaskMode, number> = { investigation: 0, review: 0, implementation: 1, deployment: 2 };

/**
 * Stable child taskId: the same worker request derives the same id (so a retried
 * attempt reuses its contract file) while two different tasks never collide.
 */
export function workerTaskId(req: { role: string; task: string }): string {
  const key = createHash("sha256").update(`${req.role}\0${req.task}`).digest("hex").slice(0, 12);
  return `worker:${req.role}:${key}`;
}

const covered = (path: string, roots: readonly string[]) => {
  const p = resolvePath(path, process.cwd());
  if (!p.ok) return false;
  return roots.some((root) => {
    const r = resolvePath(root, process.cwd());
    return r.ok && isWithin(p.path, r.path);
  });
};

/**
 * The child contract for one worker. Anything that could widen the parent is
 * either dropped here (effects, hosts) or rejected by `narrowContract` (roots,
 * mode, tool/command allowlists), and the result is re-parsed so a derived
 * contract satisfies the same invariants an operator-written one must.
 */
export function childContractForWorker(parent: TaskContract, req: WorkerScopeRequest): TaskContract {
  const here = resolvePath(req.cwd, process.cwd());
  if (!here.ok)
    throw new WorkerScopeError(`worker worktree ${JSON.stringify(req.cwd)} cannot be resolved: ${here.reason}`);
  const worktree = here.path;
  const mode: TaskMode = req.mutating ? parent.mode : RANK[parent.mode] > RANK.review ? "review" : parent.mode;
  // A role that intends to write cannot run under a parent that never granted
  // writes. Silently demoting it to a write-less reviewer would hand it write
  // tools its contract then denies, so the mismatch is refused here, where the
  // operator sees one clear reason instead of a stream of blocked tool calls.
  if (req.mutating && mode !== "implementation" && mode !== "deployment")
    throw new WorkerScopeError(
      `role ${JSON.stringify(req.role)} intends to write but the parent contract is ${parent.mode}; the operator must widen the parent, or dispatch a read-only role`,
    );
  const writes = mode === "implementation" || mode === "deployment" ? [worktree] : [];
  if (writes.length > 0 && !covered(worktree, parent.writeRoots))
    throw new WorkerScopeError(
      `worker worktree ${worktree} is not inside the parent contract's write roots ` +
        `(${parent.writeRoots.join(", ") || "none"}); refusing to start it with the parent's broader scope`,
    );
  // A worker never performs external effects; it may only read a host the
  // parent itself was allowed to read.
  const hosts = parent.externalEffects.includes("remote_read") ? parent.allowedHosts : [];
  const child = narrowContract(
    parent,
    {
      taskId: req.taskId,
      ...(req.objective ? { objective: req.objective } : {}),
      mode,
      readRoots: parent.readRoots,
      writeRoots: writes,
      allowedHosts: hosts,
      externalEffects: [],
    },
    covered,
  );
  // Re-parse so a derived contract carries no smuggled key and satisfies the
  // same invariants (mode vs write roots, required fields) an operator's does.
  return parseContract({ ...child }) as TaskContract;
}

/** Host-owned location of a worker's contract: <stateRoot>/task-discipline/<worktree hash>/. */
export function workerContractFile(stateRoot: string, cwd: string, taskId: string): string {
  const key = createHash("sha256").update(`${cwd}\0${taskId}`).digest("hex").slice(0, 16);
  return join(stateRoot, "task-discipline", key, "task-contract.json");
}

/** Write the derived contract where only the host can change it. */
export function materializeWorkerContract(child: TaskContract, file: string): string {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const published: Record<string, unknown> = {};
  for (const field of CONTRACT_FIELDS) if (child[field] !== undefined) published[field] = child[field];
  writeFileSync(file, `${JSON.stringify(published, null, 2)}\n`, { mode: 0o400 });
  return file;
}

/**
 * The worker session's extension set: the gate, bound to the worker's own
 * contract file. Loaded through the supported inline-factory path so the worker
 * still gets no user extensions, skills, prompts, themes or context files.
 */
export async function workerGateExtensions(
  file: string,
  opts: Pick<DisciplineOptions, "mode" | "record">,
  protectedFiles: string[],
  cwd: string,
  agentDir: string,
): Promise<LoadExtensionsResult> {
  const factory: ExtensionFactory = (pi: ExtensionAPI) => {
    registerTaskDiscipline(pi as never, {
      mode: opts.mode,
      provider: new FileContractProvider(file, protectedFiles),
      ...(opts.record ? { record: opts.record } : {}),
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  return loader.getExtensions();
}

/**
 * Everything a worker session needs to run gated: the derived contract, its
 * file, and the extension set. Returns undefined only when the parent session
 * has no gate (the default), which leaves worker behaviour exactly as it was.
 * Throws `WorkerScopeError` when the worker cannot be narrowed — an ungated or
 * parent-scoped worker is not an acceptable fallback in an enforcing parent.
 */
export async function workerSessionGate(
  req: WorkerScopeRequest,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ child: TaskContract; file: string; extensions: LoadExtensionsResult } | undefined> {
  const opts = disciplineFromEnv(env);
  if (!opts || opts.mode === "off") return undefined;
  const parent = opts.provider.current();
  if (!parent) return undefined;
  const child = childContractForWorker(parent, req); // refuses rather than widens
  const file = workerContractFile(resolveStateRoot(env), req.cwd, req.taskId);
  materializeWorkerContract(child, file);
  const protectedFiles = [env.PI_TASK_CONTRACT_FILE, env.PI_TASK_DISCIPLINE_LOG].filter((p): p is string => !!p);
  const extensions = await workerGateExtensions(file, opts, protectedFiles, req.cwd, agentDir);
  if (extensions.errors.length > 0)
    throw new WorkerScopeError(
      `worker gate extension failed to load: ${extensions.errors[0]?.error ?? "unknown error"}`,
    );
  return { child, file, extensions };
}
